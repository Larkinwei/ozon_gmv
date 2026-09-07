import { setTimeout as wait } from "node:timers/promises";

import { subDays, subHours } from "date-fns";

import type { FulfillmentMode, StoreView } from "../../shared/contracts";
import type { AppConfig } from "../config";
import { MarketplaceRepository } from "../db/marketplace-repository";
import { MarketplaceSyncCheckpointsRepository } from "../db/marketplace-sync-checkpoints-repository";
import { PostingsRepository, type PostingMutationKind } from "../db/postings-repository";
import { StoresRepository, toStoreView, type StoreRecord } from "../db/stores-repository";
import { SyncCheckpointsRepository, type SyncSource } from "../db/sync-checkpoints-repository";
import { splitIntoSyncWindows } from "../domain/time-range";
import { decryptSecret } from "../security/encryption";
import { DashboardEventBus } from "../realtime/event-bus";
import { OzonClient } from "../ozon/client";
import { normalizePosting, type NormalizedPosting } from "../ozon/normalize";
import { OzonAdapter, WildberriesAdapter } from "../marketplaces/adapter";
import { WildberriesClient } from "../wildberries/client";
import type { ProxySettingsService } from "./proxy-settings-service";
import type { ProductImageService } from "./product-image-service";

export interface CredentialTestResult {
  expiresAt: string | null;
  roles: Array<{ name: string | null; methods: string[] }>;
}

export type WildberriesSyncSource = "orders" | "sales";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown synchronization error";
}

function sourcesForModes(modes: FulfillmentMode[]): Array<"FBO" | "FBS"> {
  const sources: Array<"FBO" | "FBS"> = [];
  if (modes.includes("FBO")) {
    sources.push("FBO");
  }
  if (modes.includes("FBS") || modes.includes("RFBS")) {
    sources.push("FBS");
  }
  return sources;
}

function postingAllowed(store: StoreRecord, posting: NormalizedPosting): boolean {
  return store.fulfillmentModes.includes(posting.fulfillmentMode);
}

export class SyncService {
  private readonly activeSyncs = new Set<string>();

  public constructor(
    private readonly config: AppConfig,
    private readonly stores: StoresRepository,
    private readonly postings: PostingsRepository,
    private readonly checkpoints: SyncCheckpointsRepository,
    private readonly events: DashboardEventBus,
    private readonly proxySettings: ProxySettingsService,
    private readonly productImages: ProductImageService,
    private readonly marketplace?: MarketplaceRepository,
    private readonly marketplaceCheckpoints?: MarketplaceSyncCheckpointsRepository,
  ) {}

  public async testCredentials(clientId: string, apiKey: string, modes: FulfillmentMode[]): Promise<CredentialTestResult> {
    const result = await new OzonAdapter(this.createClient(clientId, apiKey), modes).testConnection({
      id: clientId,
      platform: "ozon",
      credential: apiKey,
      clientId,
      fulfillmentModes: modes,
    });
    return { expiresAt: result.expiresAt, roles: result.roles };
  }

  public async testWildberriesCredentials(apiToken: string): Promise<{ expiresAt: string | null; externalStoreId: string | null }> {
    const result = await this.createWildberriesAdapter(apiToken).testConnection({
      id: "",
      platform: "wildberries",
      credential: apiToken,
    });
    return { expiresAt: result.expiresAt, externalStoreId: result.externalStoreId };
  }

  public async backfillStore(storeId: string): Promise<void> {
    const now = new Date();
    await this.syncStore(storeId, subDays(now, 90), now);
  }

  public async syncStore(
    storeId: string,
    since = subHours(new Date(), 24),
    to = new Date(),
    modes?: FulfillmentMode[],
    wildberriesSources?: WildberriesSyncSource[],
  ): Promise<void> {
    if (this.activeSyncs.has(storeId)) {
      return;
    }
    const store = await this.stores.findById(storeId);
    if (!store || !store.enabled) {
      return;
    }

    this.activeSyncs.add(storeId);
    await this.stores.markSyncStarted(storeId);
    this.events.publish("sync.status", { storeId, state: "syncing" });
    try {
      if (store.platform === "wildberries") {
        await this.syncWildberriesStore(store, since, to, wildberriesSources);
        await this.stores.markSyncFinished(storeId);
        this.events.publish("sync.status", { storeId, state: "healthy" });
        return;
      }
      const selectedModes = modes ?? store.fulfillmentModes;
      const client = this.createClient(store.clientId, decryptSecret(store.apiKeyCiphertext, this.config.ENCRYPTION_KEY));
      const sources = sourcesForModes(selectedModes);
      for (const source of sources) {
        await this.resumeInterruptedWindow(store, client, source);
      }
      for (const window of splitIntoSyncWindows(since, to)) {
        for (const source of sources) {
          await this.syncSourceWindow(store, client, source, window.from, window.to);
        }
      }
      await this.stores.markSyncFinished(storeId);
      this.events.publish("sync.status", { storeId, state: "healthy" });
      void this.productImages.refreshStore(store.id, client).catch(() => undefined);
    } catch (error) {
      const message = errorMessage(error);
      await this.stores.markSyncFailed(storeId, message);
      this.events.publish("sync.status", { storeId, state: "error", message });
      throw error;
    } finally {
      this.activeSyncs.delete(storeId);
    }
  }

  public async syncActiveStores(
    since: Date,
    to: Date,
    modes?: FulfillmentMode[],
    staggerMaxMs = 0,
    platform?: "ozon" | "wildberries",
    wildberriesSources?: WildberriesSyncSource[],
  ): Promise<void> {
    const stores = (await this.stores.listActive()).filter((store) => !platform || store.platform === platform);
    await Promise.allSettled(stores.map(async (store) => {
      if (staggerMaxMs > 0) {
        await wait(Math.floor(Math.random() * staggerMaxMs));
      }
      await this.syncStore(store.id, since, to, modes, wildberriesSources);
    }));
  }

  public async getStoreView(storeId: string): Promise<StoreView | null> {
    const store = await this.stores.findById(storeId);
    return store ? toStoreView(store) : null;
  }

  private async persistPosting(store: StoreRecord, posting: NormalizedPosting): Promise<PostingMutationKind> {
    const mutation = await this.postings.upsert(store.id, posting);
    if (mutation.kind !== "unchanged") {
      const eventType = mutation.kind === "created" ? "posting.created" : "posting.updated";
      this.events.publish(eventType, {
        id: mutation.id,
        postingNumber: posting.postingNumber,
        storeId: store.id,
        storeName: store.name,
        amount: { amount: posting.grossAmount, currency: posting.currency },
        orderAt: posting.orderAt.toISOString(),
        fulfillment: posting.fulfillmentMode,
        status: posting.status,
        storeColor: store.color,
        productNames: posting.items.map((item) => item.name),
        productSkus: posting.items.map((item) => item.sku),
        itemCount: posting.items.reduce((total, item) => total + item.quantity, 0),
      });
    }
    return mutation.kind;
  }

  private async resumeInterruptedWindow(store: StoreRecord, client: OzonClient, source: SyncSource): Promise<void> {
    const checkpoint = await this.checkpoints.find(store.id, source);
    if (!checkpoint?.cursor || !checkpoint.windowFrom || !checkpoint.windowTo) {
      return;
    }
    await this.syncSourceWindow(
      store,
      client,
      source,
      checkpoint.windowFrom,
      checkpoint.windowTo,
      checkpoint.cursor,
    );
  }

  private async syncSourceWindow(
    store: StoreRecord,
    client: OzonClient,
    source: SyncSource,
    from: Date,
    to: Date,
    cursor?: string,
  ): Promise<void> {
    for await (const page of client.iteratePostingPages(source, from, to, cursor)) {
      for (const rawPosting of page.postings) {
        const posting = normalizePosting(rawPosting, source);
        if (postingAllowed(store, posting)) {
          await this.persistPosting(store, posting);
        }
      }
      await this.checkpoints.save(
        store.id,
        source,
        from,
        to,
        page.hasNext ? page.nextCursor : null,
      );
    }
  }

  private createClient(clientId: string, apiKey: string): OzonClient {
    return new OzonClient({
      clientId,
      apiKey,
      baseUrl: this.config.OZON_API_BASE_URL,
      fetchImplementation: this.proxySettings.createFetch(),
    });
  }

  private createWildberriesAdapter(apiToken: string): WildberriesAdapter {
    return new WildberriesAdapter(new WildberriesClient({
      apiToken,
      fetchImplementation: this.proxySettings.createFetch(),
      directFetchImplementation: fetch,
    }));
  }

  private async syncWildberriesStore(
    store: StoreRecord,
    since: Date,
    to: Date,
    sources: WildberriesSyncSource[] = ["orders", "sales"],
  ): Promise<void> {
    if (!this.marketplace || !this.marketplaceCheckpoints) {
      throw new Error("Wildberries synchronization is not configured");
    }
    const adapter = this.createWildberriesAdapter(decryptSecret(store.apiKeyCiphertext, this.config.ENCRYPTION_KEY));
    const suppressNotifications = to.getTime() - since.getTime() > 3 * 60 * 60 * 1000;
    if (sources.includes("orders")) {
      const orderPage = await adapter.syncOrders({ from: since, to });
      for (const order of orderPage.items) {
        const mutation = await this.marketplace.upsertOrder(store.id, order);
        const orderIsInsideWindow = order.orderAt.getTime() >= since.getTime() && order.orderAt.getTime() <= to.getTime();
        if (mutation.kind === "created" && !suppressNotifications && orderIsInsideWindow) {
          this.events.publish("posting.created", {
            id: mutation.id,
            platform: "wildberries",
            externalOrderId: order.externalOrderId,
            storeId: store.id,
            storeName: store.name,
            storeColor: store.color,
            amount: { amount: order.grossAmount, currency: order.currency },
            orderAt: order.orderAt.toISOString(),
            fulfillment: order.fulfillmentMode,
            status: order.status,
            productNames: order.items.map((item) => item.name),
            productSkus: order.items.map((item) => item.sku),
            itemCount: order.items.reduce((total, item) => total + item.quantity, 0),
          });
        }
      }
      this.marketplaceCheckpoints.save(store.id, "orders", since, to);
    }

    if (sources.includes("sales")) {
      const salesPage = await adapter.syncSales({ from: since, to });
      for (const sale of salesPage.items) {
        await this.marketplace.upsertSale(store.id, sale);
      }
      this.marketplaceCheckpoints.save(store.id, "sales", since, to);
    }
  }
}
