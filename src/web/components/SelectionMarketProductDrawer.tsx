import { ExternalLink, PackageSearch, Plus, X } from "lucide-react";
import { useRef } from "react";

import type { SelectionMarketProductDetail } from "../../shared/contracts";
import { formatCompactNumber, formatMoney } from "../format";
import { useDialogKeyboard } from "./useDialogKeyboard";

interface SelectionMarketProductDrawerProps {
  product: SelectionMarketProductDetail | null;
  loading: boolean;
  onClose: () => void;
  onAddCandidate: (product: SelectionMarketProductDetail) => void;
}

function formatPercent(value: number | null, signDisplay: "auto" | "always" = "auto"): string {
  if (value === null) {
    return "无数据";
  }
  return new Intl.NumberFormat("zh-CN", {
    style: "percent",
    maximumFractionDigits: 2,
    signDisplay,
  }).format(value);
}

/** Presents all official Ozon product metrics without deriving an opaque opportunity score. */
export function SelectionMarketProductDrawer(props: SelectionMarketProductDrawerProps): React.JSX.Element {
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useDialogKeyboard(props.onClose, drawerRef, closeButtonRef);
  return (
    <div className="selection-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) props.onClose(); }}>
      <aside ref={drawerRef} className="selection-keyword-drawer selection-product-drawer" role="dialog" aria-modal="true" aria-labelledby="product-detail-title">
        <div className="selection-drawer-heading">
          <div><p className="eyebrow">MARKET PRODUCT EVIDENCE</p><h2 id="product-detail-title">热销商品详情</h2></div>
          <button ref={closeButtonRef} className="icon-button" type="button" onClick={props.onClose} aria-label="关闭热销商品详情"><X size={20} /></button>
        </div>
        {props.loading || !props.product ? <div className="selection-drawer-loading" aria-busy="true">正在读取商品数据…</div> : (
          <div className="selection-drawer-content">
            <div className="market-product-title">
              <div className="market-product-title__icon"><PackageSearch size={22} /></div>
              <div><span>{props.product.brand} · {props.product.categoryLevel3}</span><h3>{props.product.name}</h3><small>数据日期 {props.product.snapshotDate} · 近 {props.product.reportPeriodDays} 天</small></div>
            </div>
            {props.product.productFlags.length > 0 && <div className="market-product-tags">{props.product.productFlags.map((flag) => <span key={flag}>{flag}</span>)}</div>}

            <MetricSection title="销售表现">
              <Metric label="下单金额" value={formatMoney(props.product.orderedAmount)} />
              <Metric label="下单件数" value={`${props.product.orderedUnits.toLocaleString("zh-CN")} 件`} />
              <Metric label="销售额变化" value={formatPercent(props.product.turnoverGrowth, "always")} />
              <Metric label="平均价格" value={formatMoney(props.product.averagePrice)} />
              <Metric label="最低价格" value={formatMoney(props.product.minimumPrice)} />
              <Metric label="签收率" value={formatPercent(props.product.purchaseRate)} />
              <Metric label="日均销售额" value={formatMoney(props.product.dailySalesAmount)} />
              <Metric label="日均销量" value={`${props.product.dailySalesUnits.toLocaleString("zh-CN")} 件`} />
            </MetricSection>

            <MetricSection title="流量漏斗">
              <Metric label="总展示量" value={formatCompactNumber(props.product.impressions)} />
              <Metric label="搜索/目录浏览" value={formatCompactNumber(props.product.searchCatalogViews)} />
              <Metric label="商品卡浏览" value={formatCompactNumber(props.product.cardViews)} />
              <Metric label="展示到下单" value={formatPercent(props.product.impressionToOrderRate)} />
              <Metric label="搜索/目录加购" value={formatPercent(props.product.searchCatalogCartRate)} />
              <Metric label="商品卡加购" value={formatPercent(props.product.cardCartRate)} />
            </MetricSection>

            <MetricSection title="库存与供给">
              <Metric label="错失销售" value={props.product.missedSales.toLocaleString("zh-CN")} />
              <Metric label="缺货天数" value={props.product.outOfStockDays === null ? "无数据" : `${props.product.outOfStockDays} 天`} />
              <Metric label="期末库存" value={`${props.product.endingInventoryUnits.toLocaleString("zh-CN")} 件`} />
              <Metric label="履约方式" value={props.product.fulfillmentScheme} />
            </MetricSection>

            <MetricSection title="促销与广告">
              <Metric label="促销折扣" value={formatPercent(props.product.promotionDiscountRate)} />
              <Metric label="促销订单占比" value={formatPercent(props.product.promotedOrderShare)} />
              <Metric label="促销天数" value={`${props.product.promotionDays} 天`} />
              <Metric label="推广天数" value={`${props.product.advertisedDays} 天`} />
              <Metric label="广告费用占比" value={formatPercent(props.product.advertisingCostShare)} />
            </MetricSection>

            <section className="market-product-section" aria-labelledby="product-basic-heading">
              <h3 id="product-basic-heading">商品基础信息</h3>
              <dl className="market-product-basic-list">
                <div><dt>卖家</dt><dd>{props.product.seller}</dd></div>
                <div><dt>品牌</dt><dd>{props.product.brand}</dd></div>
                <div><dt>一级类目</dt><dd>{props.product.categoryLevel1}</dd></div>
                <div><dt>三级类目</dt><dd>{props.product.categoryLevel3}</dd></div>
                <div><dt>商品体积</dt><dd>{props.product.volumeLiters.toLocaleString("zh-CN")} L</dd></div>
                <div><dt>商品卡创建日期</dt><dd>{props.product.productCardCreatedDate ?? "无数据"}</dd></div>
                <div><dt>Ozon Product ID</dt><dd>{props.product.ozonProductId}</dd></div>
              </dl>
              <a className="secondary-button compact-button" href={props.product.ozonUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />打开 Ozon 商品页</a>
            </section>

            {props.product.history.length > 1 && (
              <section className="market-product-section" aria-labelledby="product-history-heading">
                <h3 id="product-history-heading">历史导入快照</h3>
                <div className="table-scroll"><table className="market-product-history"><thead><tr><th scope="col">数据日期</th><th scope="col">下单金额</th><th scope="col">下单件数</th><th scope="col">销售额变化</th></tr></thead><tbody>{props.product.history.map((snapshot) => <tr key={snapshot.snapshotDate}><td>{snapshot.snapshotDate}</td><td>{formatMoney(snapshot.orderedAmount)}</td><td>{snapshot.orderedUnits.toLocaleString("zh-CN")}</td><td>{formatPercent(snapshot.turnoverGrowth, "always")}</td></tr>)}</tbody></table></div>
              </section>
            )}
            <div className="selection-disclaimer"><strong>数据边界</strong><p>这些指标只代表当次 Ozon 后台筛选和导出范围，不等于全站完整商品总量，也不包含利润判断。</p></div>
          </div>
        )}
        {props.product && <div className="selection-drawer-actions"><button className="primary-button" type="button" onClick={() => props.onAddCandidate(props.product!)}><Plus size={17} />加入候选池</button></div>}
      </aside>
    </div>
  );
}

function MetricSection(props: { title: string; children: React.ReactNode }): React.JSX.Element {
  const id = `market-${props.title}`;
  return <section className="market-product-section" aria-labelledby={id}><h3 id={id}>{props.title}</h3><dl className="market-product-metric-grid">{props.children}</dl></section>;
}

function Metric(props: { label: string; value: string }): React.JSX.Element {
  return <div><dt>{props.label}</dt><dd>{props.value}</dd></div>;
}
