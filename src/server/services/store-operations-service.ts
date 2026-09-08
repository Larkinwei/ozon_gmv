import { subDays } from "date-fns";

import type {
  BuyerQuestionView,
  Money,
  QuestionCountView,
  StoreBalanceView,
  StoreOperationsSnapshot,
  StoreOperationsState,
  StoreOperationsStatus,
  StoreOperationsStoreView,
  StoreQuestionsView,
  StorePlatform,
} from "../../shared/contracts";
import type { AppConfig } from "../config";
import { StoresRepository, type StoreRecord } from "../db/stores-repository";
import { decryptSecret } from "../security/encryption";
import { OzonApiError, OzonClient, type OzonFinanceAmount, type OzonQuestion, type OzonQuestionCount, type OzonQuestionList } from "../ozon/client";
import { WildberriesApiError, WildberriesClient } from "../wildberries/client";
import type { ProxySettingsService } from "./proxy-settings-service";

const QUESTION_PREVIEW_LIMIT = 5;
const CACHE_TTL_MS = 5 * 60_000;

export interface StoreOperationsClient {
  getFinanceBalance(dateFrom: Date, dateTo: Date): Promise<{
    openingBalance: OzonFinanceAmount | null;
    closingBalance: OzonFinanceAmount | null;
    accrued: OzonFinanceAmount | null;
    payments: OzonFinanceAmount[];
  }>;
  getQuestionCount(): Promise<OzonQuestionCount>;
  getQuestionList(limit?: number): Promise<OzonQuestionList>;
  getQuestionInfo(questionId: string): Promise<OzonQuestion>;
}

interface WildberriesOperationsClient {
  getBalance(): Promise<{ currency?: string | null | undefined; current?: string | null | undefined; for_withdraw?: string | null | undefined }>;
}

export interface StoreOperationsReader {
  getOverview(storeIds: string[], platform?: StorePlatform | "all"): Promise<StoreOperationsSnapshot>;
  getQuestionDetail(storeId: string, questionId: string): Promise<BuyerQuestionView | null>;
}

interface StoreOperationsServiceOptions {
  clientFactory?: (store: StoreRecord) => StoreOperationsClient | WildberriesOperationsClient;
  now?: () => Date;
  cacheTtlMs?: number;
}

interface CacheEntry {
  expiresAt: number;
  value: StoreOperationsStoreView;
}

function toMoney(value: OzonFinanceAmount | null): Money | null {
  if (!value?.value || !value.currencyCode) {
    return null;
  }
  return { amount: value.value, currency: value.currencyCode };
}

function toQuestionCount(value: OzonQuestionCount): QuestionCountView {
  return {
    all: value.all,
    new: value.new,
    processed: value.processed,
    unprocessed: value.unprocessed,
    viewed: value.viewed,
  };
}

function toBuyerQuestion(store: StoreRecord, question: OzonQuestion): BuyerQuestionView {
  return {
    id: question.id,
    storeId: store.id,
    storeName: store.name,
    storeColor: store.color,
    text: question.text,
    status: question.status,
    sku: question.sku,
    productName: question.productName,
    productUrl: question.productUrl,
    questionLink: question.questionLink,
    publishedAt: question.publishedAt,
    answersCount: question.answersCount,
  };
}

function isPermissionError(error: unknown): boolean {
  return (error instanceof OzonApiError || error instanceof WildberriesApiError) && (error.status === 401 || error.status === 403);
}

function operationErrorMessage(label: string, error: unknown): string {
  if (isPermissionError(error)) {
    return `${label}无权限或未开通，请检查平台 API 凭证权限和店铺套餐`;
  }
  if ((error instanceof OzonApiError || error instanceof WildberriesApiError) && error.status === 429) {
    return `${label}触发平台限流，请稍后重试`;
  }
  if ((error instanceof OzonApiError || error instanceof WildberriesApiError) && error.status > 0) {
    return `${label}请求失败（HTTP ${error.status}），稍后会自动重试`;
  }
  return `${label}暂时不可用，稍后会自动重试`;
}

function failureStatus(
  label: string,
  error: unknown,
  previous: StoreOperationsStatus | undefined,
  updatedAt = previous?.updatedAt ?? null,
): StoreOperationsStatus {
  const hasPreviousValue = Boolean(previous?.updatedAt);
  let state: StoreOperationsState = "error";
  if (hasPreviousValue) {
    state = "stale";
  } else if (isPermissionError(error)) {
    state = "permission_denied";
  }
  return { state, message: operationErrorMessage(label, error), updatedAt };
}

function successStatus(now: Date): StoreOperationsStatus {
  return { state: "ok", message: null, updatedAt: now.toISOString() };
}

function questionFailureLabel(countError: unknown | null, listError: unknown | null): string {
  if (countError && listError) {
    return "买家问题接口";
  }
  if (countError) {
    return "买家问题数量接口";
  }
  return "买家问题列表接口";
}

function mergeQuestionStatus(
  previous: StoreQuestionsView | undefined,
  countError: unknown | null,
  listError: unknown | null,
  now: Date,
): StoreOperationsStatus {
  if (!countError && !listError) {
    return successStatus(now);
  }
  const failure = countError ?? listError;
  const failureLabel = questionFailureLabel(countError, listError);
  const partialUpdatedAt = previous?.status.updatedAt ?? null;
  return failureStatus(failureLabel, failure, previous?.status, partialUpdatedAt);
}

/** Reads current finance and buyer-question summaries without coupling them to order synchronization. */
export class StoreOperationsService implements StoreOperationsReader {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<StoreOperationsStoreView>>();
  private readonly clientFactory: (store: StoreRecord) => StoreOperationsClient | WildberriesOperationsClient;
  private readonly now: () => Date;
  private readonly cacheTtlMs: number;

  public constructor(
    private readonly config: AppConfig,
    private readonly stores: StoresRepository,
    private readonly proxySettings: ProxySettingsService,
    options: StoreOperationsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
    this.clientFactory = options.clientFactory ?? ((store) => {
      const secret = decryptSecret(store.apiKeyCiphertext, this.config.ENCRYPTION_KEY);
      if (store.platform === "wildberries") {
        return new WildberriesClient({
          apiToken: secret,
          fetchImplementation: fetch,
        });
      }
      return new OzonClient({
        clientId: store.clientId,
        apiKey: secret,
        baseUrl: this.config.OZON_API_BASE_URL,
        fetchImplementation: this.proxySettings.createFetch(),
      });
    });
  }

  public async getOverview(storeIds: string[], platform: StorePlatform | "all" = "all"): Promise<StoreOperationsSnapshot> {
    const activeStores = (await this.stores.listActive()).filter((store) => platform === "all" || store.platform === platform);
    const selectedStores = storeIds.length === 0
      ? activeStores
      : activeStores.filter((store) => storeIds.includes(store.id));
    const storeViews = await Promise.all(selectedStores.map((store) => this.getStoreView(store)));
    return { generatedAt: this.now().toISOString(), stores: storeViews };
  }

  public async getQuestionDetail(storeId: string, questionId: string): Promise<BuyerQuestionView | null> {
    const store = await this.stores.findById(storeId);
    if (!store || !store.enabled) {
      return null;
    }
    if (store.platform === "wildberries") {
      return null;
    }
    const question = await (this.clientFactory(store) as StoreOperationsClient).getQuestionInfo(questionId);
    return toBuyerQuestion(store, question);
  }

  private async getStoreView(store: StoreRecord): Promise<StoreOperationsStoreView> {
    const now = this.now().getTime();
    const cached = this.cache.get(store.id);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const running = this.inFlight.get(store.id);
    if (running) {
      return running;
    }

    const refresh = this.refreshStore(store, cached?.value).then((value) => {
      this.cache.set(store.id, { value, expiresAt: this.now().getTime() + this.cacheTtlMs });
      return value;
    }).finally(() => {
      this.inFlight.delete(store.id);
    });
    this.inFlight.set(store.id, refresh);
    return refresh;
  }

  private async refreshStore(
    store: StoreRecord,
    previous: StoreOperationsStoreView | undefined,
  ): Promise<StoreOperationsStoreView> {
    const client = this.clientFactory(store);
    if (store.platform === "wildberries") {
      return {
        storeId: store.id,
        storeName: store.name,
        storeColor: store.color,
        platform: store.platform,
        balance: await this.refreshWildberriesBalance(client, previous?.balance),
        questions: {
          status: { state: "unsupported", message: "WB 暂未接入买家问题", updatedAt: null },
          counts: null,
          latest: [],
        },
      };
    }
    const ozonClient = client as StoreOperationsClient;
    const [balance, questions] = await Promise.all([
      this.refreshBalance(ozonClient, previous?.balance),
      this.refreshQuestions(ozonClient, store, previous?.questions),
    ]);
    return {
      storeId: store.id,
      storeName: store.name,
      storeColor: store.color,
      platform: store.platform,
      balance,
      questions,
    };
  }

  private async refreshWildberriesBalance(
    client: StoreOperationsClient | WildberriesOperationsClient,
    previous: StoreBalanceView | undefined,
  ): Promise<StoreBalanceView> {
    try {
      const value = await (client as WildberriesOperationsClient).getBalance();
      const currency = value.currency?.trim().toUpperCase() || "RUB";
      const current = value.current ? { amount: value.current, currency } : null;
      if (!current) {
        throw new Error("WB 余额接口未返回当前余额");
      }
      const now = this.now();
      return {
        status: successStatus(now),
        primary: current,
        primaryLabel: "可用余额",
        openingBalance: null,
        closingBalance: current,
        accrued: null,
        payments: value.for_withdraw ? [{ amount: value.for_withdraw, currency }] : [],
      };
    } catch (error) {
      if (previous) {
        return { ...previous, status: failureStatus("WB 店铺余额接口", error, previous.status) };
      }
      return {
        status: failureStatus("WB 店铺余额接口", error, undefined),
        primary: null,
        primaryLabel: "可用余额",
        openingBalance: null,
        closingBalance: null,
        accrued: null,
        payments: [],
      };
    }
  }

  private async refreshBalance(
    client: StoreOperationsClient,
    previous: StoreBalanceView | undefined,
  ): Promise<StoreBalanceView> {
    const dateTo = this.now();
    const dateFrom = subDays(dateTo, 30);
    try {
      const value = await client.getFinanceBalance(dateFrom, dateTo);
      const closingBalance = toMoney(value.closingBalance);
      if (!closingBalance) {
        throw new Error("Finance balance report is missing the closing balance");
      }
      return {
        status: successStatus(dateTo),
        primary: closingBalance,
        primaryLabel: "期末余额",
        openingBalance: toMoney(value.openingBalance),
        closingBalance,
        accrued: toMoney(value.accrued),
        payments: value.payments.map(toMoney).filter((payment): payment is Money => payment !== null),
      };
    } catch (error) {
      if (previous) {
        return {
          ...previous,
          status: failureStatus("店铺余额接口", error, previous.status),
        };
      }
      return {
        status: failureStatus("店铺余额接口", error, undefined),
        primary: null,
        primaryLabel: "期末余额",
        openingBalance: null,
        closingBalance: null,
        accrued: null,
        payments: [],
      };
    }
  }

  private async refreshQuestions(
    client: StoreOperationsClient,
    store: StoreRecord,
    previous: StoreQuestionsView | undefined,
  ): Promise<StoreQuestionsView> {
    const [countResult, listResult] = await Promise.allSettled([
      client.getQuestionCount(),
      client.getQuestionList(QUESTION_PREVIEW_LIMIT),
    ]);
    const countError = countResult.status === "rejected" ? countResult.reason : null;
    const listError = listResult.status === "rejected" ? listResult.reason : null;
    const now = this.now();
    return {
      status: mergeQuestionStatus(previous, countError, listError, now),
      counts: countResult.status === "fulfilled" ? toQuestionCount(countResult.value) : previous?.counts ?? null,
      latest: listResult.status === "fulfilled"
        ? listResult.value.questions.map((question) => toBuyerQuestion(store, question))
        : previous?.latest ?? [],
    };
  }
}
