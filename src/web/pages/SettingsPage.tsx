import { BellRing, Check, Clipboard, CloudUpload, Download, Globe2, MonitorUp, Network, RefreshCw, ShieldAlert, Unplug, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import type { ProxyMode } from "../../shared/contracts";
import {
  checkSoftwareUpdate,
  createWallboardPairing,
  fetchNetworkSettings,
  fetchImageStorageSettings,
  fetchOrderNotificationSettings,
  fetchUpdateStatus,
  installSoftwareUpdate,
  revokeWallboardSessions,
  testNetworkSettings,
  testImageStorageSettings,
  testOrderNotification,
  updateNetworkSettings,
  updateImageStorageSettings,
  updateOrderNotificationSettings,
} from "../api";
import { AppNav } from "../components/AppNav";
import { soundPlayer, useSoundEnabled } from "../sound-player";

/** Manages Ozon network routing and LAN read-only wallboard access. */
export default function SettingsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["network-settings"], queryFn: fetchNetworkSettings });
  const imageStorageQuery = useQuery({ queryKey: ["image-storage-settings"], queryFn: fetchImageStorageSettings });
  const notificationQuery = useQuery({
    queryKey: ["order-notifications"],
    queryFn: fetchOrderNotificationSettings,
    refetchInterval: 15_000,
  });
  const updateQuery = useQuery({
    queryKey: ["software-update"],
    queryFn: fetchUpdateStatus,
    refetchInterval: (query) => ["checking", "downloading", "installing"].includes(query.state.data?.state ?? "") ? 1_000 : 30_000,
  });
  const [mode, setMode] = useState<ProxyMode>("auto");
  const [manualProxy, setManualProxy] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [accessKeySecret, setAccessKeySecret] = useState("");
  const [imageStorageTestResult, setImageStorageTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [installingVersion, setInstallingVersion] = useState<string | null>(null);
  const soundEnabled = useSoundEnabled();
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
  const imageStorageMutation = useMutation({
    mutationFn: () => updateImageStorageSettings(accessKeyId, accessKeySecret),
    onSuccess: async () => {
      setAccessKeySecret("");
      setImageStorageTestResult(null);
      setNotice("跟卖图片 OSS 配置已保存。");
      await queryClient.invalidateQueries({ queryKey: ["image-storage-settings"] });
    },
  });
  const imageStorageTestMutation = useMutation({
    mutationFn: testImageStorageSettings,
    onSuccess: (result) => {
      setImageStorageTestResult({ ok: true, message: `OSS 连接测试成功：${result.message}` });
    },
    onError: (error) => {
      setImageStorageTestResult({ ok: false, message: `OSS 连接测试失败：${error instanceof Error ? error.message : "无法连接 OSS"}` });
    },
  });
  const pairingMutation = useMutation({ mutationFn: createWallboardPairing });
  const revokeMutation = useMutation({
    mutationFn: revokeWallboardSessions,
    onSuccess: () => {
      pairingMutation.reset();
      setNotice("所有已配对大屏会话已撤销。");
    },
  });
  const checkUpdateMutation = useMutation({
    mutationFn: checkSoftwareUpdate,
    onSuccess: (data) => {
      queryClient.setQueryData(["software-update"], data);
      setNotice(data.state === "available" ? `发现新版本 ${data.latestVersion}。` : "当前已经是最新版本。");
    },
  });
  const installUpdateMutation = useMutation({
    mutationFn: installSoftwareUpdate,
    onSuccess: (data) => {
      queryClient.setQueryData(["software-update"], data);
      setInstallingVersion(data.latestVersion);
      setNotice("安装包正在下载并校验，完成后服务会短暂离线并自动恢复。");
    },
  });
  const notificationMutation = useMutation({
    mutationFn: updateOrderNotificationSettings,
    onSuccess: (data) => {
      queryClient.setQueryData(["order-notifications"], data);
      setNotice(data.enabled ? "新订单系统通知已开启。" : "新订单系统通知已关闭。");
    },
  });
  const notificationTestMutation = useMutation({
    mutationFn: testOrderNotification,
    onSuccess: () => setNotice("测试通知已发送，请查看系统通知中心。"),
  });

  useEffect(() => {
    if (!installingVersion) {
      return undefined;
    }
    const startedAt = Date.now();
    let cancelled = false;
    const timer = window.setInterval(async () => {
      if (Date.now() - startedAt > 120_000) {
        window.clearInterval(timer);
        if (!cancelled) {
          setNotice("更新后服务尚未恢复，请查看 %ProgramData%\\Ozon GMV Dashboard\\updates\\update.log。");
        }
        return;
      }
      try {
        const [readyResponse, updateResponse] = await Promise.all([
          fetch("/readyz", { cache: "no-store" }),
          fetch("/api/settings/update", { cache: "no-store" }),
        ]);
        if (!readyResponse.ok || !updateResponse.ok) {
          return;
        }
        const update = await updateResponse.json() as { currentVersion?: string };
        if (update.currentVersion === installingVersion) {
          window.location.reload();
        }
      } catch {
        // A brief connection failure is expected while the Windows service is replaced.
      }
    }, 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [installingVersion]);

  async function copyLink(link: string): Promise<void> {
    await navigator.clipboard.writeText(link);
    setNotice("配对链接已复制，有效期 10 分钟且只能使用一次。");
  }

  const error = saveMutation.error
    ?? testMutation.error
    ?? pairingMutation.error
    ?? revokeMutation.error
    ?? checkUpdateMutation.error
    ?? installUpdateMutation.error
    ?? notificationMutation.error
    ?? notificationTestMutation.error
    ?? imageStorageMutation.error;
  const update = updateQuery.data;
  const updateBusy = update?.state === "checking" || update?.state === "downloading" || update?.state === "installing";
  const progress = update?.totalBytes ? Math.min(100, Math.round((update.downloadedBytes / update.totalBytes) * 100)) : 0;
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

        <section className="settings-card" aria-labelledby="update-heading">
          <div className="settings-card__heading"><div className="settings-icon"><Download size={21} /></div><div><p className="eyebrow">SOFTWARE UPDATE</p><h3 id="update-heading">软件更新</h3><p>Windows 安装版会自动检查稳定版更新，只有管理员确认后才会安装。</p></div></div>
          {updateQuery.isLoading ? <div className="settings-skeleton settings-skeleton--compact" aria-busy="true" /> : (
            <div className="update-panel">
              <dl className="update-facts">
                <div><dt>当前版本</dt><dd>v{update?.currentVersion ?? "-"}</dd></div>
                <div><dt>最新版本</dt><dd>{update?.latestVersion ? `v${update.latestVersion}` : "尚未检查"}</dd></div>
                <div><dt>更新状态</dt><dd>{updateStateLabel(update?.state ?? "idle")}</dd></div>
                <div><dt>检查时间</dt><dd>{update?.lastCheckedAt ? new Date(update.lastCheckedAt).toLocaleString("zh-CN") : "尚未检查"}</dd></div>
              </dl>
              {!update?.supported && <div className="update-message"><strong>当前环境不启用在线更新</strong><p>Windows 正式安装版支持此功能；macOS 本机服务继续使用 <code>npm run service:mac:update</code>。</p></div>}
              {update?.notes && <div className="update-notes"><strong>更新说明</strong><p>{update.notes}</p>{update.publishedAt && <small>发布于 {new Date(update.publishedAt).toLocaleString("zh-CN")}</small>}</div>}
              {(update?.state === "downloading" || update?.state === "installing") && (
                <div className="update-progress" aria-live="polite">
                  <div><span>{update.state === "installing" ? "正在安装并重启服务" : "正在下载安装包"}</span><strong>{progress}%</strong></div>
                  <progress max="100" value={progress}>{progress}%</progress>
                  <small>服务恢复后页面会自动刷新，店铺、订单和设置不会丢失。</small>
                </div>
              )}
              {update?.error && <div className="field-error" role="alert">{update.error}</div>}
              <div className="settings-actions">
                <button className="secondary-button" type="button" onClick={() => checkUpdateMutation.mutate()} disabled={!update?.supported || updateBusy || checkUpdateMutation.isPending}><RefreshCw className={update?.state === "checking" ? "sync-spinner" : undefined} size={17} />{update?.state === "checking" ? "正在检查…" : "检查更新"}</button>
                {update?.state === "available" && <button className="primary-button" type="button" onClick={() => { if (window.confirm("服务将短暂离线，店铺、订单和设置不会丢失。是否继续更新？")) installUpdateMutation.mutate(); }} disabled={installUpdateMutation.isPending}><Download size={17} />一键更新</button>}
              </div>
            </div>
          )}
        </section>

        <section className="settings-card" aria-labelledby="image-storage-heading">
          <div className="settings-card__heading"><div className="settings-icon"><CloudUpload size={21} /></div><div><p className="eyebrow">RESELL IMAGE STORAGE</p><h3 id="image-storage-heading">跟卖图片存储</h3><p>本地图片会压缩后上传到 OSS，生成 Ozon 可访问的 HTTPS 地址。密钥只加密保存在本机。</p></div></div>
          <div className="update-message">
            <strong>{imageStorageQuery.data?.configured ? "OSS 已配置" : "尚未配置 OSS"}</strong>
            <p>{imageStorageQuery.data?.bucket ?? "haodian-ozon-images"} / {imageStorageQuery.data?.prefix ?? "ozon/resell-images"}</p>
            {imageStorageQuery.data?.configured && (
              <div className="credential-summary" aria-label="已保存的 OSS 凭据">
                <span>AccessKey ID <code>{imageStorageQuery.data.accessKeyIdMasked ?? "已配置"}</code></span>
                <span>AccessKey Secret <code>{imageStorageQuery.data.accessKeySecretMasked ?? "••••••••••••"}</code></span>
              </div>
            )}
            <p>{imageStorageQuery.data?.configured ? "密钥已加密保存。需要更换时，请同时输入新的 ID 和 Secret；留空不会回显原始密钥。" : "请仅将该前缀设为公共读、禁止公共写，否则 Ozon 无法抓取图片或会扩大存储桶暴露范围。"}</p>
          </div>
          <form onSubmit={(event) => { event.preventDefault(); imageStorageMutation.mutate(); }}>
            <div className="resell-form-grid">
              <label className="field"><span>{imageStorageQuery.data?.configured ? "更换 AccessKey ID" : "AccessKey ID"}</span><input value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} placeholder={imageStorageQuery.data?.configured ? "已配置，输入新 ID 可替换" : undefined} autoComplete="off" required /></label>
              <label className="field"><span>{imageStorageQuery.data?.configured ? "更换 AccessKey Secret" : "AccessKey Secret"}</span><input type="password" value={accessKeySecret} onChange={(event) => setAccessKeySecret(event.target.value)} placeholder={imageStorageQuery.data?.configured ? "已配置，输入新 Secret 可替换" : undefined} autoComplete="new-password" required /></label>
            </div>
            <div className="settings-actions"><button className="primary-button" type="submit" disabled={imageStorageMutation.isPending}>{imageStorageMutation.isPending ? "正在保存…" : "保存 OSS 配置"}</button><button className="secondary-button" type="button" onClick={() => imageStorageTestMutation.mutate()} disabled={!imageStorageQuery.data?.configured || imageStorageTestMutation.isPending}><RefreshCw className={imageStorageTestMutation.isPending ? "sync-spinner" : undefined} size={17} />{imageStorageTestMutation.isPending ? "正在测试…" : "测试 OSS 连接"}</button></div>
            {imageStorageTestResult && <div className={`connection-result${imageStorageTestResult.ok ? "" : " connection-result--error"}`} role={imageStorageTestResult.ok ? "status" : "alert"}>{imageStorageTestResult.ok ? <Check size={17} /> : <ShieldAlert size={17} />}<strong>{imageStorageTestResult.message}</strong></div>}
          </form>
        </section>

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

        <section className="settings-card" aria-labelledby="notifications-heading">
          <div className="settings-card__heading"><div className="settings-icon"><BellRing size={21} /></div><div><p className="eyebrow">ORDER ALERTS</p><h3 id="notifications-heading">新订单系统通知</h3><p>关闭网页后仍可通过 Windows 或 macOS 系统通知获知新订单。</p></div></div>
          {notificationQuery.isLoading ? <div className="settings-skeleton settings-skeleton--compact" aria-busy="true" /> : (
            <div className="notification-settings">
              <label className="notification-toggle">
                <span><strong>新订单弹窗</strong><small>默认开启；历史回填、订单更新和取消不会触发弹窗。</small></span>
                <input
                  type="checkbox"
                  checked={notificationQuery.data?.enabled ?? true}
                  disabled={!notificationQuery.data?.supported || notificationMutation.isPending}
                  onChange={(event) => notificationMutation.mutate(event.target.checked)}
                />
              </label>
              <dl className="update-facts">
                <div><dt>平台支持</dt><dd>{notificationQuery.data?.supported ? "支持" : "当前系统不支持"}</dd></div>
                <div><dt>通知助手</dt><dd>{notificationQuery.data?.agentConnected ? "已连接" : "尚未连接"}</dd></div>
                <div><dt>最近通知</dt><dd>{notificationQuery.data?.lastDeliveredAt ? new Date(notificationQuery.data.lastDeliveredAt).toLocaleString("zh-CN") : "暂无"}</dd></div>
              </dl>
              {notificationQuery.data?.lastError && <div className="field-error" role="alert">{notificationQuery.data.lastError}</div>}
              {!notificationQuery.data?.agentConnected && notificationQuery.data?.supported && <div className="update-message"><strong>通知助手尚未连接</strong><p>完成本机服务安装或更新后会随系统登录自动启动，连接建立后即可在关闭网页时收到提醒。</p></div>}
              <div className="settings-actions">
                <button className="secondary-button" type="button" disabled={!notificationQuery.data?.enabled || !notificationQuery.data?.agentConnected || notificationTestMutation.isPending} onClick={() => notificationTestMutation.mutate()}><BellRing size={17} />{notificationTestMutation.isPending ? "正在发送…" : "发送测试通知"}</button>
              </div>
            </div>
          )}
        </section>

        <section className="settings-card" aria-labelledby="web-sound-heading">
          <div className="settings-card__heading"><div className="settings-icon"><Volume2 size={21} /></div><div><p className="eyebrow">WEB SOUND</p><h3 id="web-sound-heading">大屏提示音</h3><p>大屏页面打开时，新订单到达会在浏览器内播放提示音；关闭网页后的系统通知不受影响。</p></div></div>
          <div className="notification-settings">
            <label className="notification-toggle">
              <span><strong>新订单提示音</strong><small>仅新订单触发；订单更新、历史回填不会播放。</small></span>
              <input
                type="checkbox"
                checked={soundEnabled}
                onChange={(event) => soundPlayer.setEnabled(event.target.checked)}
              />
            </label>
            <div className="sound-note"><strong>固定提示音：金币到账</strong><span>使用已配置的 MP3 音效；浏览器可能要求先与页面交互一次才能发声。</span></div>
          </div>
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

function updateStateLabel(state: string): string {
  const labels: Record<string, string> = {
    idle: "等待检查",
    checking: "正在检查",
    "up-to-date": "已是最新版本",
    available: "发现新版本",
    downloading: "正在下载",
    installing: "正在安装",
    failed: "更新失败",
    unsupported: "当前环境不支持",
  };
  return labels[state] ?? state;
}
