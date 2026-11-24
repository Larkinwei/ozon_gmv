import { setTimeout as wait } from "node:timers/promises";

import { subDays, subHours } from "date-fns";

import type { FulfillmentMode, StoreView } from "../../shared/contracts";
import type { AppConfig } from "../config";
import type { AppDatabase } from "../db/database";
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

/** Splits a history range into short adjacent windows accepted by Seller API period limits. */
function* dateWindows(from: Date, to: Date, windowDays = 30): Generator<[Date, Date]> {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  let start = from.getTime();
  const end = to.getTime();
  while (start < end) {
    const next = Math.min(start + windowMs, end);
    yield [new Date(start), new Date(next)];
    start = next;
  }
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
  private readonly activeBuyerHistorySyncs = new Set<string>();

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
    private readonly database?: AppDatabase,
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

  /** Packs one live FBS posting into a single parcel and persists Ozon's confirmed status. */
  public async markPostingPrepared(storeId: string, postingNumber: string): Promise<{ status: string }> {
    const store = await this.stores.findById(storeId);
    if (!store || !store.enabled || store.platform !== "ozon" || !store.fulfillmentModes.some((mode) => mode === "FBS" || mode === "RFBS")) throw new Error("店铺未启用 FBS/rFBS 订单操作");
    const client = this.createClient(store.clientId, decryptSecret(store.apiKeyCiphertext, this.config.ENCRYPTION_KEY));
    const posting = await client.getFbsPosting(postingNumber);
    if (posting.status !== "awaiting_packaging") throw new Error(`发货单当前状态为 ${posting.status}，不能执行备货`);
    if (posting.products.length !== 1) throw new Error("Ozon实时订单包含多个SKU，请到Ozon后台人工备货");
    if (posting.products[0]?.quantity !== 1) throw new Error("Ozon实时订单商品数量不是1件，请到Ozon后台人工备货");
    const products = posting.products.map((product) => ({ productId: product.product_id === undefined ? "" : String(product.product_id), quantity: product.quantity }));
    if (products.some((product) => !product.productId || !Number.isInteger(product.quantity) || product.quantity < 1)) throw new Error("Ozon订单商品缺少有效SKU或数量，无法自动备货");
    let shipError: unknown;
    try { await client.shipFbsPosting(postingNumber, products); }
    catch (error) { shipError = error; }
    let confirmed;
    try { confirmed = await client.getFbsPosting(postingNumber); }
    catch { throw new Error(shipError ? `备货请求结果待核实：${errorMessage(shipError)}` : "备货请求已发送，但无法回查Ozon状态，请人工核对后再操作"); }
    if (shipError && confirmed.status === "awaiting_packaging") throw shipError;
    if (confirmed.status !== "awaiting_deliver" && !["delivering", "delivered", "driver_pickup", "sent_by_seller"].includes(confirmed.status)) throw new Error(`Ozon已接收备货请求，但回查状态为 ${confirmed.status}，需要人工核对`);
    await this.postings.upsert(storeId, normalizePosting(confirmed, "FBS"));
    return { status: confirmed.status };
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
    onWindowComplete?: () => void,
  ): Promise<void> {
    if (this.activeSyncs.has(storeId)) {
      return;
    }
    const store = await this.stores.findById(storeId);
    if (!store || !store.enabled) {
      return;
    }

    const syncStartedAt = Date.now();
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
        onWindowComplete?.();
      }
      const storeNeedsShipmentDeadlines = store.fulfillmentModes.some((mode) => mode === "FBS" || mode === "RFBS");
      const shipmentSourceWasSynced = sources.includes("FBS");
      const latestDeadlineWindowStart = syncStartedAt - 29 * 24 * 60 * 60 * 1000;
      if (
        since.getTime() <= latestDeadlineWindowStart
        && to.getTime() >= syncStartedAt - 5 * 60 * 1000
        && (!storeNeedsShipmentDeadlines || shipmentSourceWasSynced)
      ) {
        this.postings.markShipmentDeadlineBackfillComplete(storeId, to.getTime());
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

  /** Refreshes one year of posting and return history asynchronously for stock-prep risk hints. */
  public async syncStockPrepBuyerHistory(storeId: string): Promise<void> {
    const db = this.database;
    if (!db || this.activeBuyerHistorySyncs.has(storeId)) return;
    this.activeBuyerHistorySyncs.add(storeId);
    let syncStarted = false;
    try {
      const store = await this.stores.findById(storeId);
      if (!store || !store.enabled || store.platform !== "ozon") return;
      const now = Date.now();
      const previous = db.prepare("SELECT state,from_at_ms,to_at_ms,updated_at_ms FROM stock_prep_risk_sync WHERE store_id=?").get(storeId) as { state: string; from_at_ms: number; to_at_ms: number; updated_at_ms: number } | undefined;
      if (previous?.state === "complete" && now - previous.updated_at_ms < 24 * 60 * 60 * 1000) return;
      const since = previous?.state === "complete" ? new Date(Math.max(now - 365 * 24 * 60 * 60 * 1000, previous.to_at_ms - 7 * 24 * 60 * 60 * 1000)) : new Date(now - 365 * 24 * 60 * 60 * 1000);
      const to = new Date(now);
      db.prepare(`INSERT INTO stock_prep_risk_sync (store_id,state,from_at_ms,to_at_ms,processed_count,return_count,error,updated_at_ms)
        VALUES (?,'running',?,?,0,0,NULL,?) ON CONFLICT(store_id) DO UPDATE SET state='running',from_at_ms=excluded.from_at_ms,to_at_ms=excluded.to_at_ms,error=NULL,updated_at_ms=excluded.updated_at_ms`)
        .run(storeId, since.getTime(), to.getTime(), now);
      syncStarted = true;
      const client = this.createClient(store.clientId, decryptSecret(store.apiKeyCiphertext, this.config.ENCRYPTION_KEY));
      let processed = 0;
      for (const [windowStart, windowEnd] of dateWindows(since, to)) {
        for await (const page of client.iteratePostingPages("FBS", windowStart, windowEnd)) {
          for (const posting of page.postings) {
            const normalized = normalizePosting(posting, "FBS");
            await this.postings.upsert(storeId, normalized);
            processed += 1;
          }
          db.prepare("UPDATE stock_prep_risk_sync SET processed_count=?,updated_at_ms=? WHERE store_id=?").run(processed, Date.now(), storeId);
        }
      }
      let returnCount = 0;
      const upsertReturn = db.prepare(`INSERT INTO stock_prep_buyer_returns (store_id,return_id,posting_number,order_number,quantity,return_type,returned_at_ms,return_reason,visual_status)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(store_id,return_id) DO UPDATE SET posting_number=excluded.posting_number,order_number=excluded.order_number,quantity=excluded.quantity,return_type=excluded.return_type,returned_at_ms=excluded.returned_at_ms,return_reason=excluded.return_reason,visual_status=excluded.visual_status`);
      const returnDateFields: Array<"logistic_return_date" | "visual_status_change_moment"> = previous?.state === "complete"
        ? ["logistic_return_date", "visual_status_change_moment"]
        : ["logistic_return_date"];
      for (const dateField of returnDateFields) {
        for (const [windowStart, windowEnd] of dateWindows(since, to)) {
          for await (const page of client.iterateReturnPages(windowStart, windowEnd, dateField)) {
            const upsertPage = db.transaction(() => {
              for (const record of page.returns) {
                if (!record.posting_number) continue;
                const returnedAt = record.logistic?.return_date ?? record.logistic?.final_moment ?? null;
                upsertReturn.run(storeId, record.id, record.posting_number, record.order_number ?? null, record.product?.quantity ?? 0,
                  record.type ?? "unknown", returnedAt && Date.parse(returnedAt) ? Date.parse(returnedAt) : null,
                  record.return_reason_name ?? null, record.visual?.status?.display_name ?? record.visual?.status?.sys_name ?? null);
                returnCount += 1;
              }
            });
            upsertPage();
            db.prepare("UPDATE stock_prep_risk_sync SET return_count=?,updated_at_ms=? WHERE store_id=?").run(returnCount, Date.now(), storeId);
          }
        }
      }
      db.prepare("DELETE FROM stock_prep_buyer_returns WHERE store_id=? AND returned_at_ms<?").run(storeId, now - 365 * 24 * 60 * 60 * 1000);
      db.prepare("UPDATE stock_prep_risk_sync SET state='complete',processed_count=?,return_count=?,error=NULL,updated_at_ms=? WHERE store_id=?")
        .run(processed, returnCount, Date.now(), storeId);
    } catch (error) {
      if (syncStarted) db.prepare("UPDATE stock_prep_risk_sync SET state='failed',error=?,updated_at_ms=? WHERE store_id=?")
        .run(errorMessage(error).slice(0, 1000), Date.now(), storeId);
      throw error;
    } finally {
      this.activeBuyerHistorySyncs.delete(storeId);
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

  /** Creates a Wildberries client with direct network access, independent of Ozon proxy settings. */
  private createWildberriesAdapter(apiToken: string): WildberriesAdapter {
    return new WildberriesAdapter(new WildberriesClient({
      apiToken,
      fetchImplementation: fetch,
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
