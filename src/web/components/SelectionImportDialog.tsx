import { FileSpreadsheet, Upload, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { SelectionImportMapping, SelectionImportPreview, SelectionImportResult, SelectionRateUnit } from "../../shared/contracts";
import { commitSelectionImport, previewSelectionImport } from "../api";
import { useDialogKeyboard } from "./useDialogKeyboard";

interface SelectionImportDialogProps {
  onClose: () => void;
  onImported: (result: SelectionImportResult) => void;
}

type RequiredMappingKey = "phrase" | "searchCount" | "cartRate" | "orderRate";

const headerHints: Record<RequiredMappingKey | "averagePrice", string[]> = {
  phrase: ["搜索词", "关键词", "поисков", "запрос"],
  searchCount: ["搜索次数", "搜索量", "показ", "количество запрос"],
  cartRate: ["加购转化", "добав", "корзин"],
  orderRate: ["下单转化", "заказ", "конверсия в заказ"],
  averagePrice: ["平均价格", "买家平均价格", "средн", "цена"],
};

/** Finds the first header matching known Chinese or Russian report terminology. */
function suggestHeader(headers: string[], key: keyof typeof headerHints): string {
  return headers.find((header) => headerHints[key].some((hint) => header.toLocaleLowerCase("ru-RU").includes(hint))) ?? "";
}

/** Uses the local calendar date instead of UTC so the imported snapshot matches the operator's day. */
function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function SelectionImportDialog(props: SelectionImportDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SelectionImportPreview | null>(null);
  const [mapping, setMapping] = useState<SelectionImportMapping | null>(null);
  const [snapshotDate, setSnapshotDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SelectionImportResult | null>(null);
  const canCommit = useMemo(() => {
    if (preview?.kind === "market_product") {
      return true;
    }
    return Boolean(mapping?.phrase && mapping.searchCount && mapping.cartRate && mapping.orderRate);
  }, [mapping, preview?.kind]);
  useDialogKeyboard(props.onClose, dialogRef, closeButtonRef);

  function applyPreview(nextPreview: SelectionImportPreview): void {
    setPreview(nextPreview);
    if (nextPreview.detectedSnapshotDate) {
      setSnapshotDate(nextPreview.detectedSnapshotDate);
    }
    if (nextPreview.kind === "market_product") {
      setMapping(null);
      return;
    }
    setMapping({
      phrase: suggestHeader(nextPreview.headers, "phrase"),
      searchCount: suggestHeader(nextPreview.headers, "searchCount"),
      cartRate: suggestHeader(nextPreview.headers, "cartRate"),
      cartRateUnit: "percent",
      orderRate: suggestHeader(nextPreview.headers, "orderRate"),
      orderRateUnit: "percent",
      averagePrice: suggestHeader(nextPreview.headers, "averagePrice") || undefined,
    });
  }

  async function loadPreview(nextFile: File, sheetName?: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      applyPreview(await previewSelectionImport(nextFile, sheetName));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法预览报表");
    } finally {
      setBusy(false);
    }
  }

  async function chooseFile(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const nextFile = event.target.files?.[0];
    if (!nextFile) {
      return;
    }
    setFile(nextFile);
    setResult(null);
    await loadPreview(nextFile);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!file || !preview || !canCommit) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const importResult = await commitSelectionImport({
        file,
        sheetName: preview.selectedSheet,
        snapshotDate,
        kind: preview.kind,
        ...(mapping ? { mapping } : {}),
      });
      setResult(importResult);
      props.onImported(importResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  function updateColumn(key: keyof Pick<SelectionImportMapping, "phrase" | "searchCount" | "cartRate" | "orderRate" | "averagePrice">, value: string): void {
    if (!mapping) {
      return;
    }
    setMapping({ ...mapping, [key]: value || undefined });
  }

  function updateUnit(key: "cartRateUnit" | "orderRateUnit", value: SelectionRateUnit): void {
    if (mapping) {
      setMapping({ ...mapping, [key]: value });
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="dialog selection-import-dialog" role="dialog" aria-modal="true" aria-labelledby="selection-import-title">
        <div className="dialog-heading">
          <div><p className="eyebrow">OZON REPORT IMPORT</p><h2 id="selection-import-title">导入 Ozon 报表</h2></div>
          <button ref={closeButtonRef} className="icon-button" type="button" onClick={props.onClose} aria-label="关闭"><X size={20} /></button>
        </div>
        {result ? (
          <div className="import-complete" role="status">
            <div className="import-complete__icon"><FileSpreadsheet size={28} /></div>
            <h3>报表已导入</h3>
            <p>{result.validRows.toLocaleString("zh-CN")} 条有效数据，跳过 {result.skippedRows.toLocaleString("zh-CN")} 行。</p>
            {result.errors.length > 0 && <details><summary>查看错误摘要</summary><ul>{result.errors.slice(0, 20).map((item) => <li key={`${item.row}-${item.message}`}>第 {item.row} 行：{item.message}</li>)}</ul></details>}
            <button className="primary-button" type="button" onClick={props.onClose}>{result.kind === "market_product" ? "查看热销商品" : "查看机会词库"}</button>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <button className="selection-dropzone" type="button" onClick={() => fileInput.current?.click()} disabled={busy}>
              <Upload size={25} /><strong>{file ? file.name : "选择 CSV 或 XLSX 报表"}</strong><span>UTF-8 CSV / .xlsx · 最大 10 MB、5 万行</span>
            </button>
            <input ref={fileInput} className="sr-only" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void chooseFile(event)} />
            {busy && !preview && <div className="selection-loading" aria-busy="true">正在读取工作表和样例数据…</div>}
            {preview && (
              <>
                <div className={`import-kind-banner import-kind-banner--${preview.kind}`} role="status">
                  <FileSpreadsheet size={18} />
                  <p><strong>{preview.kind === "market_product" ? "已识别：Ozon 全市场商品报表" : "已识别：Ozon 关键词报表"}</strong><span>{preview.kind === "market_product" ? "将导入官方商品销量、流量、库存、促销和广告指标。" : "请继续确认关键词字段映射和转化率口径。"}</span></p>
                </div>
                <div className="import-meta-grid">
                  {preview.sheets.length > 1 ? (
                    <label className="field"><span>工作表</span><select value={preview.selectedSheet} onChange={(event) => { if (file) void loadPreview(file, event.target.value); }}>{preview.sheets.map((sheet) => <option value={sheet} key={sheet}>{sheet}</option>)}</select></label>
                  ) : <div className="import-fact"><span>工作表</span><strong>{preview.selectedSheet}</strong></div>}
                  <label className="field"><span>数据日期</span><input type="date" value={snapshotDate} onChange={(event) => setSnapshotDate(event.target.value)} required /></label>
                  {preview.reportPeriodDays !== null && <div className="import-fact"><span>统计周期</span><strong>近 {preview.reportPeriodDays} 天</strong></div>}
                  <div className="import-fact"><span>检测行数</span><strong>{preview.totalDataRows.toLocaleString("zh-CN")}</strong></div>
                </div>
                {preview.kind === "keyword" && mapping && <fieldset className="import-mapping">
                  <legend>字段映射</legend>
                  <p>请确认 Ozon 报表列与标准字段对应关系；转化率口径必须明确选择。</p>
                  <div className="import-mapping-grid">
                    <ColumnField label="搜索词 *" value={mapping.phrase} headers={preview.headers} onChange={(value) => updateColumn("phrase", value)} />
                    <ColumnField label="搜索次数 *" value={mapping.searchCount} headers={preview.headers} onChange={(value) => updateColumn("searchCount", value)} />
                    <RateField label="加购转化率 *" value={mapping.cartRate} unit={mapping.cartRateUnit} headers={preview.headers} onColumn={(value) => updateColumn("cartRate", value)} onUnit={(value) => updateUnit("cartRateUnit", value)} />
                    <RateField label="下单转化率 *" value={mapping.orderRate} unit={mapping.orderRateUnit} headers={preview.headers} onColumn={(value) => updateColumn("orderRate", value)} onUnit={(value) => updateUnit("orderRateUnit", value)} />
                    <ColumnField label="买家平均价格（可选）" value={mapping.averagePrice ?? ""} headers={preview.headers} optional onChange={(value) => updateColumn("averagePrice", value)} />
                  </div>
                </fieldset>}
                <div className="import-preview-table">
                  <div><strong>样例预览</strong><span>仅展示前 {preview.sampleRows.length} 行</span></div>
                  <div className="table-scroll"><table><thead><tr>{preview.headers.map((header) => <th scope="col" key={header}>{header}</th>)}</tr></thead><tbody>{preview.sampleRows.map((row, rowIndex) => <tr key={rowIndex}>{preview.headers.map((header, columnIndex) => <td key={`${header}-${columnIndex}`}>{row[columnIndex] ?? ""}</td>)}</tr>)}</tbody></table></div>
                </div>
              </>
            )}
            {error && <div className="field-error" role="alert">{error}</div>}
            <div className="dialog-actions"><button className="secondary-button" type="button" onClick={props.onClose}>取消</button><button className="primary-button" type="submit" disabled={!canCommit || busy}>{busy && preview ? "正在导入…" : "确认导入"}</button></div>
          </form>
        )}
      </section>
    </div>
  );
}

interface ColumnFieldProps {
  label: string;
  value: string;
  headers: string[];
  optional?: boolean;
  onChange: (value: string) => void;
}

function ColumnField(props: ColumnFieldProps): React.JSX.Element {
  return <label className="field"><span>{props.label}</span><select value={props.value} onChange={(event) => props.onChange(event.target.value)} required={!props.optional}><option value="">{props.optional ? "不导入" : "请选择列"}</option>{props.headers.map((header) => <option value={header} key={header}>{header}</option>)}</select></label>;
}

interface RateFieldProps {
  label: string;
  value: string;
  unit: SelectionRateUnit;
  headers: string[];
  onColumn: (value: string) => void;
  onUnit: (value: SelectionRateUnit) => void;
}

function RateField(props: RateFieldProps): React.JSX.Element {
  return (
    <div className="rate-field">
      <ColumnField label={props.label} value={props.value} headers={props.headers} onChange={props.onColumn} />
      <label className="field"><span>数值口径</span><select value={props.unit} onChange={(event) => props.onUnit(event.target.value as SelectionRateUnit)}><option value="percent">百分数（12.5 = 12.5%）</option><option value="fraction">小数（0.125 = 12.5%）</option></select></label>
    </div>
  );
}
