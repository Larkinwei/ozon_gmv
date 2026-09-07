import { CircleAlert, CircleDollarSign, ExternalLink, MessageCircleQuestion, RefreshCw, X } from "lucide-react";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type {
  BuyerQuestionView,
  StoreBalanceView,
  StoreOperationsSnapshot,
  StoreOperationsState,
  StoreOperationsStatus,
  StoreOperationsStoreView,
} from "../../shared/contracts";
import { fetchQuestionDetail } from "../api";
import { formatBeijingTime, formatMoney } from "../format";
import { useDialogKeyboard } from "./useDialogKeyboard";

interface StoreOperationsPanelProps {
  snapshot: StoreOperationsSnapshot | undefined;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
}

interface QuestionDetailDrawerProps {
  question: BuyerQuestionView;
  onClose: () => void;
}

function statusLabel(state: StoreOperationsState): string {
  switch (state) {
    case "ok":
      return "已更新";
    case "stale":
      return "数据可能已过期";
    case "permission_denied":
      return "无权限或未开通";
    case "error":
      return "接口异常";
  }
}

function statusClassName(state: StoreOperationsState): string {
  switch (state) {
    case "ok":
      return "is-success";
    case "stale":
      return "is-warning";
    case "permission_denied":
      return "is-warning";
    case "error":
      return "is-danger";
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function StatusBadge({ status }: { status: StoreOperationsStatus }): React.JSX.Element {
  return (
    <span className={`operations-status ${statusClassName(status.state)}`}>
      <span className="operations-status__dot" aria-hidden="true" />
      {statusLabel(status.state)}
    </span>
  );
}

function StatusMessage({ status }: { status: StoreOperationsStatus }): React.JSX.Element | null {
  if (!status.message) {
    return null;
  }
  return (
    <p className={`operations-inline-message ${statusClassName(status.state)}`} role={status.state === "error" ? "alert" : undefined}>
      <CircleAlert size={14} aria-hidden="true" />
      {status.message}
    </p>
  );
}

function formatBalanceMetric(value: StoreBalanceView["openingBalance"]): string {
  return value ? formatMoney(value) : "—";
}

function BalanceMetrics({ balance }: { balance: StoreBalanceView }): React.JSX.Element {
  return (
    <dl className="operations-balance-metrics">
      <div><dt>周期开始余额</dt><dd>{formatBalanceMetric(balance.openingBalance)}</dd></div>
      <div><dt>周期入账</dt><dd>{formatBalanceMetric(balance.accrued)}</dd></div>
    </dl>
  );
}

function BalanceStoreRow({ store, showMetrics }: { store: StoreOperationsStoreView; showMetrics: boolean }): React.JSX.Element {
  const { balance } = store;
  return (
    <article className={`operations-store-row${showMetrics ? "" : " operations-store-row--compact"}`}>
      <div className="operations-store-row__header">
        <span className="store-chip" style={{ "--store-color": store.storeColor } as React.CSSProperties}>
          <span className="store-dot" aria-hidden="true" />
          {store.storeName}
        </span>
        <StatusBadge status={balance.status} />
      </div>
      {balance.primary ? (
        <>
          <div className="operations-balance-primary">
            <strong>{formatMoney(balance.primary)}</strong>
            <span>当前余额</span>
          </div>
          {showMetrics && <BalanceMetrics balance={balance} />}
        </>
      ) : (
        <div className="operations-empty-row operations-empty-row--balance">
          <CircleDollarSign size={22} aria-hidden="true" />
          <span>暂无余额报表数据</span>
        </div>
      )}
      {balance.status.updatedAt && (
        <p className="operations-updated-at">更新于 {formatBeijingTime(balance.status.updatedAt, "MM-dd HH:mm")}</p>
      )}
      <StatusMessage status={balance.status} />
    </article>
  );
}

function questionStatusLabel(status: string): string {
  switch (status.toUpperCase()) {
    case "NEW":
      return "新问题";
    case "VIEWED":
      return "已查看";
    case "PROCESSED":
      return "已处理";
    case "UNPROCESSED":
      return "未处理";
    default:
      return status || "未知状态";
  }
}

function questionStatusClass(status: string): string {
  switch (status.toUpperCase()) {
    case "PROCESSED":
      return "is-processed";
    case "VIEWED":
      return "is-viewed";
    default:
      return "is-pending";
  }
}

function latestQuestions(snapshot: StoreOperationsSnapshot): BuyerQuestionView[] {
  return snapshot.stores
    .flatMap((store) => store.questions.latest)
    .sort((left, right) => {
      const leftTime = left.publishedAt ? Date.parse(left.publishedAt) : 0;
      const rightTime = right.publishedAt ? Date.parse(right.publishedAt) : 0;
      return rightTime - leftTime;
    })
    .slice(0, 5);
}

function totalUnprocessed(stores: StoreOperationsStoreView[]): number | null {
  const counts = stores.map((store) => store.questions.counts);
  if (counts.some((count) => count === null)) {
    return null;
  }
  return counts.reduce((total, count) => total + (count?.unprocessed ?? 0), 0);
}

function questionStatusSummary(stores: StoreOperationsStoreView[]): string {
  const counts: Record<StoreOperationsState, number> = {
    ok: 0,
    stale: 0,
    permission_denied: 0,
    error: 0,
  };
  stores.forEach((store) => {
    counts[store.questions.status.state] += 1;
  });

  const summary: string[] = [];
  if (counts.ok > 0) {
    summary.push(`${counts.ok} 家已开通`);
  }
  if (counts.permission_denied > 0) {
    summary.push(`${counts.permission_denied} 家无权限或未开通`);
  }
  if (counts.stale > 0) {
    summary.push(`${counts.stale} 家数据可能已过期`);
  }
  if (counts.error > 0) {
    summary.push(`${counts.error} 家接口异常`);
  }
  return summary.join(" · ");
}

function questionSummaryTitle(unprocessed: number | null): string {
  if (unprocessed === null) {
    return "问题权限待确认";
  }
  return unprocessed === 0 ? "当前没有待处理问题" : "需要关注买家问题";
}

function OperationsSkeleton(): React.JSX.Element {
  return (
    <div className="store-operations-grid" aria-busy="true" aria-label="正在加载店铺经营提醒">
      <section className="panel operations-card operations-card--skeleton"><div /><div /><div /><div /></section>
      <section className="panel operations-card operations-card--skeleton"><div /><div /><div /><div /><div /></section>
    </div>
  );
}

function QuestionDetailDrawer({ question, onClose }: QuestionDetailDrawerProps): React.JSX.Element {
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const questionQuery = useQuery({
    queryKey: ["question-detail", question.storeId, question.id],
    queryFn: () => fetchQuestionDetail(question.storeId, question.id),
    staleTime: 5 * 60_000,
  });
  useDialogKeyboard(onClose, drawerRef, closeButtonRef);

  const detail = questionQuery.data;
  return (
    <div className="order-detail-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="order-detail-drawer question-detail-drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-labelledby="question-detail-title">
        <header className="order-detail-heading">
          <div>
            <p className="eyebrow">BUYER QUESTION</p>
            <h2 id="question-detail-title">问题详情</h2>
          </div>
          <button ref={closeButtonRef} className="icon-button" type="button" onClick={onClose} aria-label="关闭问题详情">
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        {questionQuery.isLoading ? (
          <div className="order-detail-skeleton" aria-busy="true" aria-label="正在加载问题详情"><div /><div /><div /></div>
        ) : questionQuery.error ? (
          <div className="order-detail-error" role="alert">
            <CircleAlert size={30} aria-hidden="true" />
            <strong>问题详情加载失败</strong>
            <p>{errorMessage(questionQuery.error, "问题接口暂时不可用")}</p>
            <button className="secondary-button" type="button" onClick={() => void questionQuery.refetch()}>
              <RefreshCw size={16} aria-hidden="true" />
              重新加载
            </button>
          </div>
        ) : detail ? (
          <div className="order-detail-content question-detail-content">
            <div className="question-detail-summary">
              <span className="store-chip" style={{ "--store-color": detail.storeColor } as React.CSSProperties}>
                <span className="store-dot" aria-hidden="true" />
                {detail.storeName}
              </span>
              <span className={`question-status ${questionStatusClass(detail.status)}`}>{questionStatusLabel(detail.status)}</span>
            </div>
            <p className="question-detail-text">{detail.text || "问题内容暂不可用"}</p>
            <dl className="order-detail-meta question-detail-meta">
              <div><dt>商品</dt><dd>{detail.productName || "—"}</dd></div>
              <div><dt>SKU</dt><dd>{detail.sku || "—"}</dd></div>
              <div><dt>发布时间</dt><dd>{detail.publishedAt ? formatBeijingTime(detail.publishedAt, "yyyy-MM-dd HH:mm:ss") : "—"}</dd></div>
              <div><dt>回答数量</dt><dd>{detail.answersCount}</dd></div>
            </dl>
            <div className="question-detail-links">
              {detail.productUrl && <a className="secondary-button" href={detail.productUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} aria-hidden="true" />查看商品</a>}
              {detail.questionLink && <a className="secondary-button" href={detail.questionLink} target="_blank" rel="noreferrer"><ExternalLink size={16} aria-hidden="true" />打开 Ozon 问题</a>}
            </div>
            <p className="question-detail-readonly">大屏仅提供查看摘要，回复和状态处理请进入店铺后台完成。</p>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

export function StoreOperationsPanel({ snapshot, isLoading, error, onRetry }: StoreOperationsPanelProps): React.JSX.Element {
  const [selectedQuestion, setSelectedQuestion] = useState<BuyerQuestionView | null>(null);
  if (isLoading && !snapshot) {
    return <OperationsSkeleton />;
  }
  if (error && !snapshot) {
    return (
      <section className="panel operations-card operations-card--error" aria-labelledby="operations-error-title">
        <CircleAlert size={28} aria-hidden="true" />
        <div><h2 id="operations-error-title">店铺经营提醒加载失败</h2><p>{error.message}</p></div>
        <button className="secondary-button" type="button" onClick={onRetry}><RefreshCw size={16} aria-hidden="true" />重新加载</button>
      </section>
    );
  }
  if (!snapshot || snapshot.stores.length === 0) {
    return (
      <section className="panel operations-card operations-card--empty" aria-labelledby="operations-empty-title">
        <CircleDollarSign size={26} aria-hidden="true" />
        <div><h2 id="operations-empty-title">店铺经营提醒</h2><p>暂无已启用店铺，请先在店铺管理中添加店铺。</p></div>
      </section>
    );
  }

  const latestQuestion = latestQuestions(snapshot)[0];
  const unprocessed = totalUnprocessed(snapshot.stores);
  return (
    <div className="store-operations-grid">
      <section className="panel operations-card balance-operations-card" aria-labelledby="balance-operations-title">
        <div className="operations-card-heading">
          <div>
            <p className="eyebrow">STORE FINANCE</p>
            <h2 id="balance-operations-title">店铺余额</h2>
          </div>
          <span className="operations-card-count">{snapshot.stores.length} 家店铺</span>
        </div>
        <div className={`operations-store-list${snapshot.stores.length === 1 ? " operations-store-list--single" : ""}`}>
          {snapshot.stores.map((store) => (
          <BalanceStoreRow key={store.storeId} store={store} showMetrics={snapshot.stores.length === 1} />
          ))}
        </div>
      </section>

      <section className="panel operations-card questions-operations-card" aria-labelledby="questions-operations-title">
        <div className="operations-card-heading">
          <div>
            <p className="eyebrow">BUYER QUESTIONS</p>
            <h2 id="questions-operations-title">买家问题</h2>
          </div>
          <div className="operations-question-count" aria-label={unprocessed === null ? "未处理问题数量暂不可用" : `未处理问题 ${unprocessed} 条`}>
            <span>未处理</span>
            <strong>{unprocessed ?? "—"}</strong>
            <small>条</small>
          </div>
        </div>
        <div className="operations-question-summary">
          <div className="operations-question-summary__content">
            <span className="operations-question-summary__icon" aria-hidden="true">
              <MessageCircleQuestion size={20} />
            </span>
            <div>
              <strong>{questionSummaryTitle(unprocessed)}</strong>
              <p>{questionStatusSummary(snapshot.stores)}</p>
            </div>
          </div>
          {latestQuestion && (
            <button
              className="operations-question-action"
              type="button"
              onClick={() => setSelectedQuestion(latestQuestion)}
            >
              查看最近问题
            </button>
          )}
        </div>
        {snapshot.generatedAt && <p className="operations-updated-at">数据刷新于 {formatBeijingTime(snapshot.generatedAt, "MM-dd HH:mm:ss")} · 5 分钟自动更新</p>}
      </section>
      {selectedQuestion && <QuestionDetailDrawer question={selectedQuestion} onClose={() => setSelectedQuestion(null)} />}
    </div>
  );
}
