import type { AppConfig } from "../config";
import { InventoryRepository, type InventoryCandidate, type InventoryStockRow } from "../db/inventory-repository";
import type { DashboardEventBus } from "../realtime/event-bus";
import { decryptSecret } from "../security/encryption";
import type { ProxySettingsService } from "./proxy-settings-service";
import { OzonClient, type OzonProductStock } from "../ozon/client";
import type { StoresRepository, StoreRecord } from "../db/stores-repository";

export const LOW_STOCK_THRESHOLD = 30;

function matches(candidate: InventoryCandidate, item: OzonProductStock): boolean {
  return Boolean(
    (item.offerId && item.offerId === candidate.offerId)
    || (item.sku && item.sku === candidate.sku),
  );
}

function stockRows(items: OzonProductStock[], candidate: InventoryCandidate, warehouseNames: Map<string, string>): InventoryStockRow[] {
  return items.flatMap((item) => {
    if (!matches(candidate, item) || item.stock === null || !item.warehouseId) return [];
    return [{
      warehouseId: item.warehouseId,
      warehouseName: warehouseNames.get(item.warehouseId) ?? null,
      productId: item.productId,
      availableStock: Math.max(0, Math.trunc(item.stock)),
      reservedStock: Math.max(0, Math.trunc(item.reserved ?? 0)),
    }];
  });
}

export class InventoryMonitorService {
  private readonly activeStores = new Set<string>();

  public constructor(
    private readonly config: AppConfig,
    private readonly stores: StoresRepository,
    private readonly inventory: InventoryRepository,
    private readonly events: DashboardEventBus,
    private readonly proxySettings: ProxySettingsService,
  ) {}

  public async syncActiveStores(): Promise<void> {
    const stores = (await this.stores.listActive()).filter((store) => store.platform === "ozon" && store.inventoryMonitorEnabled);
    await Promise.allSettled(stores.map((store) => this.syncStore(store)));
  }

  public listOpenAlerts() {
    return this.inventory.listOpenAlerts();
  }

  public acknowledge(ids: string[]): void {
    this.inventory.acknowledge(ids);
  }

  public snoozeSku(storeId: string, sku: string): void {
    this.inventory.snoozeSku(storeId, sku);
  }

  private async syncStore(store: StoreRecord): Promise<void> {
    if (this.activeStores.has(store.id)) return;
    this.activeStores.add(store.id);
    try {
      const candidates = this.inventory.listCandidates(store.id);
      if (candidates.length === 0) return;
      const client = new OzonClient({
        clientId: store.clientId,
        apiKey: decryptSecret(store.apiKeyCiphertext, this.config.ENCRYPTION_KEY),
        baseUrl: this.config.OZON_API_BASE_URL,
        fetchImplementation: this.proxySettings.createFetch(),
      });
      const checkedAt = Date.now();
      const fboCandidates = candidates.filter((candidate) => candidate.fulfillment === "FBO");
      if (fboCandidates.length > 0) {
        const items = await client.getFboStockByOffers([...new Set(fboCandidates.map((candidate) => candidate.offerId).filter(Boolean))]);
        for (const candidate of fboCandidates) {
          this.applyCandidate(store, candidate, stockRows(items, candidate, new Map()), checkedAt);
        }
      }

      const fbsCandidates = candidates.filter((candidate) => candidate.fulfillment === "FBS" || candidate.fulfillment === "RFBS");
      if (fbsCandidates.length > 0) {
        const warehouses = await client.getWarehouses();
        const warehouseNames = new Map(warehouses.map((warehouse) => [warehouse.id, warehouse.name]));
        const results = await Promise.allSettled(warehouses.map((warehouse) => client.getFbsStocksByWarehouse(warehouse.id)));
        const items = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
        for (const candidate of fbsCandidates) {
          this.applyCandidate(store, candidate, stockRows(items, candidate, warehouseNames), checkedAt);
        }
      }
    } finally {
      this.activeStores.delete(store.id);
    }
  }

  private applyCandidate(store: StoreRecord, candidate: InventoryCandidate, rows: InventoryStockRow[], checkedAt: number): void {
    if (rows.length === 0) return;
    this.inventory.replaceSnapshots(store.id, candidate, checkedAt, rows);
    const evaluation = this.inventory.evaluate(store.id, candidate, checkedAt, LOW_STOCK_THRESHOLD);
    if (evaluation.newlyOpened && evaluation.alert) {
      this.events.publish("inventory.low", evaluation.alert);
    }
  }
}

export interface InventoryMonitorHandle {
  stop: () => void;
}

export function startInventoryMonitor(service: InventoryMonitorService): InventoryMonitorHandle {
  const timer = setInterval(() => {
    void service.syncActiveStores().catch(() => undefined);
  }, 10 * 60_000);
  timer.unref();
  void service.syncActiveStores().catch(() => undefined);
  return { stop: () => clearInterval(timer) };
}
