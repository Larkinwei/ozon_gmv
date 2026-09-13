import { CircleAlert, CircleDollarSign, RefreshCw } from "lucide-react";

import type {
  StoreBalanceView,
  StoreOperationsSnapshot,
  StoreOperationsState,
  StoreOperationsStatus,
  StoreOperationsStoreView,
} from "../../shared/contracts";
import { HIDDEN_PLACEHOLDER } from "../dashboard-privacy";
import { formatBeijingTime, formatMoney } from "../format";

interface StoreOperationsPanelProps {
  snapshot: StoreOperationsSnapshot | undefined;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  privacyHidden?: boolean;
}

function statusLabel(state: StoreOperationsState): string {
  switch (state) {
    case "ok":
      return "已更新";
    case "stale":
      return "数据可能已过期";
    case "permission_denied":
      return "无权限或未开通";
    case "unsupported":
      return "暂未接入";
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
    case "unsupported":
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

function formatBalanceMetric(value: StoreBalanceView["openingBalance"], privacyHidden: boolean): string {
  return privacyHidden ? HIDDEN_PLACEHOLDER : value ? formatMoney(value) : "—";
}

function BalanceMetrics({ balance, privacyHidden }: { balance: StoreBalanceView; privacyHidden: boolean }): React.JSX.Element {
  return (
    <dl className="operations-balance-metrics">
      <div><dt>周期开始余额</dt><dd>{formatBalanceMetric(balance.openingBalance, privacyHidden)}</dd></div>
      <div><dt>周期入账</dt><dd>{formatBalanceMetric(balance.accrued, privacyHidden)}</dd></div>
    </dl>
  );
}

function BalanceStoreRow({ store, showMetrics, privacyHidden }: { store: StoreOperationsStoreView; showMetrics: boolean; privacyHidden: boolean }): React.JSX.Element {
  const { balance } = store;
  return (
    <article className={`operations-store-row${showMetrics ? "" : " operations-store-row--compact"}`}>
      <div className="operations-store-row__header">
          <span className="store-chip" style={{ "--store-color": store.storeColor } as React.CSSProperties}>
          <span className="store-dot" aria-hidden="true" />
          {privacyHidden ? HIDDEN_PLACEHOLDER : store.storeName}
        </span>
        <StatusBadge status={balance.status} />
      </div>
      {balance.primary ? (
        <>
          <div className="operations-balance-primary">
            <strong>{privacyHidden ? HIDDEN_PLACEHOLDER : formatMoney(balance.primary)}</strong>
            <span>当前余额</span>
          </div>
          {showMetrics && store.platform === "ozon" && <BalanceMetrics balance={balance} privacyHidden={privacyHidden} />}
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

function OperationsSkeleton(): React.JSX.Element {
  return (
    <div className="store-operations-grid store-operations-grid--single" aria-busy="true" aria-label="正在加载店铺经营提醒">
      <section className="panel operations-card operations-card--skeleton"><div /><div /><div /><div /></section>
    </div>
  );
}

export function StoreOperationsPanel({ snapshot, isLoading, error, onRetry, privacyHidden = false }: StoreOperationsPanelProps): React.JSX.Element {
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

  return (
    <div className="store-operations-grid store-operations-grid--single">
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
          <BalanceStoreRow key={store.storeId} store={store} showMetrics={snapshot.stores.length === 1} privacyHidden={privacyHidden} />
          ))}
        </div>
      </section>
    </div>
  );
}
