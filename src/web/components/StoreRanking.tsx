import { Store } from "lucide-react";

import type { StoreBreakdown } from "../../shared/contracts";
import { formatMoneyList } from "../format";

export function StoreRanking({ stores }: { stores: StoreBreakdown[] }): React.JSX.Element {
  const currencies = new Set(stores.flatMap((store) => store.gmv.map((value) => value.currency)));
  const mixedCurrencies = currencies.size > 1;
  const valueForBar = (store: StoreBreakdown): number => (
    mixedCurrencies ? store.orders : Number(store.gmv[0]?.amount ?? 0)
  );
  const maximum = Math.max(...stores.map(valueForBar), 1);
  return (
    <section className="panel ranking-panel" aria-labelledby="ranking-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">STORE PERFORMANCE</p>
          <h2 id="ranking-title">店铺贡献排行</h2>
        </div>
        <span className="panel-count">
          <Store size={16} aria-hidden="true" /> {mixedCurrencies ? "多币种按订单量排序" : `${stores.length} 家店铺`}
        </span>
      </div>
      {stores.length === 0 ? (
        <div className="empty-state">当前范围暂无店铺数据</div>
      ) : (
        <ol className="ranking-list">
          {stores.map((store, index) => {
            const barValue = valueForBar(store);
            return (
              <li key={store.storeId}>
                <span className="rank-number">{String(index + 1).padStart(2, "0")}</span>
                <div className="ranking-content">
                  <div className="ranking-label">
                    <strong>{store.storeName}</strong>
                    <span>{store.orders} 单</span>
                    <b>{formatMoneyList(store.gmv)}</b>
                  </div>
                  <div className="ranking-track" aria-hidden="true">
                    <span style={{ width: `${Math.max((barValue / maximum) * 100, 2)}%`, background: store.color }} />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
