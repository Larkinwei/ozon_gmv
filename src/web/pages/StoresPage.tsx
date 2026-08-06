import { Check, KeyRound, Pencil, Plus, RefreshCw, Server, Unplug } from "lucide-react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import type { StoreCreateInput, StoreCreateResult, StoreView } from "../../shared/contracts";
import { createStore, fetchStores, syncStore, testStore, updateStore } from "../api";
import { AppNav } from "../components/AppNav";
import { StoreFormDialog, type StoreFormValue } from "../components/StoreFormDialog";
import { HealthIcon } from "../components/StatusPill";
import { formatBeijingTime, syncHealthLabel } from "../format";
import { pickAvailableStoreColor } from "../store-colors";

interface Notice {
  tone: "success" | "error";
  text: string;
}

const syncDayOptions = [1, 7, 30, 90] as const;
type SyncDays = (typeof syncDayOptions)[number];

type StoreAction =
  | { id: string; action: "test" }
  | { id: string; action: "sync"; days: SyncDays };

function isStoreSynchronizing(store: StoreView): boolean {
  if (!store.lastSyncStartedAt) {
    return false;
  }
  return !store.lastSyncFinishedAt || store.lastSyncStartedAt > store.lastSyncFinishedAt;
}

export default function StoresPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const storesQuery = useQuery({
    queryKey: ["stores"],
    queryFn: fetchStores,
    refetchInterval: (query) => query.state.data?.some(isStoreSynchronizing) ? 1_000 : false,
  });
  const [editingStore, setEditingStore] = useState<StoreView | null | undefined>();
  const [connectionResult, setConnectionResult] = useState<StoreCreateResult | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [syncDays, setSyncDays] = useState<SyncDays>(30);
  const stores = storesQuery.data ?? [];
  const suggestedStoreColor = useMemo(
    () => pickAvailableStoreColor(storesQuery.data?.map((store) => store.color) ?? []),
    [storesQuery.data],
  );

  const createMutation = useMutation({
    mutationFn: (input: StoreCreateInput) => createStore(input),
    onSuccess: async (result) => {
      setConnectionResult(result);
      setEditingStore(undefined);
      await queryClient.invalidateQueries({ queryKey: ["stores"] });
    },
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, value }: { id: string; value: StoreFormValue }) =>
      updateStore(id, {
        name: value.name,
        color: value.color,
        fulfillmentModes: value.fulfillmentModes,
        ...(value.apiKey ? { apiKey: value.apiKey } : {}),
      }),
    onSuccess: async () => {
      setEditingStore(undefined);
      setNotice({ tone: "success", text: "店铺配置已保存并验证" });
      await queryClient.invalidateQueries({ queryKey: ["stores"] });
    },
  });
  const actionMutation = useMutation({
    mutationFn: async (request: StoreAction) => {
      if (request.action === "test") {
        await testStore(request.id);
      } else {
        await syncStore(request.id, request.days);
      }
      return request;
    },
    onSuccess: async (request) => {
      const text = request.action === "test"
        ? "API 连接和权限验证通过"
        : `已提交最近 ${request.days} 天同步任务，完成后状态会自动更新`;
      setNotice({ tone: "success", text });
      if (request.action === "sync") {
        await queryClient.invalidateQueries({ queryKey: ["stores"] });
      }
    },
    onError: (error) => setNotice({ tone: "error", text: error.message }),
  });
  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => updateStore(id, { enabled }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["stores"] }),
  });

  function submitStore(value: StoreFormValue): void {
    if (editingStore) {
      updateMutation.mutate({ id: editingStore.id, value });
      return;
    }
    if (!value.apiKey) {
      return;
    }
    createMutation.mutate({
      name: value.name,
      clientId: value.clientId,
      apiKey: value.apiKey,
      color: value.color,
      fulfillmentModes: value.fulfillmentModes,
    });
  }

  const formError = createMutation.error?.message ?? updateMutation.error?.message ?? null;
  return (
    <div className="admin-page">
      <a className="skip-link" href="#stores-main">跳到主要内容</a>
      <header className="admin-header">
        <Link className="brand-lockup" to="/dashboard">
          <div className="brand-mark" aria-hidden="true">O</div>
          <div><p className="eyebrow">OZON MULTI-STORE</p><h1>GMV 指挥中心</h1></div>
        </Link>
        <AppNav />
      </header>

      <main className="admin-main" id="stores-main">
        <div className="page-title-row">
          <div>
            <p className="eyebrow">STORE CONNECTIONS</p>
            <h2>店铺管理</h2>
            <p>管理 Seller API 密钥、履约模式、同步状态和连接有效期。</p>
          </div>
          <button className="primary-button" type="button" onClick={() => setEditingStore(null)}>
            <Plus size={18} aria-hidden="true" /> 连接新店铺
          </button>
        </div>

        {notice && <div className={`notice notice--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.tone === "success" && <Check size={17} />}{notice.text}</div>}
        {connectionResult && (
          <section className="webhook-result" aria-labelledby="store-created-title">
            <div><p className="eyebrow">LOCAL POLLING</p><h3 id="store-created-title">店铺已创建</h3></div>
            <p>系统正在后台回填最近 90 天订单；之后 FBO、FBS 与 rFBS 均每 60 秒增量同步。</p>
          </section>
        )}

        {storesQuery.isLoading ? (
          <div className="store-list-skeleton" aria-busy="true" />
        ) : storesQuery.error ? (
          <div className="page-error"><h3>店铺列表加载失败</h3><p>{storesQuery.error.message}</p></div>
        ) : stores.length === 0 ? (
          <div className="empty-store-state"><Server size={34} /><h3>还没有连接店铺</h3><p>添加第一家 Ozon 店铺后会自动验证权限并回填 90 天订单。</p></div>
        ) : (
          <>
            <section className="sync-toolbar" aria-labelledby="manual-sync-title">
              <div className="sync-toolbar__copy">
                <p className="eyebrow">MANUAL SYNC</p>
                <h3 id="manual-sync-title">历史订单补数</h3>
                <p>选择范围后点击对应店铺的“同步”；最新订单仍由服务端自动同步。</p>
              </div>
              <label className="sync-range-field">
                <span>同步范围</span>
                <select value={syncDays} onChange={(event) => setSyncDays(Number(event.target.value) as SyncDays)}>
                  {syncDayOptions.map((days) => <option value={days} key={days}>最近 {days} 天</option>)}
                </select>
              </label>
            </section>
            <section className="store-table-card" aria-label="已连接店铺">
              <div className="table-scroll">
                <table className="store-table">
                  <thead><tr><th scope="col">店铺</th><th scope="col">履约</th><th scope="col">同步状态</th><th scope="col">密钥有效期</th><th scope="col">启用</th><th scope="col">操作</th></tr></thead>
                  <tbody>
                    {stores.map((store) => {
                      const synchronizing = isStoreSynchronizing(store);
                      const submittingSync = actionMutation.isPending
                        && actionMutation.variables?.action === "sync"
                        && actionMutation.variables.id === store.id;
                      return (
                        <tr key={store.id}>
                          <td><div className="store-identity"><span style={{ background: store.color }} /><div><strong>{store.name}</strong><small>Client ID · {store.clientId}</small></div></div></td>
                          <td><div className="mode-tags">{store.fulfillmentModes.map((mode) => <span key={mode}>{mode}</span>)}</div></td>
                          <td>
                            {synchronizing ? (
                              <div className="health-label health-label--syncing"><RefreshCw className="sync-spinner" size={16} aria-hidden="true" /><div><strong>正在同步</strong><small>后台拉取订单中</small></div></div>
                            ) : (
                              <div className={`health-label health-label--${store.syncHealth}`}><HealthIcon health={store.syncHealth} /><div><strong>{syncHealthLabel(store.syncHealth)}</strong><small>{store.lastSyncFinishedAt ? `${formatBeijingTime(store.lastSyncFinishedAt, "MM-dd HH:mm:ss")} 更新` : "尚未同步"}</small></div></div>
                            )}
                          </td>
                          <td>{store.apiKeyExpiresAt ? formatBeijingTime(store.apiKeyExpiresAt, "yyyy-MM-dd") : <span className="muted">以 Ozon 控制台为准</span>}</td>
                          <td><label className="switch"><input type="checkbox" checked={store.enabled} onChange={(event) => toggleMutation.mutate({ id: store.id, enabled: event.target.checked })} aria-label={`${store.name}启用状态`} /><span /></label></td>
                          <td><div className="table-actions">
                            <button type="button" onClick={() => actionMutation.mutate({ id: store.id, action: "test" })} aria-label={`测试 ${store.name} 连接`}><KeyRound size={17} /> 测试</button>
                            <button type="button" disabled={!store.enabled || synchronizing || submittingSync} aria-busy={synchronizing || submittingSync} onClick={() => actionMutation.mutate({ id: store.id, action: "sync", days: syncDays })} aria-label={`同步 ${store.name} 最近 ${syncDays} 天`}><RefreshCw className={synchronizing || submittingSync ? "sync-spinner" : undefined} size={17} /> {synchronizing ? "同步中" : "同步"}</button>
                            <button type="button" onClick={() => setEditingStore(store)} aria-label={`编辑 ${store.name}`}><Pencil size={17} /> 编辑</button>
                          </div></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
        <p className="admin-footnote"><Unplug size={15} /> 停用店铺不会删除历史订单，也不会再发起新的 Ozon API 请求。</p>
      </main>

      {editingStore !== undefined && (
        <StoreFormDialog
          store={editingStore}
          suggestedColor={suggestedStoreColor}
          pending={createMutation.isPending || updateMutation.isPending}
          error={formError}
          onClose={() => setEditingStore(undefined)}
          onSubmit={submitStore}
        />
      )}
    </div>
  );
}
