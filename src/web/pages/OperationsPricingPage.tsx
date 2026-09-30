import { useQuery } from "@tanstack/react-query";
import { Calculator, Check, ChevronDown, Clipboard, History, LoaderCircle, RefreshCw, RotateCcw, Save, ShieldAlert, Truck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { createPricingScenario, deletePricingScenario, fetchExchangeRate, fetchPricingScenarios, refreshExchangeRate } from "../api";
import {
  calculateProfitAtSalePrice,
  calculatePricingRisk,
  calculateShipping,
  calculateShippingRisk,
  calculateTargetPrice,
  comparePricingScenarios,
  CEL_RFBS_RULE_VERSION,
  defaultPricingFeeRates,
  PRICING_FORMULA_RULE_VERSION,
  type ExistingPriceInputs,
  type PricingFeeRates,
  type PricingMode,
  type PricingResult,
  type MeasurementPreset,
  type MeasurementUncertainty,
  type PricingScenarioSnapshot,
  type ShippingRiskResult,
  type ShippingInputs,
  type TargetPriceInputs,
  validateProfitInputs,
  validateShippingInputs,
  validateTargetPriceInputs,
} from "../../shared/operations-pricing-calculations";
import type { ExchangeRateSnapshot, PricingScenarioView } from "../../shared/contracts";

type ToolTab = "pricing" | "shipping";
interface PricingDraft {
  mode: PricingMode;
  salePriceCny: string;
  weightKg: string;
  procurementCostCny: string;
  otherCostCny: string;
  targetProfitCny: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  feeRates: PricingFeeRates;
}
type ShippingDraft = Omit<ShippingInputs, "rubPerCny">;
interface Drafts { pricing: PricingDraft; shipping: ShippingDraft; uncertainty: MeasurementUncertainty }

const emptyDrafts: Drafts = {
  pricing: { mode: "target-price", salePriceCny: "", weightKg: "", procurementCostCny: "", otherCostCny: "", targetProfitCny: "", lengthCm: "", widthCm: "", heightCm: "", feeRates: defaultPricingFeeRates },
  shipping: { salePriceCny: "", weightKg: "", lengthCm: "", widthCm: "", heightCm: "" },
  uncertainty: { enabled: true, preset: "normal", weightPercent: "10", lengthCm: "2", widthCm: "2", heightCm: "2" },
};

function readDrafts(): Drafts {
  try {
    const raw = localStorage.getItem("ozon.operations.pricing.drafts");
    if (!raw) return emptyDrafts;
    const saved = JSON.parse(raw) as Partial<Drafts>;
    return {
      pricing: { ...emptyDrafts.pricing, ...saved.pricing, feeRates: { ...defaultPricingFeeRates, ...saved.pricing?.feeRates } },
      shipping: { ...emptyDrafts.shipping, ...saved.shipping },
      uncertainty: { ...emptyDrafts.uncertainty, ...saved.uncertainty },
    };
  } catch {
    return emptyDrafts;
  }
}

function moneyCny(value: string | number): string { return `¥${Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function moneyRub(value: string | number): string { return `₽${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

function Field(props: { label: string; value: string; unit?: string | undefined; error?: string | undefined; hint?: string | undefined; onChange: (value: string) => void }): React.JSX.Element {
  return <label className="pricing-field"><span>{props.label}</span><div className="pricing-input-wrap"><input inputMode="decimal" value={props.value} onChange={(event) => props.onChange(event.target.value)} /><small>{props.unit}</small></div>{props.hint ? <small className="pricing-field-hint">{props.hint}</small> : null}{props.error ? <em>{props.error}</em> : null}</label>;
}

function RateBanner(props: { rate: ExchangeRateSnapshot; calculationRate: string; onRefresh: () => void; onUseLatest: () => void; refreshing: boolean }): React.JSX.Element {
  const rateText = props.rate.available && props.calculationRate ? `¥1 = ₽${Number(props.calculationRate).toFixed(4)}` : "暂无可用汇率";
  const hasNewRate = Boolean(props.rate.rate && props.calculationRate && props.rate.rate !== props.calculationRate);
  return <div className={`pricing-rate-banner${props.rate.error ? " is-error" : ""}`}><div><span className="eyebrow">EXCHANGE RATE</span><strong>{rateText}</strong><small>{props.rate.source ?? "俄罗斯央行公开数据"} · 生效 {props.rate.effectiveDate ?? "—"}{props.rate.error ? ` · ${props.rate.error}` : ""}</small></div><div className="pricing-rate-actions"><button className="secondary-button" type="button" onClick={props.onRefresh} disabled={props.refreshing}>{props.refreshing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}更新汇率</button>{hasNewRate ? <button className="primary-button" type="button" onClick={props.onUseLatest}>使用最新汇率重算</button> : null}</div></div>;
}

const feeLabels: Record<keyof PricingFeeRates, string> = { commission: "平台佣金", tax: "税费", withdrawal: "提现手续费", tailService: "尾程及服务费", advertising: "广告营销", afterSales: "售后" };

/** Provides the two browser-local rFBS calculators without contacting Ozon. */
export default function OperationsPricingPage(): React.JSX.Element {
  const [tab, setTab] = useState<ToolTab>("pricing");
  const [drafts, setDrafts] = useState<Drafts>(readDrafts);
  const [feesOpen, setFeesOpen] = useState(false);
  const [riskOpen, setRiskOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [scenarioName, setScenarioName] = useState("");
  const [scenarioSku, setScenarioSku] = useState("");
  const [selectedScenarioIds, setSelectedScenarioIds] = useState<string[]>([]);
  const [calculationRate, setCalculationRate] = useState("");
  const rateQuery = useQuery({ queryKey: ["tools", "exchange-rate"], queryFn: fetchExchangeRate, staleTime: Infinity, gcTime: 30 * 60_000, refetchOnWindowFocus: false });
  const scenariosQuery = useQuery({ queryKey: ["tools", "pricing", "scenarios"], queryFn: () => fetchPricingScenarios(), staleTime: 30_000, gcTime: 30 * 60_000, refetchOnWindowFocus: false, enabled: historyOpen });
  const rate = rateQuery.data;
  const latestRate = rate?.rate ?? "";

  useEffect(() => {
    if (!calculationRate && rate?.available && rate.rate) setCalculationRate(rate.rate);
  }, [calculationRate, rate]);
  useEffect(() => { localStorage.setItem("ozon.operations.pricing.drafts", JSON.stringify(drafts)); }, [drafts]);

  const targetInputs: TargetPriceInputs = { ...drafts.pricing, rubPerCny: calculationRate };
  const existingInputs: ExistingPriceInputs = { ...drafts.pricing, rubPerCny: calculationRate };
  const pricingErrors = useMemo(() => drafts.pricing.mode === "target-price" ? validateTargetPriceInputs(targetInputs) : validateProfitInputs(existingInputs), [drafts.pricing, calculationRate]);
  const pricing = Object.keys(pricingErrors).length === 0 ? drafts.pricing.mode === "target-price" ? calculateTargetPrice(targetInputs) : calculateProfitAtSalePrice(existingInputs) : null;
  const pricingRisk = pricing && calculationRate ? calculatePricingRisk({ salePriceCny: pricing.mode === "target-price" ? pricing.suggestedPriceCny : pricing.actualSalePriceCny, weightKg: drafts.pricing.weightKg, lengthCm: drafts.pricing.lengthCm, widthCm: drafts.pricing.widthCm, heightCm: drafts.pricing.heightCm, rubPerCny: calculationRate }, drafts.uncertainty) : null;
  const shippingInputs: ShippingInputs = { ...drafts.shipping, rubPerCny: calculationRate };
  const shippingErrors = useMemo(() => validateShippingInputs(shippingInputs), [drafts.shipping, calculationRate]);
  const shipping = Object.keys(shippingErrors).length === 0 ? calculateShipping(shippingInputs) : null;
  const shippingRisk = shipping ? calculateShippingRisk(shippingInputs, drafts.uncertainty) : null;

  function updatePricing(key: keyof PricingDraft, value: string): void { setDrafts((current) => ({ ...current, pricing: { ...current.pricing, [key]: value } })); }
  function updateShipping(key: keyof ShippingDraft, value: string): void { setDrafts((current) => ({ ...current, shipping: { ...current.shipping, [key]: value } })); }
  function updateUncertainty(key: keyof MeasurementUncertainty, value: string | boolean | MeasurementPreset): void { setDrafts((current) => ({ ...current, uncertainty: { ...current.uncertainty, [key]: value } })); }
  function setPricingMode(mode: PricingMode): void { setDrafts((current) => ({ ...current, pricing: { ...current.pricing, mode } })); }
  function loadExample(): void {
    const currentRate = Number(calculationRate || 10);
    setDrafts((current) => ({ ...current, pricing: { ...current.pricing, salePriceCny: String(1600 / currentRate), weightKg: "2.5", procurementCostCny: "54.21", otherCostCny: "0", targetProfitCny: "55", lengthCm: "30", widthCm: "20", heightCm: "10" }, shipping: { ...current.shipping, salePriceCny: String(1500 / currentRate), weightKg: "0.5", lengthCm: "10", widthCm: "10", heightCm: "10" } }));
  }
  function clearActive(): void { setDrafts((current) => ({ ...current, [tab]: tab === "pricing" ? { ...emptyDrafts.pricing, mode: current.pricing.mode, feeRates: current.pricing.feeRates } : emptyDrafts.shipping })); }
  async function handleRefreshRate(): Promise<void> { await refreshExchangeRate(); await rateQuery.refetch(); }
  function copyResult(): void {
    let text = "";
    if (tab === "pricing" && pricing) {
      if (pricing.mode === "target-price") text = `建议成交价 ${moneyCny(pricing.suggestedPriceCny)}，物流 ${moneyCny(pricing.shippingCostCny)}，目标利润 ${moneyCny(pricing.targetProfitCny)}，利润率 ${Number(pricing.profitRate).toFixed(2)}%`;
      else text = `平台实际成交价 ${moneyCny(pricing.actualSalePriceCny)}，预计利润 ${moneyCny(pricing.estimatedProfitCny)}，利润率 ${Number(pricing.profitRate).toFixed(2)}%`;
    } else if (shipping) {
      text = shipping.channels.filter((channel) => channel.availability === "available").map((channel) => `${channel.name} ${channel.chineseName} ${moneyCny(channel.feeCny ?? "0")}`).join("\n");
    }
    if (text) void navigator.clipboard?.writeText(text);
  }

  function openSaveDialog(): void {
    if (!pricing || !pricingRisk) return;
    setScenarioName("");
    setScenarioSku("");
    setSaveOpen(true);
  }

  async function saveScenario(): Promise<void> {
    if (!pricing || !pricingRisk || !scenarioName.trim() || !calculationRate) return;
    await createPricingScenario({ name: scenarioName.trim(), sku: scenarioSku.trim() || null, mode: drafts.pricing.mode, inputs: { ...drafts.pricing, uncertainty: drafts.uncertainty }, feeRates: drafts.pricing.feeRates, exchangeRate: calculationRate, exchangeSource: rate?.source ?? null, exchangeEffectiveDate: rate?.effectiveDate ?? null, ruleVersion: `${PRICING_FORMULA_RULE_VERSION} · ${CEL_RFBS_RULE_VERSION}`, result: pricing, risk: pricingRisk });
    setSaveOpen(false);
    await scenariosQuery.refetch();
  }

  function setPreset(preset: MeasurementPreset): void {
    const values: Record<Exclude<MeasurementPreset, "custom">, MeasurementUncertainty> = {
      reliable: { ...drafts.uncertainty, preset, weightPercent: "5", lengthCm: "1", widthCm: "1", heightCm: "1" },
      normal: { ...drafts.uncertainty, preset, weightPercent: "10", lengthCm: "2", widthCm: "2", heightCm: "2" },
      conservative: { ...drafts.uncertainty, preset, weightPercent: "15", lengthCm: "3", widthCm: "3", heightCm: "3" },
    };
    if (preset !== "custom") setDrafts((current) => ({ ...current, uncertainty: values[preset] }));
  }

  return <main className="operations-tool-page">
    <div className="operations-tool-heading"><div><p className="eyebrow">OPERATIONS CENTER / TOOLS</p><h2>定价与运费</h2><p>人民币输入，按当前汇率匹配 Ozon rFBS 原表规则。</p></div><div className="operations-tool-actions"><button className="secondary-button" type="button" onClick={() => setHistoryOpen(true)}><History size={16} />历史方案</button><button className="secondary-button" type="button" onClick={openSaveDialog} disabled={!pricing}><Save size={16} />保存方案</button><button className="secondary-button" type="button" onClick={copyResult}><Clipboard size={16} />复制结果</button><button className="secondary-button" type="button" onClick={clearActive}><RotateCcw size={16} />清空</button><button className="primary-button" type="button" onClick={loadExample}><Check size={16} />载入表格示例</button></div></div>
    {rate ? <RateBanner rate={rate} calculationRate={calculationRate} onRefresh={() => void handleRefreshRate()} onUseLatest={() => setCalculationRate(latestRate)} refreshing={rateQuery.isFetching} /> : <div className="pricing-rate-banner"><LoaderCircle className="spin" size={18} />正在读取汇率缓存…</div>}
    <div className="pricing-tabs" role="tablist" aria-label="工具类型"><button type="button" role="tab" aria-selected={tab === "pricing"} className={tab === "pricing" ? "is-active" : ""} onClick={() => setTab("pricing")}><Calculator size={17} />定价测算</button><button type="button" role="tab" aria-selected={tab === "shipping"} className={tab === "shipping" ? "is-active" : ""} onClick={() => setTab("shipping")}><Truck size={17} />运费试算</button></div>
    {tab === "pricing" ? <PricingTool drafts={drafts.pricing} rubPerCny={calculationRate} errors={pricingErrors} result={pricing} risk={pricingRisk} uncertainty={drafts.uncertainty} feesOpen={feesOpen} riskOpen={riskOpen} onToggleFees={() => setFeesOpen((open) => !open)} onToggleRisk={() => setRiskOpen((open) => !open)} onChange={updatePricing} onModeChange={setPricingMode} onFeeChange={(key, value) => setDrafts((current) => ({ ...current, pricing: { ...current.pricing, feeRates: { ...current.pricing.feeRates, [key]: value } } }))} onUncertaintyChange={updateUncertainty} onPreset={setPreset} /> : <><RiskControls uncertainty={drafts.uncertainty} open={true} onToggle={() => undefined} onChange={updateUncertainty} onPreset={setPreset} /><RiskSummary result={shippingRisk} /><ShippingTool inputs={drafts.shipping} errors={shippingErrors} result={shipping} risk={shippingRisk} uncertainty={drafts.uncertainty} onChange={updateShipping} onUncertaintyChange={updateUncertainty} onPreset={setPreset} /></>}
    {saveOpen ? <SaveScenarioDialog name={scenarioName} sku={scenarioSku} onNameChange={setScenarioName} onSkuChange={setScenarioSku} onClose={() => setSaveOpen(false)} onSave={() => void saveScenario()} /> : null}
    {historyOpen ? <ScenarioHistoryPanel scenarios={scenariosQuery.data ?? []} selectedIds={selectedScenarioIds} currentRate={calculationRate} onClose={() => setHistoryOpen(false)} onToggle={(id) => setSelectedScenarioIds((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length < 2 ? [...current, id] : current)} onLoad={(scenario, copy) => { const inputs = scenario.inputs as Partial<PricingDraft> & { uncertainty?: MeasurementUncertainty }; setDrafts((current) => ({ ...current, pricing: { ...current.pricing, ...inputs, mode: scenario.mode, feeRates: { ...current.pricing.feeRates, ...(scenario.feeRates as PricingFeeRates) } }, uncertainty: inputs.uncertainty ? { ...current.uncertainty, ...inputs.uncertainty } : current.uncertainty })); setHistoryOpen(false); setScenarioName(copy ? `${scenario.name}（副本）` : ""); setScenarioSku(scenario.sku ?? ""); setSaveOpen(copy); }} onDelete={(id) => void deletePricingScenario(id).then(() => scenariosQuery.refetch())} /> : null}
  </main>;
}

function PricingTool(props: { drafts: PricingDraft; rubPerCny: string; errors: Record<string, string>; result: PricingResult | null; risk: ShippingRiskResult | null; uncertainty: MeasurementUncertainty; feesOpen: boolean; riskOpen: boolean; onToggleFees: () => void; onToggleRisk: () => void; onChange: (key: keyof PricingDraft, value: string) => void; onModeChange: (mode: PricingMode) => void; onFeeChange: (key: keyof PricingFeeRates, value: string) => void; onUncertaintyChange: (key: keyof MeasurementUncertainty, value: string | boolean | MeasurementPreset) => void; onPreset: (preset: MeasurementPreset) => void }): React.JSX.Element {
  const feeTotal = Object.values(props.drafts.feeRates).reduce((sum, value) => sum + Number(value || 0), 0);
  const isTargetMode = props.drafts.mode === "target-price";
  const rubPrice = props.drafts.salePriceCny && props.rubPerCny ? (Number(props.drafts.salePriceCny) * Number(props.rubPerCny)).toFixed(2) : null;
  const setPreset = props.onPreset;
  return <div className="pricing-tool-grid"><section className="pricing-panel"><PanelTitle eyebrow="INPUTS" title="定价方式" source="定价公式.xlsx" /><div className="pricing-mode-tabs" role="tablist" aria-label="定价方式"><button type="button" role="tab" aria-selected={isTargetMode} className={isTargetMode ? "is-active" : ""} onClick={() => props.onModeChange("target-price")}><strong>目标利润反推售价</strong><small>新品上架前使用</small></button><button type="button" role="tab" aria-selected={!isTargetMode} className={!isTargetMode ? "is-active" : ""} onClick={() => props.onModeChange("existing-price")}><strong>已有售价核算利润</strong><small>复盘现有商品</small></button></div><div className="pricing-mode-note">{isTargetMode ? "输入成本和目标利润，计算可发布的建议成交价。" : "输入 Ozon 实际成交价，按费用比例和物流估算利润。"}</div><div className="pricing-form-section"><h4>商品与物流</h4><div className="pricing-form-grid">{isTargetMode ? null : <Field label="平台实际成交价" value={props.drafts.salePriceCny} unit="¥" error={props.errors.salePriceCny} onChange={(value) => props.onChange("salePriceCny", value)} />}<Field label="包装后重量" value={props.drafts.weightKg} unit="kg" error={props.errors.weightKg} onChange={(value) => props.onChange("weightKg", value)} /><Field label="包装长度" value={props.drafts.lengthCm} unit="cm" onChange={(value) => props.onChange("lengthCm", value)} /><Field label="包装宽度" value={props.drafts.widthCm} unit="cm" onChange={(value) => props.onChange("widthCm", value)} /><Field label="包装高度" value={props.drafts.heightCm} unit="cm" onChange={(value) => props.onChange("heightCm", value)} /></div>{rubPrice ? <p className="pricing-conversion">约 {moneyRub(rubPrice)} · 物流档位按实际成交价匹配，不使用划线价或原价</p> : null}</div><div className="pricing-form-section"><h4>成本与利润</h4><div className="pricing-form-grid"><Field label="采购成本" value={props.drafts.procurementCostCny} unit="¥" error={props.errors.procurementCostCny} onChange={(value) => props.onChange("procurementCostCny", value)} /><Field label="其他成本（含礼品）" value={props.drafts.otherCostCny} unit="¥" error={props.errors.otherCostCny} onChange={(value) => props.onChange("otherCostCny", value)} />{isTargetMode ? <Field label="目标利润" value={props.drafts.targetProfitCny} unit="¥" error={props.errors.targetProfitCny} onChange={(value) => props.onChange("targetProfitCny", value)} /> : null}</div></div><div className="pricing-form-section"><button className="pricing-collapse" type="button" aria-expanded={props.feesOpen} onClick={props.onToggleFees}><span><h4>平台费用比例</h4><small>当前合计 {feeTotal.toFixed(1)}%</small></span><ChevronDown className={props.feesOpen ? "is-open" : undefined} size={18} /></button>{props.feesOpen ? <div className="pricing-fee-grid">{Object.entries(props.drafts.feeRates).map(([key, value]) => <Field key={key} label={feeLabels[key as keyof PricingFeeRates]} value={value} unit="%" error={props.errors[`feeRates.${key}`]} onChange={(next) => props.onFeeChange(key as keyof PricingFeeRates, next)} />)}</div> : null}</div><RiskControls uncertainty={props.uncertainty} open={props.riskOpen} onToggle={props.onToggleRisk} onChange={props.onUncertaintyChange} onPreset={setPreset} /></section><div className="pricing-result-column"><PricingResultPanel result={props.result} errors={props.errors} /><RiskSummary result={props.risk} /></div></div>;
}

function PricingResultPanel(props: { result: PricingResult | null; errors: Record<string, string> }): React.JSX.Element {
  if (!props.result) return <section className="pricing-panel pricing-result-panel"><PanelTitle eyebrow="RESULT" title="测算结果" source="原表公式" /><Empty icon={<Calculator size={28} />} title="填完左侧字段后查看结果" message={Object.values(props.errors)[0] ?? "当前输入不符合原表的运费条件，请检查价格与重量。"} /></section>;
  if (props.result.mode === "target-price") return <TargetPriceResult result={props.result} />;
  return <ExistingPriceResult result={props.result} />;
}

function TargetPriceResult(props: { result: Extract<PricingResult, { mode: "target-price" }> }): React.JSX.Element {
  const result = props.result;
  return <PricingResultShell title="建议售价结果" heroLabel={result.status === "stable" ? "建议成交价" : "候选成交价（需确认）"} priceCny={result.suggestedPriceCny} priceRub={result.suggestedPriceRub} priceBand={result.priceBand} profitLabel="目标利润" profitValue={result.targetProfitCny} result={result} extraMetric={<Metric label="划线价参考" value={moneyCny(result.originalPriceCny)} />} warning={result.statusMessage} />;
}

function ExistingPriceResult(props: { result: Extract<PricingResult, { mode: "existing-price" }> }): React.JSX.Element {
  const result = props.result;
  return <PricingResultShell title="实际售价利润" heroLabel="平台实际成交价" priceCny={result.actualSalePriceCny} priceRub={result.actualSalePriceRub} priceBand={result.priceBand} profitLabel="预计利润" profitValue={result.estimatedProfitCny} result={result} warning={null} />;
}

function PricingResultShell(props: { title: string; heroLabel: string; priceCny: string; priceRub: string; priceBand: string | null; profitLabel: string; profitValue: string; result: PricingResult; extraMetric?: React.ReactNode; warning: string | null }): React.JSX.Element {
  const result = props.result;
  return <section className="pricing-panel pricing-result-panel">
    <PanelTitle eyebrow="RESULT" title={props.title} source="原表公式" />
    <div className="pricing-result-hero"><small>{props.heroLabel}</small><strong>{moneyCny(props.priceCny)}</strong><span>{moneyRub(props.priceRub)} · {props.priceBand ?? "未匹配价格区间"} · 利润率 {Number(result.profitRate).toFixed(2)}%</span></div>
    <div className="pricing-result-metrics"><Metric label="rFBS物流费用" value={moneyCny(result.shippingCostCny)} /><Metric label={props.profitLabel} value={moneyCny(props.profitValue)} /><Metric label="订单总成本" value={moneyCny(result.totalCostCny)} />{result.shippingChannel ? <><Metric label="采用物流渠道" value={result.shippingChannel} />{props.extraMetric}</> : props.extraMetric}</div>
    {props.warning ? <p className="pricing-warning">{props.warning}</p> : null}
    <details className="pricing-process"><summary>查看费用明细与计算依据</summary><div className="pricing-fee-lines">{result.feeLines.map((line) => <div key={line.key}><span>{line.label} {line.rate}%</span><strong>{moneyCny(line.amountCny)}</strong></div>)}</div><div className="pricing-basis"><span>计算价格</span><strong>{moneyCny(props.priceCny)} · {moneyRub(props.priceRub)}</strong><span>价格区间</span><strong>{props.priceBand ?? "未匹配"}</strong><span>物流计算依据</span><strong>{result.shippingChannel ?? "原表重量公式（未填写完整包装尺寸）"}</strong><span>费用比例合计</span><strong>{result.feeRateTotal}%</strong></div></details>
  </section>;
}

function PanelTitle(props: { eyebrow: string; title: string; source: string }): React.JSX.Element { return <div className="pricing-panel-title"><div><p className="eyebrow">{props.eyebrow}</p><h3>{props.title}</h3></div><span className="pricing-source-tag">{props.source}</span></div>; }
function Metric(props: { label: string; value: string }): React.JSX.Element { return <div><span>{props.label}</span><strong>{props.value}</strong></div>; }
function Empty(props: { icon: React.ReactNode; title: string; message: string }): React.JSX.Element { return <div className="pricing-empty">{props.icon}<strong>{props.title}</strong><p>{props.message}</p></div>; }

function riskLabel(level: ShippingRiskResult["level"]): string {
  return { safe: "安全", critical: "临界", "high-risk": "高风险", unsupported: "不适用" }[level];
}

function RiskControls(props: { uncertainty: MeasurementUncertainty; open: boolean; onToggle: () => void; onChange: (key: keyof MeasurementUncertainty, value: string | boolean | MeasurementPreset) => void; onPreset: (preset: MeasurementPreset) => void }): React.JSX.Element {
  const { uncertainty } = props;
  return <div className="pricing-risk-controls"><button className="pricing-collapse" type="button" aria-expanded={props.open} onClick={props.onToggle}><span><h4>测量误差假设</h4><small>{uncertainty.enabled ? `已开启 · 重量 ±${uncertainty.weightPercent}% · 尺寸 ±${uncertainty.lengthCm}cm` : "已关闭"}</small></span><ChevronDown className={props.open ? "is-open" : undefined} size={18} /></button>{props.open ? <div className="pricing-risk-controls-body"><label className="pricing-checkbox"><input type="checkbox" checked={uncertainty.enabled} onChange={(event) => props.onChange("enabled", event.target.checked)} /><span>显示物流测量风险</span></label><div className="pricing-risk-presets"><span>快速预设</span>{(["reliable", "normal", "conservative"] as MeasurementPreset[]).map((preset) => <button key={preset} type="button" className={uncertainty.preset === preset ? "is-active" : ""} onClick={() => props.onPreset(preset)}>{preset === "reliable" ? "供应商较可靠" : preset === "normal" ? "普通估算" : "保守核算"}</button>)}</div><div className="pricing-risk-inputs"><Field label="重量误差" value={uncertainty.weightPercent} unit="%" onChange={(value) => { props.onChange("weightPercent", value); props.onChange("preset", "custom"); }} /><Field label="长度误差" value={uncertainty.lengthCm} unit="cm" onChange={(value) => { props.onChange("lengthCm", value); props.onChange("preset", "custom"); }} /><Field label="宽度误差" value={uncertainty.widthCm} unit="cm" onChange={(value) => { props.onChange("widthCm", value); props.onChange("preset", "custom"); }} /><Field label="高度误差" value={uncertainty.heightCm} unit="cm" onChange={(value) => { props.onChange("heightCm", value); props.onChange("preset", "custom"); }} /></div></div> : null}</div>;
}

function RiskSummary(props: { result: ShippingRiskResult | null }): React.JSX.Element | null {
  const result = props.result;
  if (!result) return null;
  return <section className={`pricing-risk-summary is-${result.level}`}><div className="pricing-risk-heading"><div><p className="eyebrow">MEASUREMENT RISK</p><h3>物流测量风险</h3></div><span className="pricing-risk-badge"><ShieldAlert size={15} />{riskLabel(result.level)}</span></div><p>{result.summary}</p>{result.lowestFeeCny && result.highestFeeCny ? <div className="pricing-risk-fee">预计物流区间 <strong>{moneyCny(result.lowestFeeCny)}～{moneyCny(result.highestFeeCny)}</strong></div> : null}{result.factors.length > 0 ? <ul className="pricing-risk-factors">{result.factors.slice(0, 3).map((factor) => <li key={factor.key}>{factor.message}</li>)}</ul> : null}<details><summary>查看建议</summary><ul className="pricing-risk-recommendations">{result.recommendations.map((recommendation) => <li key={recommendation}>{recommendation}</li>)}</ul></details></section>;
}

function SaveScenarioDialog(props: { name: string; sku: string; onNameChange: (value: string) => void; onSkuChange: (value: string) => void; onClose: () => void; onSave: () => void }): React.JSX.Element {
  return <div className="pricing-overlay"><section className="pricing-dialog" role="dialog" aria-modal="true" aria-labelledby="save-scenario-title"><button className="pricing-dialog-close" type="button" aria-label="关闭" onClick={props.onClose}><X size={18} /></button><p className="eyebrow">SAVE SNAPSHOT</p><h3 id="save-scenario-title">保存历史方案</h3><p>保存当前输入、汇率、费率、计算结果和物流风险快照。</p><label className="pricing-field"><span>方案名称</span><input autoFocus value={props.name} placeholder="例如：绿雕 2.5kg 普通估算" onChange={(event) => props.onNameChange(event.target.value)} /></label><label className="pricing-field"><span>SKU / 商品名称（可选）</span><input value={props.sku} placeholder="用于后续搜索" onChange={(event) => props.onSkuChange(event.target.value)} /></label><div className="pricing-dialog-actions"><button className="secondary-button" type="button" onClick={props.onClose}>取消</button><button className="primary-button" type="button" disabled={!props.name.trim()} onClick={props.onSave}><Save size={16} />保存方案</button></div></section></div>;
}

function scenarioSnapshot(view: PricingScenarioView): PricingScenarioSnapshot {
  return { id: view.id, name: view.name, mode: view.mode, inputs: view.inputs as PricingScenarioSnapshot["inputs"], result: view.result as PricingScenarioSnapshot["result"], risk: view.risk as ShippingRiskResult };
}

function recalculateScenario(view: PricingScenarioView, currentRate: string): PricingResult | null {
  const inputs = view.inputs as PricingDraft;
  const feeRates = view.feeRates as PricingFeeRates;
  const rubPerCny = currentRate || view.exchangeRate;
  if (view.mode === "target-price") return calculateTargetPrice({ ...inputs, feeRates, rubPerCny, targetProfitCny: inputs.targetProfitCny });
  return calculateProfitAtSalePrice({ ...inputs, feeRates, rubPerCny, salePriceCny: inputs.salePriceCny });
}

function ScenarioHistoryPanel(props: { scenarios: PricingScenarioView[]; selectedIds: string[]; currentRate: string; onClose: () => void; onToggle: (id: string) => void; onLoad: (scenario: PricingScenarioView, copy: boolean) => void; onDelete: (id: string) => void }): React.JSX.Element {
  const selected = props.scenarios.filter((scenario) => props.selectedIds.includes(scenario.id));
  const comparison = selected.length === 2 && selected[0] && selected[1] ? comparePricingScenarios(scenarioSnapshot(selected[0]), scenarioSnapshot(selected[1])) : null;
  return <div className="pricing-overlay"><aside className="pricing-history-panel" role="dialog" aria-modal="true" aria-labelledby="history-title"><div className="pricing-history-header"><div><p className="eyebrow">LOCAL SQLITE</p><h3 id="history-title">历史方案</h3></div><button className="pricing-dialog-close" type="button" aria-label="关闭历史方案" onClick={props.onClose}><X size={18} /></button></div><p className="pricing-history-hint">手动保存的结果不会因汇率或资费更新而改变。最多选择 2 个方案比较。</p>{props.scenarios.length === 0 ? <Empty icon={<History size={26} />} title="还没有历史方案" message="完成一次测算后点击保存方案。" /> : <div className="pricing-scenario-list">{props.scenarios.map((scenario) => { const currentResult = recalculateScenario(scenario, props.currentRate); return <article className="pricing-scenario-item" key={scenario.id}><label className="pricing-scenario-select"><input type="checkbox" checked={props.selectedIds.includes(scenario.id)} onChange={() => props.onToggle(scenario.id)} /><span><strong>{scenario.name}</strong><small>{scenario.mode === "target-price" ? "目标利润反推售价" : "已有售价核算利润"} · {new Date(scenario.createdAt).toLocaleString("zh-CN")}</small>{scenario.sku ? <small>SKU / 商品：{scenario.sku}</small> : null}</span></label><div className="pricing-scenario-results"><span>保存时结果 <strong>{scenario.mode === "target-price" ? moneyCny((scenario.result as PricingResult).mode === "target-price" ? (scenario.result as Extract<PricingResult, { mode: "target-price" }>).suggestedPriceCny : "0") : moneyCny((scenario.result as Extract<PricingResult, { mode: "existing-price" }>).estimatedProfitCny)}</strong></span>{currentResult ? <span>当前规则重算 <strong>{currentResult.mode === "target-price" ? moneyCny(currentResult.suggestedPriceCny) : moneyCny(currentResult.estimatedProfitCny)}</strong></span> : null}</div><div className="pricing-scenario-actions"><button type="button" onClick={() => props.onLoad(scenario, false)}>载入</button><button type="button" onClick={() => props.onLoad(scenario, true)}>复制</button><button type="button" aria-label={`删除${scenario.name}`} onClick={() => { if (window.confirm(`确定删除方案“${scenario.name}”吗？`)) props.onDelete(scenario.id); }}>删除</button></div></article>; })}</div>}{comparison ? <section className="pricing-comparison"><h4>方案对比</h4>{comparison.fields.map((field) => <div key={field.key}><span>{field.label}</span><strong>{field.left}</strong><strong>{field.right}</strong><small>{field.difference}</small></div>)}</section> : null}</aside></div>;
}

function ShippingTool(props: { inputs: ShippingDraft; errors: Record<string, string>; result: ReturnType<typeof calculateShipping> | null; risk: ShippingRiskResult | null; uncertainty: MeasurementUncertainty; onChange: (key: keyof ShippingDraft, value: string) => void; onUncertaintyChange: (key: keyof MeasurementUncertainty, value: string | boolean | MeasurementPreset) => void; onPreset: (preset: MeasurementPreset) => void }): React.JSX.Element {
  const [showUnsupported, setShowUnsupported] = useState(false);
  const available = props.result?.channels.filter((channel) => channel.availability === "available") ?? [];
  const unsupported = props.result?.channels.filter((channel) => channel.availability === "unsupported") ?? [];
  return <div className="shipping-tool-grid"><section className="pricing-panel"><PanelTitle eyebrow="INPUTS" title="包裹信息" source="CEL 资费表 · OZON-rFBS" /><div className="pricing-form-grid"><Field label="平台实际成交价" value={props.inputs.salePriceCny} unit="¥" error={props.errors.salePriceCny} onChange={(value) => props.onChange("salePriceCny", value)} /><Field label="包裹实重" value={props.inputs.weightKg} unit="kg" error={props.errors.weightKg} onChange={(value) => props.onChange("weightKg", value)} /><Field label="长度" value={props.inputs.lengthCm} unit="cm" error={props.errors.lengthCm} onChange={(value) => props.onChange("lengthCm", value)} /><Field label="宽度" value={props.inputs.widthCm} unit="cm" error={props.errors.widthCm} onChange={(value) => props.onChange("widthCm", value)} /><Field label="高度" value={props.inputs.heightCm} unit="cm" error={props.errors.heightCm} onChange={(value) => props.onChange("heightCm", value)} /></div>{props.result ? <p className="pricing-conversion">约 {moneyRub(props.result.salePriceRub)} · 货值区间：{props.result.priceBand ?? "不符合渠道"}</p> : null}<div className="pricing-form-note"><strong>物流计费依据</strong><span>按平台实际成交价换算后的卢布价格判断货值区间，再按原表的重量、尺寸、体积重和 HK 百克进位条件计算。</span></div></section><section className="pricing-panel pricing-result-panel"><PanelTitle eyebrow="RESULT" title="渠道运费" source="人民币核算" />{props.result ? <><div className="shipping-summary"><strong>{available.length}</strong><span>个渠道适用</span><small>{available.length > 0 ? `最低 ${moneyCny(available.reduce((min, item) => Number(item.feeCny) < Number(min.feeCny) ? item : min).feeCny ?? "0")}` : "没有匹配渠道"}</small></div><div className="shipping-channel-list">{available.map((channel) => <ShippingChannel key={channel.id} channel={channel} />)}</div>{unsupported.length > 0 ? <button className="pricing-collapse" type="button" aria-expanded={showUnsupported} onClick={() => setShowUnsupported((open) => !open)}><span><h4>不适用渠道（{unsupported.length}）</h4><small>展开查看不符合原因</small></span><ChevronDown className={showUnsupported ? "is-open" : undefined} size={18} /></button> : null}{showUnsupported ? <div className="shipping-channel-list shipping-channel-list--muted">{unsupported.map((channel) => <ShippingChannel key={channel.id} channel={channel} />)}</div> : null}</> : <Empty icon={<Truck size={28} />} title="填完包裹信息后查看渠道" message={Object.values(props.errors)[0] ?? "请检查输入"} />}</section></div>;
}

function ShippingChannel(props: { channel: ReturnType<typeof calculateShipping>["channels"][number] }): React.JSX.Element {
  const { channel } = props;
  return <article className={`shipping-channel${channel.availability === "unsupported" ? " is-unsupported" : ""}`}><div className="shipping-channel-main"><div><strong>{channel.name}</strong><span className="shipping-channel-category">{channel.chineseName}</span><small>{channel.service} · {channel.deliveryTime}</small></div><div className="shipping-channel-price">{channel.feeCny ? moneyCny(channel.feeCny) : "不符合渠道"}{channel.cheapest ? <em>最低运费</em> : null}{channel.fastest ? <em>最快时效</em> : null}</div></div><div className="shipping-channel-meta"><span>{channel.billableWeightKg ? `计费重 ${channel.billableWeightKg}kg` : channel.reason}</span><span>{channel.billingLogic}</span><span>退货：{channel.returnService}</span></div></article>;
}
