import { KeyRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { fulfillmentModes, type FulfillmentMode, type StoreView } from "../../shared/contracts";

export interface StoreFormValue {
  name: string;
  clientId: string;
  apiKey?: string;
  color: string;
  fulfillmentModes: FulfillmentMode[];
}

interface StoreFormDialogProps {
  store: StoreView | null;
  suggestedColor: string;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (value: StoreFormValue) => void;
}

/** Returns an unambiguous submit action for each form state. */
function getSubmitLabel(pending: boolean, editing: boolean): string {
  if (pending) {
    return "正在验证连接…";
  }

  return editing ? "保存并验证" : "连接并开始回填";
}

export function StoreFormDialog(props: StoreFormDialogProps): React.JSX.Element {
  const [name, setName] = useState(props.store?.name ?? "");
  const [clientId, setClientId] = useState(props.store?.clientId ?? "");
  const [apiKey, setApiKey] = useState("");
  const [color, setColor] = useState(props.store?.color ?? props.suggestedColor);
  const [modes, setModes] = useState<FulfillmentMode[]>(props.store?.fulfillmentModes ?? ["FBO", "FBS"]);
  const firstInput = useRef<HTMLInputElement>(null);

  useEffect(() => firstInput.current?.focus(), []);

  function toggleMode(mode: FulfillmentMode): void {
    setModes((current) => {
      if (current.includes(mode)) {
        return current.length > 1 ? current.filter((item) => item !== mode) : current;
      }
      return [...current, mode];
    });
  }

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    props.onSubmit({
      name: name.trim(),
      clientId: clientId.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      color,
      fulfillmentModes: modes,
    });
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="store-form-title">
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">SELLER API CONNECTION</p>
            <h2 id="store-form-title">{props.store ? "编辑店铺" : "连接新店铺"}</h2>
          </div>
          <button className="icon-button" type="button" onClick={props.onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </div>
        <form className="store-form" onSubmit={submit}>
          <div className="form-grid">
            <label className="field">
              <span>店铺名称 *</span>
              <input ref={firstInput} value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} />
              <small>用于图表、订单流和店铺标签。</small>
            </label>
            <label className="field">
              <span>Client ID *</span>
              <input value={clientId} onChange={(event) => setClientId(event.target.value)} disabled={Boolean(props.store)} required />
              <small>{props.store ? "Client ID 保存后不可修改。" : "来自 Ozon Seller API 设置。"}</small>
            </label>
          </div>
          <label className="field">
            <span>{props.store ? "替换 API Key" : "API Key *"}</span>
            <span className="input-with-icon">
              <KeyRound size={17} aria-hidden="true" />
              <input
                type="password"
                autoComplete="new-password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                required={!props.store}
                placeholder={props.store ? "留空则保持现有密钥" : "输入 Seller API Key"}
              />
            </span>
            <small>密钥写入后仅以 AES-256-GCM 密文保存，页面不会再次返回。</small>
          </label>
          <fieldset className="mode-fieldset">
            <legend>履约模式 *</legend>
            <div className="mode-options">
              {fulfillmentModes.map((mode) => (
                <label key={mode}>
                  <input type="checkbox" checked={modes.includes(mode)} onChange={() => toggleMode(mode)} />
                  <span>{mode}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="field color-field">
            <span>店铺识别色</span>
            <span>
              <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
              <code>{color.toUpperCase()}</code>
            </span>
            <small>{props.store ? "修改后会同步应用到图表和订单流。" : "已从高区分度色板自动分配，也可以手动调整。"}</small>
          </label>
          {props.error && <div className="field-error" role="alert">{props.error}</div>}
          <div className="dialog-actions">
            <button className="secondary-button" type="button" onClick={props.onClose}>取消</button>
            <button className="primary-button" type="submit" disabled={props.pending}>
              {getSubmitLabel(props.pending, Boolean(props.store))}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
