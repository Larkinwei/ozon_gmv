import { Check, Clipboard, Globe2, MonitorUp, Network, RefreshCw, ShieldAlert, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import type { ProxyMode } from "../../shared/contracts";
import {
  createWallboardPairing,
  fetchNetworkSettings,
  revokeWallboardSessions,
  testNetworkSettings,
  updateNetworkSettings,
} from "../api";
import { AppNav } from "../components/AppNav";

/** Manages Ozon network routing and LAN read-only wallboard access. */
export default function SettingsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["network-settings"], queryFn: fetchNetworkSettings });
  const [mode, setMode] = useState<ProxyMode>("auto");
  const [manualProxy, setManualProxy] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (settingsQuery.data) {
      setMode(settingsQuery.data.mode);
    }
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => updateNetworkSettings(mode, manualProxy.trim() || undefined),
    onSuccess: async () => {
      setNotice("代理设置已保存，后续 Ozon 请求会立即使用新配置。");
      setManualProxy("");
      await queryClient.invalidateQueries({ queryKey: ["network-settings"] });
    },
  });
  const testMutation = useMutation({ mutationFn: testNetworkSettings });
  const pairingMutation = useMutation({ mutationFn: createWallboardPairing });
  const revokeMutation = useMutation({
    mutationFn: revokeWallboardSessions,
    onSuccess: () => {
      pairingMutation.reset();
      setNotice("所有已配对大屏会话已撤销。");
    },
  });

  async function copyLink(link: string): Promise<void> {
    await navigator.clipboard.writeText(link);
    setNotice("配对链接已复制，有效期 10 分钟且只能使用一次。");
  }

  const error = saveMutation.error ?? testMutation.error ?? pairingMutation.error ?? revokeMutation.error;
  return (
    <div className="admin-page">
      <a className="skip-link" href="#settings-main">跳到主要内容</a>
      <header className="admin-header">
        <Link className="brand-lockup" to="/dashboard">
          <div className="brand-mark" aria-hidden="true">O</div>
          <div><p className="eyebrow">OZON MULTI-STORE</p><h1>GMV 指挥中心</h1></div>
        </Link>
        <AppNav />
      </header>

      <main className="admin-main settings-main" id="settings-main">
        <div className="page-title-row">
          <div><p className="eyebrow">LOCAL SERVICE</p><h2>本机设置</h2><p>配置 Ozon 网络出口，以及可信私有局域网内的只读大屏。</p></div>
        </div>
        {notice && <div className="notice notice--success" role="status"><Check size={17} />{notice}</div>}
        {error && <div className="field-error" role="alert">{error.message}</div>}

        <section className="settings-card" aria-labelledby="proxy-heading">
          <div className="settings-card__heading"><div className="settings-icon"><Network size={21} /></div><div><p className="eyebrow">OZON NETWORK</p><h3 id="proxy-heading">代理与连接</h3><p>仅影响后台访问 Ozon Seller API，不改变浏览器网络设置。</p></div></div>
          {settingsQuery.isLoading ? <div className="settings-skeleton" aria-busy="true" /> : (
            <form onSubmit={(event) => { event.preventDefault(); saveMutation.mutate(); }}>
              <fieldset className="proxy-options">
                <legend>连接方式</legend>
                {([
                  ["auto", "自动", "优先使用安装时检测到的 Windows 静态代理"],
                  ["manual", "手动代理", "支持带用户名和密码的 HTTP/HTTPS 代理"],
                  ["direct", "直连", "不通过代理访问 Ozon"],
                ] as const).map(([value, label, description]) => (
                  <label key={value}><input type="radio" name="proxy-mode" checked={mode === value} onChange={() => setMode(value)} /><span><strong>{label}</strong><small>{description}</small></span></label>
                ))}
              </fieldset>
              {mode === "auto" && <p className="detected-proxy"><Globe2 size={16} />检测结果：{settingsQuery.data?.detectedProxy ?? "未检测到代理，将使用直连"}</p>}
              {mode === "manual" && (
                <label className="field proxy-input"><span>代理地址</span><input type="url" placeholder="http://username:password@127.0.0.1:7890" value={manualProxy} onChange={(event) => setManualProxy(event.target.value)} required={!settingsQuery.data?.manualProxy} /><small>{settingsQuery.data?.manualProxy ? `已保存：${settingsQuery.data.manualProxy}${settingsQuery.data.hasManualCredentials ? "（含认证信息）" : ""}；留空可继续使用。` : "认证信息会加密保存，不会在页面中回显。"}</small></label>
              )}
              <div className="settings-actions">
                <button className="primary-button" type="submit" disabled={saveMutation.isPending}>{saveMutation.isPending ? "正在保存…" : "保存设置"}</button>
                <button className="secondary-button" type="button" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}><RefreshCw className={testMutation.isPending ? "sync-spinner" : undefined} size={17} />{testMutation.isPending ? "正在测试…" : "测试 Ozon 连接"}</button>
              </div>
              {testMutation.data && <div className="connection-result" role="status"><Check size={17} /><strong>{testMutation.data.message}</strong><span>{testMutation.data.latencyMs} ms · {testMutation.data.proxy ?? "直连"}</span></div>}
            </form>
          )}
        </section>

        <section className="settings-card" aria-labelledby="wallboard-heading">
          <div className="settings-card__heading"><div className="settings-icon"><MonitorUp size={21} /></div><div><p className="eyebrow">LAN WALLBOARD</p><h3 id="wallboard-heading">局域网只读大屏</h3><p>配对设备只能查看经营大屏，无法访问店铺、密钥、同步和本机设置。</p></div></div>
          <div className="lan-warning"><ShieldAlert size={18} /><div><strong>仅在可信的私有网络中使用</strong><p>请勿在机场、酒店等公共 Wi‑Fi 下开放大屏端口。</p></div></div>
          {!pairingMutation.data ? (
            <div className="settings-actions">
              <button className="primary-button" type="button" onClick={() => pairingMutation.mutate()} disabled={pairingMutation.isPending}>{pairingMutation.isPending ? "正在生成…" : "生成一次性配对链接"}</button>
              <button className="secondary-button" type="button" onClick={() => revokeMutation.mutate()} disabled={revokeMutation.isPending}><Unplug size={17} />撤销全部大屏</button>
            </div>
          ) : (
            <div className="pairing-panel">
              <img src={pairingMutation.data.qrCodeDataUrl} alt="局域网大屏配对二维码" width="220" height="220" />
              <div><h4>扫码或复制链接</h4><p>链接有效期至 {new Date(pairingMutation.data.expiresAt).toLocaleTimeString("zh-CN")}，打开一次后立即失效。</p>{pairingMutation.data.links.map((link) => <div className="pairing-link" key={link}><code>{link}</code><button className="secondary-button compact-button" type="button" onClick={() => void copyLink(link)}><Clipboard size={15} />复制</button></div>)}<button className="secondary-button" type="button" onClick={() => pairingMutation.mutate()}>重新生成</button></div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
