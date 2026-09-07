import { subDays } from "date-fns";

import type { FulfillmentMode, Money, StoreCapabilities, StorePlatform } from "../../shared/contracts";
import type { OzonClient } from "../ozon/client";
import { normalizePosting, type NormalizedPosting } from "../ozon/normalize";
import type { WildberriesClient } from "../wildberries/client";
import { normalizeWildberriesOrders, normalizeWildberriesSales, type WildberriesOrder, type WildberriesSale } from "../wildberries/normalize";

export interface MarketplaceStoreConnection {
  id: string;
  platform: StorePlatform;
  credential: string;
  clientId?: string;
  fulfillmentModes?: FulfillmentMode[];
}

export interface SyncWindow {
  from: Date;
  to: Date;
  cursor?: string;
}

export interface SyncPage<T> {
  items: T[];
  nextCursor: string | null;
  hasNext: boolean;
}

export interface SalesPage<T> {
  items: T[];
  nextCursor: string | null;
  hasNext: boolean;
}

export interface MarketplaceBalance {
  primary: Money | null;
  openingBalance: Money | null;
  closingBalance: Money | null;
  accrued: Money | null;
  payments: Money[];
}

export interface MarketplaceCredentialTestResult {
  expiresAt: string | null;
  externalStoreId: string | null;
  roles: Array<{ name: string | null; methods: string[] }>;
}

export interface MarketplaceAdapter<TOrder = unknown, TSale = unknown> {
  readonly platform: StorePlatform;
  testConnection(store: MarketplaceStoreConnection): Promise<MarketplaceCredentialTestResult>;
  syncOrders(input: SyncWindow): Promise<SyncPage<TOrder>>;
  syncSales(input: SyncWindow): Promise<SalesPage<TSale>>;
  getBalance(): Promise<MarketplaceBalance>;
  getCapabilities(): StoreCapabilities;
}

const ozonCapabilities: StoreCapabilities = {
  orders: true,
  sales: true,
  balance: true,
  notifications: true,
  inventory: true,
  writeOperations: true,
};

const wildberriesCapabilities: StoreCapabilities = {
  orders: true,
  sales: true,
  balance: true,
  notifications: true,
  inventory: false,
  writeOperations: false,
};

function sourcesForModes(modes: FulfillmentMode[]): Array<"FBO" | "FBS"> {
  const sources: Array<"FBO" | "FBS"> = [];
  if (modes.includes("FBO")) sources.push("FBO");
  if (modes.includes("FBS") || modes.includes("RFBS")) sources.push("FBS");
  return sources;
}

export class OzonAdapter implements MarketplaceAdapter<NormalizedPosting, never> {
  public readonly platform = "ozon" as const;

  public constructor(
    private readonly client: OzonClient,
    private readonly fulfillmentModes: FulfillmentMode[],
  ) {}

  public async testConnection(_store: MarketplaceStoreConnection): Promise<MarketplaceCredentialTestResult> {
    const roles = await this.client.getRoles();
    const grantedMethods = roles.roles.flatMap((role) => role.methods);
    const requiredMethods = sourcesForModes(this.fulfillmentModes).map((source) =>
      source === "FBO" ? "/v3/posting/fbo/list" : "/v4/posting/fbs/list",
    );
    const missing = requiredMethods.filter(
      (requiredMethod) => !grantedMethods.some((grantedMethod) => grantedMethod.includes(requiredMethod)),
    );
    if (missing.length > 0) {
      throw new Error(`API key is missing access to: ${missing.join(", ")}`);
    }
    return {
      expiresAt: roles.expires_at ?? null,
      externalStoreId: null,
      roles: roles.roles.map((role) => ({ name: role.name ?? null, methods: role.methods })),
    };
  }

  public async syncOrders(input: SyncWindow): Promise<SyncPage<NormalizedPosting>> {
    const postings: NormalizedPosting[] = [];
    for (const source of sourcesForModes(this.fulfillmentModes)) {
      for await (const page of this.client.iteratePostingPages(source, input.from, input.to, input.cursor)) {
        postings.push(...page.postings.map((posting) => normalizePosting(posting, source)));
      }
    }
    return { items: postings, nextCursor: null, hasNext: false };
  }

  public async syncSales(_input: SyncWindow): Promise<SalesPage<never>> {
    return { items: [], nextCursor: null, hasNext: false };
  }

  public async getBalance(): Promise<MarketplaceBalance> {
    const closing = await this.client.getFinanceBalance(subDays(new Date(), 30), new Date());
    const toMoney = (value: { value: string | null; currencyCode: string | null } | null): Money | null =>
      value?.value && value.currencyCode ? { amount: value.value, currency: value.currencyCode } : null;
    const closingBalance = toMoney(closing.closingBalance);
    return {
      primary: closingBalance,
      openingBalance: toMoney(closing.openingBalance),
      closingBalance,
      accrued: toMoney(closing.accrued),
      payments: closing.payments.map(toMoney).filter((value): value is Money => value !== null),
    };
  }

  public getCapabilities(): StoreCapabilities {
    return ozonCapabilities;
  }
}

export class WildberriesAdapter implements MarketplaceAdapter<WildberriesOrder, WildberriesSale> {
  public readonly platform = "wildberries" as const;

  public constructor(private readonly client: WildberriesClient) {}

  public async testConnection(_store: MarketplaceStoreConnection): Promise<MarketplaceCredentialTestResult> {
    await Promise.all([
      this.client.getOrders(subDays(new Date(), 1), new Date()),
      this.client.getBalance(),
    ]);
    return {
      expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
      externalStoreId: null,
      roles: [],
    };
  }

  public async syncOrders(input: SyncWindow): Promise<SyncPage<WildberriesOrder>> {
    return { items: normalizeWildberriesOrders(await this.client.getOrders(input.from, input.to)), nextCursor: null, hasNext: false };
  }

  public async syncSales(input: SyncWindow): Promise<SalesPage<WildberriesSale>> {
    return { items: normalizeWildberriesSales(await this.client.getSales(input.from, input.to)), nextCursor: null, hasNext: false };
  }

  public async getBalance(): Promise<MarketplaceBalance> {
    const value = await this.client.getBalance();
    const currency = value.currency?.trim().toUpperCase() || "RUB";
    const primary = value.current ? { amount: value.current, currency } : null;
    return {
      primary,
      openingBalance: null,
      closingBalance: primary,
      accrued: null,
      payments: value.for_withdraw ? [{ amount: value.for_withdraw, currency }] : [],
    };
  }

  public getCapabilities(): StoreCapabilities {
    return wildberriesCapabilities;
  }
}
