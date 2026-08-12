import { X } from "lucide-react";
import { useRef, useState } from "react";

import type {
  SelectionCandidate,
  SelectionCandidateCreateInput,
  SelectionCandidateStatus,
  SelectionCandidateUpdateInput,
  SelectionKeywordDetail,
  SelectionMarketProductListItem,
} from "../../shared/contracts";
import { useDialogKeyboard } from "./useDialogKeyboard";

interface SelectionCandidateDialogProps {
  candidate?: SelectionCandidate | null;
  keyword?: SelectionKeywordDetail | null;
  marketProduct?: SelectionMarketProductListItem | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (input: SelectionCandidateCreateInput) => void;
  onUpdate: (id: string, input: SelectionCandidateUpdateInput) => void;
}

const statusOptions: Array<{ value: SelectionCandidateStatus; label: string }> = [
  { value: "watching", label: "观察" },
  { value: "recommended", label: "推荐推进" },
  { value: "rejected", label: "淘汰" },
];

/** Creates or updates one candidate while preserving its linked keyword context. */
export function SelectionCandidateDialog(props: SelectionCandidateDialogProps): React.JSX.Element {
  const initialName = props.candidate?.name ?? props.marketProduct?.name ?? props.keyword?.phrase ?? "";
  const [name, setName] = useState(initialName);
  const [ozonUrl, setOzonUrl] = useState(props.candidate?.ozonUrl ?? props.marketProduct?.ozonUrl ?? "");
  const [category, setCategory] = useState(props.candidate?.category ?? props.marketProduct?.categoryLevel3 ?? "");
  const [targetPrice, setTargetPrice] = useState(props.candidate?.targetPrice?.amount ?? "");
  const [status, setStatus] = useState<SelectionCandidateStatus>(props.candidate?.status ?? "watching");
  const [decisionReason, setDecisionReason] = useState(props.candidate?.decisionReason ?? "");
  const [note, setNote] = useState(props.candidate?.note ?? "");
  const dialogRef = useRef<HTMLElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);

  useDialogKeyboard(props.onClose, dialogRef, firstInput);

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (props.candidate) {
      props.onUpdate(props.candidate.id, {
        name: name.trim(),
        ozonUrl: ozonUrl.trim() || null,
        category: category.trim() || null,
        targetPrice: targetPrice.trim() || null,
        status,
        decisionReason: decisionReason.trim() || null,
        note: note.trim() || null,
      });
      return;
    }
    props.onCreate({
      ...(props.keyword ? { keywordId: props.keyword.id } : {}),
      ...(props.marketProduct ? { marketProductId: props.marketProduct.id } : {}),
      name: name.trim(),
      ...(ozonUrl.trim() ? { ozonUrl: ozonUrl.trim() } : {}),
      ...(category.trim() ? { category: category.trim() } : {}),
      ...(targetPrice.trim() ? { targetPrice: targetPrice.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="dialog selection-candidate-dialog" role="dialog" aria-modal="true" aria-labelledby="candidate-dialog-title">
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">CANDIDATE DECISION</p>
            <h2 id="candidate-dialog-title">{props.candidate ? "编辑候选商品" : "加入候选池"}</h2>
          </div>
          <button className="icon-button" type="button" onClick={props.onClose} aria-label="关闭"><X size={20} /></button>
        </div>
        <form onSubmit={submit}>
          {props.keyword && !props.candidate && (
            <div className="candidate-keyword-context">
              <span>关联关键词</span><strong>{props.keyword.phrase}</strong>
              <small>需求分 {props.keyword.demandScore ?? "样本不足"}</small>
            </div>
          )}
          {props.marketProduct && !props.candidate && (
            <div className="candidate-keyword-context candidate-product-context">
              <span>关联热销商品</span><strong>{props.marketProduct.name}</strong>
              <small>近 {props.marketProduct.reportPeriodDays} 天 {props.marketProduct.orderedUnits.toLocaleString("zh-CN")} 件 · {props.marketProduct.categoryLevel3}</small>
            </div>
          )}
          <label className="field"><span>商品名称 *</span><input ref={firstInput} value={name} onChange={(event) => setName(event.target.value)} maxLength={300} required /></label>
          <label className="field"><span>Ozon 商品链接</span><input type="url" value={ozonUrl} onChange={(event) => setOzonUrl(event.target.value)} placeholder="https://www.ozon.ru/product/..." /><small>相同商品链接不能重复加入候选池。</small></label>
          <div className="form-grid">
            <label className="field"><span>类目</span><input value={category} onChange={(event) => setCategory(event.target.value)} maxLength={300} /></label>
            <label className="field"><span>目标售价（₽）</span><input inputMode="decimal" value={targetPrice} onChange={(event) => setTargetPrice(event.target.value)} placeholder="1699" /></label>
          </div>
          {props.candidate && (
            <label className="field"><span>判断状态</span><select value={status} onChange={(event) => setStatus(event.target.value as SelectionCandidateStatus)}>{statusOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
          )}
          {props.candidate && (
            <label className="field"><span>判断原因</span><textarea rows={3} value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} maxLength={5000} placeholder="记录推荐推进或淘汰的主要依据" /></label>
          )}
          <label className="field"><span>备注</span><textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} maxLength={5000} /></label>
          {props.error && <div className="field-error" role="alert">{props.error}</div>}
          <div className="dialog-actions">
            <button className="secondary-button" type="button" onClick={props.onClose}>取消</button>
            <button className="primary-button" type="submit" disabled={props.pending}>{props.pending ? "正在保存…" : props.candidate ? "保存判断" : "加入候选池"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
