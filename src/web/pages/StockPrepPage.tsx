import { AlertTriangle, Check, Clock3, Link2, PackageCheck, RefreshCw, Search, ShoppingCart } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { OrderImagePreview } from "../components/OrderImagePreview";
import { StockPrepRiskDrawer } from "../components/StockPrepRiskDrawer";
import { addStockPrepBlacklistBuyer, addStockPrepOrderBuyerToBlacklist, approveStockPrepRiskOrder, beginStockPrepFeishuAuthorization, createStockPrepBatch, fetchStockPrepBatch, fetchStockPrepBlacklist, fetchStockPrepConnection, fetchStockPrepFulfillmentPostings, fetchStockPrepState, fetchStores, markStockPrepOrdersAdded, prepareStockPrepPosting, resetStockPrepOrders, revokeStockPrepRiskOrder, saveStockPrepDropshipSuppliers, saveStockPrepFeishuApp, saveStockPrepSource, scanStockPrep, updateStockPrepBlacklistEntry, type StockPrepBatch, type StockPrepOrderKey, type StockPrepScan } from "../api";

const statusNames: Record<string, string> = { pending: "待采购", adding: "加购中", added: "已加购", failed: "加购失败", uncertain: "待核实", unmatched: "未匹配", queued: "排队中", running: "执行中", completed: "已完成", completed_with_errors: "部分异常" };
const ozonStatusNames: Record<string, string> = {
  awaiting_registration: "等待登记", acceptance_in_progress: "正在揽收", awaiting_approve: "等待确认", awaiting_packaging: "等待打包",
  awaiting_deliver: "等待发货", delivering: "运输中", driver_pickup: "等待买家自提", delivered: "已送达", received: "已签收",
  done: "已完成", cancelled: "已取消", cancelled_by_client: "买家取消", cancelled_by_seller: "卖家取消", not_accepted: "未接收",
  arbitration: "争议处理中", client_return: "买家退货", returned: "已退回",
};
type StockPrepTab = "action" | "pending" | "added" | "blacklist" | "config";
type ActionFilter = "all" | "risk" | "mapping" | "failed" | "uncertain" | "ozon";
type PendingFilter = "all" | "pending" | "unmatched" | "failed" | "uncertain";
type SortMode = "deadline" | "offer";
const LAST_STORE_KEY = "ozon-gmv.stock-prep.last-store";

/** Formats the persisted synchronization time to seconds in the browser's local timezone. */
function formatSyncTimestamp(timestamp: number | null | undefined): string {
  if (!timestamp) return "尚未同步";
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Converts Ozon's system status code to a readable Chinese label. */
function localizedOzonStatus(status: string): string {
  return ozonStatusNames[status.toLowerCase()] ?? "其他状态";
}

/** Keeps return summaries readable while translating raw Ozon status codes. */
function localizedHistoryOutcome(outcome: string): string {
  return outcome.startsWith("退货：") ? outcome : localizedOzonStatus(outcome);
}

/** Gives each asynchronous history state a concise operator-facing label. */
function buyerHistoryStateLabel(state: NonNullable<StockPrepScan["groups"][number]["orders"][number]["buyerHistory"]>["syncState"]): string {
  return state === "complete" ? "已同步" : state === "failed" ? "同步失败" : state === "running" || state === "queued" ? "同步中" : "尚未同步";
}

/** Formats the remaining fulfillment time without hiding overdue orders. */
function deadlineLabel(timestamp: number | null | undefined): string {
  if (!timestamp) return "发货时限未知";
  const difference = timestamp - Date.now();
  const hours = Math.max(1, Math.ceil(Math.abs(difference) / 3_600_000));
  return difference < 0 ? `已逾期 ${hours} 小时` : `剩余 ${hours} 小时`;
}

/** Parses persisted order keys for retrying only failed batch items. */
function batchOrderKeys(item: StockPrepBatch["items"][number]): StockPrepOrderKey[] {
  if (!item.order_keys_json) return [];
  try {
    return (JSON.parse(item.order_keys_json) as string[]).flatMap((value) => {
      const [postingNumber, offerId] = value.split("\u0000");
      return postingNumber && offerId ? [{ postingNumber, offerId }] : [];
    });
  } catch { return []; }
}
function updateScanOrders(scan: StockPrepScan, keys: StockPrepOrderKey[], state: string, error: string | null = null): StockPrepScan {
  const changed = new Set(keys.map(keyOf));
  const groups = scan.groups.map((group) => {
    const orders = group.orders.map((order) => changed.has(keyOf(order)) ? { ...order, state, error, selectedByDefault: state === "pending" && order.riskLevel !== "blacklist" && (order.riskLevel !== "review" || order.approved === true) } : order);
    const states = new Set(orders.map((order) => order.state));
    const status = states.size === 1 ? orders[0]?.state ?? group.status : states.has("unmatched") ? "unmatched" : states.has("adding") ? "adding" : "pending";
    return { ...group, orders, status, quantity: orders.reduce((sum, order) => sum + order.quantity, 0) };
  });
  return { ...scan, groups };
}

/** Applies an approval change to the visible snapshot without rescanning orders. */
function updateScanApproval(scan: StockPrepScan, buyerPrefix: string, approved: boolean): StockPrepScan {
  return {
    ...scan,
    groups: scan.groups.map((group) => ({
      ...group,
      orders: group.orders.map((order) => order.buyerPrefix !== buyerPrefix ? order : {
        ...order,
        approved,
        selectedByDefault: approved && order.state === "pending" && order.riskLevel !== "blacklist",
      }),
    })),
  };
}

/** Describes buyer-prefix multi-order review and explicit blacklist matches. */
function buyerRiskLabel(order: StockPrepScan["groups"][number]["orders"][number]): string {
  if (order.riskLevel === "blacklist") return "黑名单买家，禁止加购";
  if (order.riskLevel !== "review") return "";
  return order.approved ? "买家订单组已人工放行" : (order.currentOrderCount ?? 1) > 1 ? "同一买家有多笔待采购订单，需人工确认" : "该订单购买多件，需人工确认";
}

/** Lets operators review FBS/realFBS awaiting-packaging orders before adding them to 1688. */
export default function StockPrepPage(): React.JSX.Element {
  const client = useQueryClient();
  const storesQuery = useQuery({ queryKey: ["stores"], queryFn: fetchStores });
  const stores = (storesQuery.data ?? []).filter((store) => store.platform === "ozon" && store.enabled);
  const [storeId, setStoreId] = useState(() => window.localStorage.getItem(LAST_STORE_KEY) ?? "");
  const [sourceUrl, setSourceUrl] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [dropshipSupplierText, setDropshipSupplierText] = useState<string | null>(null);
  const [blacklistBuyerPrefix, setBlacklistBuyerPrefix] = useState("");
  const [blacklistReason, setBlacklistReason] = useState("");
  const [authorizationLink, setAuthorizationLink] = useState<{ url: string; qrCode: string } | null>(null);
  const [scan, setScan] = useState<StockPrepScan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preparingPosting, setPreparingPosting] = useState<string | null>(null);
  const [prepareErrors, setPrepareErrors] = useState<Record<string, string>>({});
  const [expandedHistoryBuyers, setExpandedHistoryBuyers] = useState<Set<string>>(new Set());
  const [riskDrawerTarget, setRiskDrawerTarget] = useState<{ buyerPrefix: string | null; postingNumber: string } | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<StockPrepTab>("action");
  const [scannedStoreId, setScannedStoreId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [actionFilter, setActionFilter] = useState<ActionFilter>("all");
  const [pendingFilter, setPendingFilter] = useState<PendingFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("deadline");
  const [batchPreviewKeys, setBatchPreviewKeys] = useState<StockPrepOrderKey[] | null>(null);
  const stateQuery = useQuery({ queryKey: ["stock-prep-state", storeId], queryFn: () => fetchStockPrepState(storeId), enabled: Boolean(storeId) });
  const blacklistQuery = useQuery({ queryKey: ["stock-prep-blacklist", storeId], queryFn: () => fetchStockPrepBlacklist(storeId), enabled: Boolean(storeId) && activeTab === "blacklist" });
  const fulfillmentQuery = useQuery({ queryKey: ["stock-prep-fulfillment", storeId], queryFn: () => fetchStockPrepFulfillmentPostings(storeId), enabled: Boolean(storeId) && (activeTab === "action" || activeTab === "added") });
  const connectionQuery = useQuery({ queryKey: ["stock-prep-connection"], queryFn: fetchStockPrepConnection, refetchInterval: (query) => query.state.data?.feishu.authorization?.state === "pending" ? 1500 : 15000 });
  const batchQuery = useQuery({ queryKey: ["stock-prep-batch", batchId], queryFn: () => fetchStockPrepBatch(batchId!), enabled: Boolean(batchId), refetchInterval: (query) => ["queued", "running"].includes(query.state.data?.status ?? "") ? 1000 : false });
  const saveMutation = useMutation({ mutationFn: () => saveStockPrepSource(storeId, sourceUrl.trim()), onSuccess: async () => { setScan(null); setScannedStoreId(null); setMessage("飞书 SKU 表已验证并保存"); await client.invalidateQueries({ queryKey: ["stock-prep-state", storeId] }); } });
  const scanMutation = useMutation({
    mutationFn: ({ targetStoreId, forceRefresh }: { targetStoreId: string; forceRefresh: boolean }) => scanStockPrep(targetStoreId, forceRefresh),
    onSuccess: (value) => {
      setScan(value);
      setScannedStoreId(value.storeId);
      setMessage(null);
      setSelected(new Set());
    },
    onError: (error) => setMessage(error.message),
  });
  const batchMutation = useMutation({ mutationFn: (keys: StockPrepOrderKey[]) => createStockPrepBatch(storeId, keys), onSuccess: async (value) => { setBatchPreviewKeys(null); setBatchId(value.id); setMessage("加购批次已启动"); await client.invalidateQueries({ queryKey: ["stock-prep-state", storeId] }); }, onError: (error) => setMessage(error.message) });
  const approveRiskMutation = useMutation({
    mutationFn: ({ buyerPrefix }: { buyerPrefix: string; keys: StockPrepOrderKey[] }) => approveStockPrepRiskOrder(storeId, buyerPrefix),
    onSuccess: (_result, { buyerPrefix, keys }) => {
      setScan((current) => current ? updateScanApproval(current, buyerPrefix, true) : current);
      setSelected((current) => new Set([...current, ...keys.map(keyOf)]));
      setMessage("订单已人工放行并选中，可撤回放行或取消选择");
    },
    onError: (error) => setMessage(error.message),
  });
  const revokeRiskMutation = useMutation({
    mutationFn: ({ buyerPrefix }: { buyerPrefix: string; keys: StockPrepOrderKey[] }) => revokeStockPrepRiskOrder(storeId, buyerPrefix),
    onSuccess: (_result, { buyerPrefix, keys }) => {
      setScan((current) => current ? updateScanApproval(current, buyerPrefix, false) : current);
      setSelected((current) => {
        const next = new Set(current);
        for (const key of keys) next.delete(keyOf(key));
        return next;
      });
      setMessage("已撤回人工放行；该订单恢复为需确认状态");
    },
    onError: (error) => setMessage(error.message),
  });
  const addBlacklistMutation = useMutation({ mutationFn: () => addStockPrepBlacklistBuyer(storeId, blacklistBuyerPrefix.trim(), blacklistReason.trim()), onSuccess: async () => { setBlacklistBuyerPrefix(""); setBlacklistReason(""); setMessage("买家已加入黑名单"); await client.invalidateQueries({ queryKey: ["stock-prep-blacklist", storeId] }); } , onError: (error) => setMessage(error.message) });
  const addOrderBuyerMutation = useMutation({ mutationFn: ({ postingNumber, reason }: { postingNumber: string; reason: string }) => addStockPrepOrderBuyerToBlacklist(storeId, postingNumber, reason), onSuccess: async () => { setRiskDrawerTarget(null); setMessage("该发货单对应买家已加入黑名单；重新扫描后会被拦截"); await client.invalidateQueries({ queryKey: ["stock-prep-blacklist", storeId] }); setScan(null); setScannedStoreId(null); }, onError: (error) => setMessage(error.message) });
  const updateBlacklistMutation = useMutation({ mutationFn: ({ id, status }: { id: string; status: "active" | "inactive" }) => updateStockPrepBlacklistEntry(storeId, id, status), onSuccess: async () => { setMessage("黑名单状态已更新"); await client.invalidateQueries({ queryKey: ["stock-prep-blacklist", storeId] }); setScan(null); setScannedStoreId(null); } });
  const resetMutation = useMutation({ mutationFn: (keys: StockPrepOrderKey[]) => resetStockPrepOrders(storeId, keys), onSuccess: (result, keys) => { setMessage(`已撤回 ${result.resetCount} 条明细的 GMV 状态；1688 购物车数量未变`); setScan((current) => { if (!current) return current; return updateScanOrders(current, keys, "pending"); }); setSelected(new Set()); }, onError: (error) => setMessage(error.message) });
  const markAddedMutation = useMutation({ mutationFn: (keys: StockPrepOrderKey[]) => markStockPrepOrdersAdded(storeId, keys), onSuccess: (result, keys) => { setScan((current) => current ? updateScanOrders(current, keys, "added", "人工确认已加入1688购物车") : current); setSelected(new Set()); setMessage(`已人工标记 ${result.markedCount} 条SKU明细为已加购`); }, onError: (error) => setMessage(error.message) });
  const preparePostingMutation = useMutation({ mutationFn: async (postingNumbers: string[]) => { let completed = 0; const errors: Record<string, string> = {}; for (const postingNumber of postingNumbers) { setPreparingPosting(postingNumber); setPrepareErrors((current) => { const next = { ...current }; delete next[postingNumber]; return next; }); try { await prepareStockPrepPosting(storeId, postingNumber); completed += 1; } catch (error) { errors[postingNumber] = error instanceof Error ? error.message : "Ozon备货失败"; } } return { completed, errors, total: postingNumbers.length }; }, onSuccess: async ({ completed, errors, total }) => { setPreparingPosting(null); setPrepareErrors((current) => ({ ...current, ...errors })); setSelected(new Set()); setMessage(Object.keys(errors).length ? `备货提交完成：成功 ${completed}/${total} 单；失败原因已显示在对应订单行` : `已提交 ${completed} 单 Ozon 备货，并进入等待发运`); await client.invalidateQueries({ queryKey: ["stock-prep-fulfillment", storeId] }); }, onError: (error) => { setPreparingPosting(null); setMessage(error.message); } });
  const feishuAppMutation = useMutation({ mutationFn: () => saveStockPrepFeishuApp(appId, appSecret), onSuccess: async () => { setAppSecret(""); setMessage("飞书应用凭证已加密保存"); await client.invalidateQueries({ queryKey: ["stock-prep-connection"] }); }, onError: (error) => setMessage(error.message) });
  const dropshipSuppliersMutation = useMutation({ mutationFn: () => saveStockPrepDropshipSuppliers((dropshipSupplierText ?? connection?.dropshipSuppliers.join("\n") ?? "").split(/\r?\n/u)), onSuccess: async ({ suppliers }) => { setDropshipSupplierText(suppliers.join("\n")); setMessage("代发供应商名单已保存"); await client.invalidateQueries({ queryKey: ["stock-prep-connection"] }); }, onError: (error) => setMessage(error.message) });
  const feishuAuthMutation = useMutation({ mutationFn: beginStockPrepFeishuAuthorization, onSuccess: (value) => { setAuthorizationLink({ url: value.verificationUrl, qrCode: value.qrCode }); setMessage("已发起飞书设备授权，请用当前飞书账号扫码或打开链接确认"); void client.invalidateQueries({ queryKey: ["stock-prep-connection"] }); }, onError: (error) => setMessage(error.message) });
  const source = stateQuery.data?.source;
  const lastOrderSyncAt = scan?.lastOrderSyncAt ?? stateQuery.data?.lastOrderSyncAt ?? null;
  const latestBatch = stateQuery.data?.latestBatch;
  const lastBatch = batchQuery.data ?? latestBatch;
  const displayBatch = lastBatch && ["queued", "running"].includes(lastBatch.status) ? lastBatch : null;
  const completedBatch = lastBatch && ["completed", "completed_with_errors"].includes(lastBatch.status) ? lastBatch : null;
  const loadingMessage = storesQuery.isLoading ? "正在读取 Ozon 店铺…" : stateQuery.isLoading ? "正在读取店铺配置…" : scanMutation.isPending ? "正在扫描待打包订单并匹配 SKU…" : null;
  const connection = connectionQuery.data;
  const groups = scan?.groups ?? [];
  const riskDrawerOrders = useMemo(() => {
    if (!riskDrawerTarget) return [];
    return groups.flatMap((group) => group.orders).filter((order) => order.state !== "added" && (riskDrawerTarget.buyerPrefix
      ? order.buyerPrefix === riskDrawerTarget.buyerPrefix
      : order.postingNumber === riskDrawerTarget.postingNumber));
  }, [groups, riskDrawerTarget]);
  const pendingGroups = useMemo(() => groups.map((group) => { const orders = group.orders.filter((order) => order.state !== "added"); return { ...group, orders, quantity: orders.reduce((sum, order) => sum + order.quantity, 0) }; }).filter((group) => group.orders.length).sort((a, b) => Number(Boolean(b.skuId)) - Number(Boolean(a.skuId))), [groups]);
  const addedGroups = useMemo(() => groups.map((group) => { const orders = group.orders.filter((order) => order.state === "added"); return { ...group, orders, quantity: orders.reduce((sum, order) => sum + order.quantity, 0) }; }).filter((group) => group.orders.length), [groups]);
  const pendingOrderCount = new Set(pendingGroups.flatMap((group) => group.orders.map((order) => order.postingNumber))).size;
  const pendingPieceCount = pendingGroups.reduce((sum, group) => sum + group.quantity, 0);
  const addedOrderCount = new Set(addedGroups.flatMap((group) => group.orders.map((order) => order.postingNumber))).size;
  const addedPieceCount = addedGroups.reduce((sum, group) => sum + group.quantity, 0);
  const addedOrders = useMemo(() => addedGroups.flatMap((group) => group.orders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId }))), [addedGroups]);
  const pendingEntries = useMemo(() => pendingGroups.flatMap((group) => group.orders.map((order) => ({ group, order, key: { postingNumber: order.postingNumber, offerId: order.offerId } }))), [pendingGroups]);
  const addedEntries = useMemo(() => addedGroups.flatMap((group) => group.orders.map((order) => ({ group, order, key: { postingNumber: order.postingNumber, offerId: order.offerId } }))), [addedGroups]);
  const postingByNumber = useMemo(() => new Map((fulfillmentQuery.data?.postings ?? []).map((posting) => [posting.posting_number, posting])), [fulfillmentQuery.data]);
  const selectablePendingEntries = useMemo(() => pendingEntries.filter(({ group, order }) => {
    if (["failed", "uncertain"].includes(order.state)) return true;
    return order.state === "pending" && Boolean(group.skuId) && order.riskLevel !== "blacklist" && (order.riskLevel !== "review" || order.approved === true);
  }), [pendingEntries]);
  const selectedPendingEntries = selectablePendingEntries.filter(({ key }) => selected.has(keyOf(key)));
  const cartEntries = selectedPendingEntries.filter(({ group, order }) => ["pending", "failed"].includes(order.state) && Boolean(group.skuId) && order.riskLevel !== "blacklist" && (order.riskLevel !== "review" || order.approved === true));
  const markAddedEntries = selectedPendingEntries.filter(({ group, order }) => ["pending", "failed", "uncertain"].includes(order.state) && Boolean(group.skuId) && order.riskLevel !== "blacklist" && (order.riskLevel !== "review" || order.approved === true));
  const resetPendingEntries = selectedPendingEntries.filter(({ order }) => ["failed", "uncertain"].includes(order.state));
  const allPendingSelected = selectablePendingEntries.length > 0 && selectedPendingEntries.length === selectablePendingEntries.length;
  const selectedAddedOrders = addedOrders.filter((order) => selected.has(keyOf(order)));
  const allAddedSelected = addedOrders.length > 0 && selectedAddedOrders.length === addedOrders.length;
  const selectedCount = activeTab === "added" ? selectedAddedOrders.length : selectedPendingEntries.length;
  const selectedQuantity = activeTab === "added"
    ? addedGroups.flatMap((group) => group.orders).filter((order) => selected.has(keyOf(order))).reduce((total, order) => total + order.quantity, 0)
    : selectedPendingEntries.reduce((total, { order }) => total + order.quantity, 0);
  const pendingSummary = useMemo(() => {
    const summarize = (summaryGroups: typeof pendingGroups) => ({
      groupCount: summaryGroups.length,
      orderCount: new Set(summaryGroups.flatMap((group) => group.orders.map((order) => order.postingNumber))).size,
      pieceCount: summaryGroups.reduce((sum, group) => sum + group.quantity, 0),
    });
    const grouped = new Map<string, typeof pendingGroups>();
    for (const group of pendingGroups) grouped.set(group.status, [...(grouped.get(group.status) ?? []), group]);
    const preferredOrder = ["pending", "unmatched", "failed", "uncertain", "adding"];
    const rank = (status: string): number => { const index = preferredOrder.indexOf(status); return index === -1 ? preferredOrder.length : index; };
    const statuses = [...grouped.entries()].map(([status, statusGroups]) => ({ status, ...summarize(statusGroups) }))
      .sort((left, right) => rank(left.status) - rank(right.status));
    return { total: summarize(pendingGroups), statuses };
  }, [pendingGroups]);
  const riskOrders = useMemo(() => {
    const byBuyer = new Map<string, { order: StockPrepScan["groups"][number]["orders"][number]; items: StockPrepScan["groups"][number]["orders"] }>();
    for (const order of pendingGroups.flatMap((group) => group.orders)) {
      if (order.riskLevel === "none" || (order.approved && order.riskLevel !== "blacklist")) continue;
      const buyerKey = order.buyerPrefix ?? `发货单 ${order.postingNumber}`;
      const entry = byBuyer.get(buyerKey);
      if (entry) entry.items.push(order);
      else byBuyer.set(buyerKey, { order, items: [order] });
    }
    return [...byBuyer.values()];
  }, [pendingGroups]);
  const actionIssues = useMemo(() => {
    const issues: Array<{ type: Exclude<ActionFilter, "all" | "risk">; group: typeof pendingGroups[number]; order: typeof pendingGroups[number]["orders"][number]; key: StockPrepOrderKey; title: string; reason: string; step: string }> = [];
    for (const entry of pendingEntries) {
      if ((entry.order.riskLevel !== "none" && !entry.order.approved) || entry.order.riskLevel === "blacklist") continue;
      if (entry.order.state === "unmatched" || !entry.group.skuId) issues.push({ ...entry, type: "mapping", title: "SKU 映射异常", reason: entry.order.error ?? entry.group.error ?? "未找到有效 SKU 映射", step: "修正飞书映射后刷新订单" });
      else if (entry.order.state === "failed") issues.push({ ...entry, type: "failed", title: "1688 加购失败", reason: entry.order.error ?? "加购未执行成功", step: "检查原因后安全重试" });
      else if (entry.order.state === "uncertain") issues.push({ ...entry, type: "uncertain", title: "加购结果待核实", reason: entry.order.error ?? "购物车增量无法确认", step: "确认购物车后标记或撤回" });
    }
    for (const entry of addedEntries) {
      const posting = postingByNumber.get(entry.order.postingNumber);
      const reason = prepareErrors[entry.order.postingNumber] ?? (posting?.status === "awaiting_packaging" && !posting.can_prepare ? posting.prepare_block_reason : null);
      if (reason) issues.push({ ...entry, type: "ozon", title: "Ozon 备货待处理", reason, step: "在已加购中处理备货" });
    }
    return issues.sort((left, right) => (left.order.shipmentDeadlineAt ?? Number.MAX_SAFE_INTEGER) - (right.order.shipmentDeadlineAt ?? Number.MAX_SAFE_INTEGER));
  }, [pendingEntries, addedEntries, postingByNumber, prepareErrors]);
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredRiskOrders = riskOrders.filter(({ order, items }) => (actionFilter === "all" || actionFilter === "risk") && (!normalizedSearch || [order.buyerPrefix ?? "", ...items.flatMap((item) => [item.postingNumber, item.offerId, item.productName])].some((value) => value.toLowerCase().includes(normalizedSearch))));
  const filteredActionIssues = actionIssues.filter((issue) => (actionFilter === "all" || actionFilter === issue.type) && (!normalizedSearch || [issue.order.postingNumber, issue.order.offerId, issue.order.productName, issue.group.skuId ?? ""].some((value) => value.toLowerCase().includes(normalizedSearch))));
  const actionCount = riskOrders.length + actionIssues.length;
  const visiblePendingGroups = useMemo(() => {
    const result = pendingGroups.flatMap((group) => {
      if (pendingFilter !== "all" && !group.orders.some((order) => order.state === pendingFilter)) return [];
      const orders = group.orders.filter((order) => !normalizedSearch || [order.postingNumber, order.offerId, order.productName, group.skuId ?? ""].some((value) => value.toLowerCase().includes(normalizedSearch)));
      return orders.length ? [{ ...group, orders, quantity: orders.reduce((sum, order) => sum + order.quantity, 0) }] : [];
    });
    return result.sort((left, right) => sortMode === "offer" ? left.offerId.localeCompare(right.offerId, "zh-CN", { numeric: true }) : Math.min(...left.orders.map((order) => order.shipmentDeadlineAt ?? Number.MAX_SAFE_INTEGER)) - Math.min(...right.orders.map((order) => order.shipmentDeadlineAt ?? Number.MAX_SAFE_INTEGER)));
  }, [pendingGroups, pendingFilter, normalizedSearch, sortMode]);
  const visibleAddedGroups = useMemo(() => addedGroups.flatMap((group) => { const orders = group.orders.filter((order) => !normalizedSearch || [order.postingNumber, order.offerId, order.productName, group.skuId ?? ""].some((value) => value.toLowerCase().includes(normalizedSearch))); return orders.length ? [{ ...group, orders, quantity: orders.reduce((sum, order) => sum + order.quantity, 0) }] : []; }).sort((left, right) => sortMode === "offer" ? left.offerId.localeCompare(right.offerId, "zh-CN", { numeric: true }) : Math.min(...left.orders.map((order) => order.shipmentDeadlineAt ?? Number.MAX_SAFE_INTEGER)) - Math.min(...right.orders.map((order) => order.shipmentDeadlineAt ?? Number.MAX_SAFE_INTEGER))), [addedGroups, normalizedSearch, sortMode]);
  const previewEntries = batchPreviewKeys ? pendingEntries.filter(({ key }) => batchPreviewKeys.some((previewKey) => keyOf(previewKey) === keyOf(key))) : [];

  useEffect(() => { if (source && !sourceUrl) setSourceUrl(source.url); }, [source, sourceUrl]);
  useEffect(() => {
    if (!stores.length) return;
    if (storeId && stores.some((store) => store.id === storeId)) return;
    const remembered = window.localStorage.getItem(LAST_STORE_KEY);
    setStoreId(remembered && stores.some((store) => store.id === remembered) ? remembered : stores[0]!.id);
  }, [stores, storeId]);
  useEffect(() => {
    if (storeId) window.localStorage.setItem(LAST_STORE_KEY, storeId);
  }, [storeId]);
  useEffect(() => {
    if (!storeId || scan || scanMutation.isPending || scannedStoreId === storeId) return;
    if (!source) return;
    scanMutation.mutate({ targetStoreId: storeId, forceRefresh: false });
  }, [storeId, source, scan, scanMutation.isPending, scannedStoreId]);
  useEffect(() => { if (latestBatch && ["queued", "running"].includes(latestBatch.status)) setBatchId(latestBatch.id); }, [latestBatch]);
  useEffect(() => {
    const auth = connection?.feishu.authorization;
    if (!authorizationLink || !auth || auth.state === "pending") return;
    setMessage(auth.state === "complete" ? "飞书授权完成" : auth.message ?? "飞书授权失败");
    void connectionQuery.refetch();
  }, [connection?.feishu.authorization?.state]);
  useEffect(() => {
    if (batchQuery.data && ["completed", "completed_with_errors"].includes(batchQuery.data.status)) {
      void client.invalidateQueries({ queryKey: ["stock-prep-state", storeId] });
      const itemStates = batchQuery.data.items.flatMap((item) => {
        if (!item.order_keys_json) return [];
        const state = item.status === "added" ? "added" : item.status === "uncertain" ? "uncertain" : "failed";
        return (JSON.parse(item.order_keys_json) as string[]).map((key) => ({ key, state, error: item.error }));
      });
      setSelected(new Set());
      setScan((current) => {
        if (!current) return current;
        let updated = current;
        for (const item of itemStates) {
          const [postingNumber, offerId] = item.key.split("\u0000");
          if (postingNumber && offerId) updated = updateScanOrders(updated, [{ postingNumber, offerId }], item.state, item.error);
        }
        return updated;
      });
    }
  }, [batchQuery.data?.status]);

  function toggleOrder(key: StockPrepOrderKey, checked: boolean): void {
    setSelected((current) => { const next = new Set(current); const id = keyOf(key); if (checked) next.add(id); else next.delete(id); return next; });
  }

  /** Updates the single selection model used by every bulk action in the active tab. */
  function toggleOrders(keys: StockPrepOrderKey[], checked: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      for (const key of keys) checked ? next.add(keyOf(key)) : next.delete(keyOf(key));
      return next;
    });
  }

  /** Rebuilds the single selection model for the workflow shown in the active tab. */
  function switchTab(tab: StockPrepTab): void {
    setActiveTab(tab);
    setSearchQuery("");
    if (tab === "added") {
      const readyPostings = new Set((fulfillmentQuery.data?.postings ?? []).filter((posting) => posting.can_prepare).map((posting) => posting.posting_number));
      setSelected(new Set(addedOrders.filter((order) => readyPostings.has(order.postingNumber)).map(keyOf)));
      return;
    }
    if (tab === "pending") {
      setSelected(new Set(pendingGroups.flatMap((group) => group.orders.filter((order) => order.selectedByDefault).map(keyOf))));
      return;
    }
    setSelected(new Set());
  }

  function riskOrderKeys(buyerPrefix: string | null, postingNumber: string, states: string[] = ["pending"]): StockPrepOrderKey[] {
    return groups.flatMap((group) => group.orders
      .filter((order) => (buyerPrefix ? order.buyerPrefix === buyerPrefix : order.postingNumber === postingNumber) && states.includes(order.state))
      .map(({ postingNumber, offerId }) => ({ postingNumber, offerId })));
  }

  function submitCart(): void {
    const keys = cartEntries.map(({ key }) => key);
    if (keys.length) setBatchPreviewKeys(keys);
  }

  /** Resets GMV state immediately; the persistent action-bar hint explains that the 1688 cart is unchanged. */
  function resetOrders(keys: StockPrepOrderKey[]): void {
    if (keys.length) resetMutation.mutate(keys);
  }

  return <main className="admin-main stock-prep-main">
      <div className="page-title-row stock-prep-title"><div><p className="eyebrow">STOCK PREPARATION</p><h2>采购备货</h2><p>扫描待打包订单，按 1688 规格汇总后人工确认加入采购车。</p><small className="stock-prep-cache-hint">最近订单同步：{formatSyncTimestamp(lastOrderSyncAt)}；缓存有效 1 小时，需要最新订单时可手动刷新。</small></div><div className="stock-prep-store-picker"><label className="field"><span>Ozon 店铺</span><select aria-label="Ozon 店铺" value={storeId} onChange={(event) => { const nextStoreId = event.target.value; setStoreId(nextStoreId); setSourceUrl(""); setScan(null); setScannedStoreId(null); setSelected(new Set()); setBatchId(null); setRiskDrawerTarget(null); }}><option value="">选择店铺</option>{stores.map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select></label><button className="secondary-button" type="button" disabled={!storeId || scanMutation.isPending || !source} onClick={() => scanMutation.mutate({ targetStoreId: storeId, forceRefresh: true })}><RefreshCw size={16} className={scanMutation.isPending ? "sync-spinner" : undefined}/>{scanMutation.isPending ? "正在扫描…" : "刷新订单"}</button></div></div>
      {message && <div className="notice notice--success" role="status">{message}</div>}
      {storesQuery.isError && <div className="field-error" role="alert">{storesQuery.error.message}</div>}
      <nav className="stock-prep-tabs" aria-label="采购备货页面"><button className={activeTab === "action" ? "is-active" : ""} onClick={() => switchTab("action")} type="button">需要处理{scan ? ` · ${actionCount}` : ""}</button><button className={activeTab === "pending" ? "is-active" : ""} onClick={() => switchTab("pending")} type="button">待采购{scan ? ` · ${pendingOrderCount} 单 · ${pendingPieceCount} 件` : ""}</button><button className={activeTab === "added" ? "is-active" : ""} onClick={() => switchTab("added")} type="button">已加购{scan ? ` · ${addedOrderCount} 单 · ${addedPieceCount} 件` : ""}</button><button className={activeTab === "blacklist" ? "is-active" : ""} onClick={() => switchTab("blacklist")} type="button">买家黑名单</button><button className={activeTab === "config" ? "is-active" : ""} onClick={() => switchTab("config")} type="button">配置</button></nav>
      {activeTab !== "config" && loadingMessage && <section className="stock-prep-loading" role="status" aria-live="polite" aria-busy="true"><RefreshCw size={22} className="sync-spinner"/><div><strong>{loadingMessage}</strong><small>页面加载完成后会显示订单和匹配结果，请稍候。</small></div></section>}
      {["action", "pending", "added"].includes(activeTab) && scan && <section className="stock-prep-workflow-toolbar"><label><Search size={16}/><input aria-label="搜索采购订单" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索发货单、货号、商品或 SKU"/></label>{activeTab === "action" && <select aria-label="处理类型" value={actionFilter} onChange={(event) => setActionFilter(event.target.value as ActionFilter)}><option value="all">全部异常</option><option value="risk">风险确认</option><option value="mapping">映射异常</option><option value="failed">加购失败</option><option value="uncertain">待核实</option><option value="ozon">Ozon 备货</option></select>}{activeTab === "pending" && <select aria-label="采购状态" value={pendingFilter} onChange={(event) => setPendingFilter(event.target.value as PendingFilter)}><option value="all">全部状态</option><option value="pending">待采购</option><option value="unmatched">映射异常</option><option value="failed">加购失败</option><option value="uncertain">待核实</option></select>}<select aria-label="排序方式" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}><option value="deadline">按发货时限</option><option value="offer">按货号</option></select></section>}
      {activeTab === "blacklist" && <section className="settings-card stock-prep-blacklist"><header><div><p className="eyebrow">BUYER BLACKLIST</p><h3>买家黑名单</h3><p>按店铺和 Ozon 发货单号第一段数字匹配；生效名单会拦截该买家的所有待采购单。AI Agent 提交的记录先进入待审核。</p></div></header><div className="stock-prep-blacklist-form"><label className="field"><span>买家编号（订单号首段）</span><input inputMode="numeric" value={blacklistBuyerPrefix} onChange={(event) => setBlacklistBuyerPrefix(event.target.value)} placeholder="例如：16548296"/></label><label className="field"><span>加入原因</span><input value={blacklistReason} onChange={(event) => setBlacklistReason(event.target.value)} placeholder="简要说明风险原因"/></label><button className="primary-button" type="button" disabled={!/^\d{3,30}$/u.test(blacklistBuyerPrefix.trim()) || !blacklistReason.trim() || addBlacklistMutation.isPending} onClick={() => addBlacklistMutation.mutate()}>{addBlacklistMutation.isPending ? "正在保存…" : "加入生效黑名单"}</button></div>{blacklistQuery.isLoading ? <p>正在读取名单…</p> : blacklistQuery.isError ? <div className="field-error">{blacklistQuery.error.message}</div> : <div className="stock-prep-blacklist-list">{(blacklistQuery.data ?? []).length === 0 ? <p>当前店铺还没有黑名单记录。</p> : blacklistQuery.data!.map((entry) => <article key={entry.id}><div><strong>{entry.buyerPrefix ?? "旧版记录，需重新录入"}</strong><span className={`stock-prep-blacklist-status stock-prep-blacklist-status--${entry.status}`}>{entry.status === "active" ? "生效中" : entry.status === "candidate" ? "待审核" : "已停用"}</span><p>{entry.summary || entry.reason_code} · 来源：{entry.source === "agent" ? "AI Agent" : entry.source === "order" ? "订单操作" : "手动"}</p>{entry.evidenceOrders.length > 0 && <small>关联发货单：{entry.evidenceOrders.join("、")}</small>}</div>{!entry.buyerPrefix ? <small>请按订单号首段重新添加</small> : entry.status === "candidate" ? <button className="primary-button compact-button" type="button" disabled={updateBlacklistMutation.isPending} onClick={() => updateBlacklistMutation.mutate({ id: entry.id, status: "active" })}>审核并生效</button> : entry.status === "active" ? <button className="secondary-button compact-button" type="button" disabled={updateBlacklistMutation.isPending} onClick={() => updateBlacklistMutation.mutate({ id: entry.id, status: "inactive" })}>停用</button> : <button className="secondary-button compact-button" type="button" disabled={updateBlacklistMutation.isPending} onClick={() => updateBlacklistMutation.mutate({ id: entry.id, status: "active" })}>重新启用</button>}</article>)}</div>}</section>}
      {activeTab === "config" && <>
      <section className="settings-card stock-prep-connection">
        <div className="stock-prep-connection-title"><div><p className="eyebrow">CONNECTIONS</p><h3>连接状态</h3></div><button className="secondary-button" type="button" onClick={() => void connectionQuery.refetch()}>刷新状态</button></div>
        <div className="stock-prep-health"><span className={connection?.feishu.connected ? "is-ready" : ""}><i/>{connection?.feishu.connected ? `飞书已授权 · ${connection.feishu.userName ?? connection.feishu.profile}` : connection?.feishu.message ?? "正在检查飞书…"}</span><span className={connection?.browserBridge.ready ? "is-ready" : ""}><i/>{connection?.browserBridge.ready ? "Browser Bridge 已连接" : connection?.browserBridge.message ?? "正在检查 Browser Bridge…"}</span><span><i/>{`已配置 ${connection?.configuredStoreCount ?? 0} 家店铺 SKU 表`}</span></div>
        {connection?.platform === "win32" && <div className="stock-prep-feishu-config"><p>Windows 服务账户需使用飞书自建应用授权多维表格。App Secret 只写入加密存储，不会回显。</p><label className="field"><span>飞书 App ID</span><input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="cli_…" autoComplete="off"/></label><label className="field"><span>飞书 App Secret</span><input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} placeholder={connection.feishu.appSecretConfigured ? "已配置；留空不修改" : "粘贴 App Secret"} autoComplete="new-password"/></label><div className="stock-prep-actions"><button className="secondary-button" type="button" disabled={!appId.trim() || !appSecret.trim() || feishuAppMutation.isPending} onClick={() => feishuAppMutation.mutate()}>加密保存应用凭证</button><button className="primary-button" type="button" disabled={!connection.feishu.appSecretConfigured || feishuAuthMutation.isPending || connection.feishu.connected} onClick={() => feishuAuthMutation.mutate()}>{feishuAuthMutation.isPending ? "正在发起…" : "使用飞书设备授权"}</button></div></div>}
        {connection?.platform !== "win32" && connection?.feishu.profile && !connection.feishu.connected && <button className="secondary-button" type="button" disabled={feishuAuthMutation.isPending} onClick={() => feishuAuthMutation.mutate()}>重新授权飞书用户身份</button>}
        {authorizationLink && <div className="stock-prep-auth"><img src={authorizationLink.qrCode} alt="飞书授权二维码"/><div><p>请使用要连接的飞书账号完成授权，授权范围为多维表格。</p><a href={authorizationLink.url} target="_blank" rel="noreferrer">打开飞书授权链接</a><p>{connection?.feishu.authorization?.message ?? "等待授权完成…"}</p>{connection?.feishu.authorization?.state === "complete" && <strong className="stock-prep-auth-success">授权完成，连接状态已刷新</strong>}{connection?.feishu.authorization?.state === "failed" && <strong className="field-error">授权失败，请重试</strong>}</div></div>}
      </section>
      <section className="stock-prep-setup settings-card">
        <label className="field stock-prep-url"><span>飞书 SKU 映射表</span><input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder={source?.url ?? "粘贴 YOGOLD SKU 库链接"} /><small>{source ? "已验证映射表；保存新链接会重新校验字段。" : "需包含货号、1688商品链接、1688 SKU ID 三个文本字段。"}</small></label>
        <div className="stock-prep-actions"><button className="secondary-button" type="button" disabled={!storeId || !sourceUrl.trim() || saveMutation.isPending} onClick={() => saveMutation.mutate()}><Link2 size={16}/>{saveMutation.isPending ? "正在验证…" : "验证并保存表格"}</button></div>
        <div className="stock-prep-health"><span className={connection?.feishu.connected ? "is-ready" : ""}><i/>飞书 {connection?.feishu.connected ? "已连接" : "未连接"}</span><span className={source ? "is-ready" : ""}><i/>店铺 SKU 表 {source ? "已配置" : "未配置"}</span><span className={connection?.browserBridge.ready ? "is-ready" : ""}><i/>{connection?.browserBridge.ready ? "Browser Bridge 已连接" : "Browser Bridge 未连接"}</span></div>
      </section>
      <section className="stock-prep-setup settings-card">
        <label className="field stock-prep-url"><span>1688 代发供应商名单</span><textarea rows={5} value={dropshipSupplierText ?? connection?.dropshipSuppliers.join("\n") ?? ""} onChange={(event) => setDropshipSupplierText(event.target.value)} placeholder={"每行填写一家，例如：\n安丘市鑫达尔服装厂\n其他供应商名称"}/><small>每行一家，不要用逗号分隔；空行忽略，重复项自动去重。最多 100 家，每个名称不超过 120 个字符。按商品页识别到的店铺名称匹配。</small></label>
        <div className="stock-prep-actions"><button className="secondary-button" type="button" disabled={dropshipSuppliersMutation.isPending} onClick={() => dropshipSuppliersMutation.mutate()}>{dropshipSuppliersMutation.isPending ? "正在保存…" : "保存代发供应商名单"}</button></div>
      </section>
      </>}
      {batchMutation.isPending && <section className="stock-prep-loading stock-prep-loading--preflight" role="status" aria-live="polite" aria-busy="true"><RefreshCw size={22} className="sync-spinner"/><div><strong>正在校验所选订单和飞书 SKU 映射…</strong><small>确认订单仍待备货、货号映射有效后才会启动 1688 操作。</small></div></section>}
      {activeTab !== "config" && displayBatch && <section className="settings-card stock-prep-batch"><div><strong>加购进度：{statusNames[String(displayBatch.status)] ?? displayBatch.status}</strong><span>{displayBatch.completed_count}/{displayBatch.total_count} 个 SKU 组</span></div><progress max={Math.max(displayBatch.total_count, 1)} value={displayBatch.completed_count}/>{displayBatch.items.find((item) => item.status === "running") && <p>当前商品：{displayBatch.items.find((item) => item.status === "running")!.offer_id} · SKU {displayBatch.items.find((item) => item.status === "running")!.sku_id}</p>}</section>}
      {activeTab === "action" && scan && <>
        {scan.buyerHistorySync && ["running", "failed"].includes(String(scan.buyerHistorySync.state)) && <div className={`stock-prep-history-notice stock-prep-history-notice--${String(scan.buyerHistorySync.state)}`}>
          {String(scan.buyerHistorySync.state) === "running"
            ? "买家近一年历史正在后台增量同步，当前摘要会在下次扫描时更新；不影响采购列表操作。"
            : `买家历史同步失败：${String(scan.buyerHistorySync.error ?? "原因未知")}；当前订单与黑名单拦截仍可使用。`}
        </div>}
        {filteredRiskOrders.length > 0 && <section className="settings-card stock-prep-risk-review">
          <header><div><p className="eyebrow">BUYER RISK</p><h3>买家风险待确认</h3></div><span>{filteredRiskOrders.length} 个买家组</span></header>
          <div className="stock-prep-risk-list">{filteredRiskOrders.map(({ order, items }) => {
            const prefix = order.buyerPrefix;
            const historyKey = prefix ?? order.postingNumber;
            const keys = riskOrderKeys(prefix ?? null, order.postingNumber);
            const history = order.buyerHistory ?? { syncState: "not_started" as const, syncError: null, ordersInYear: 0, deliveredOrders: 0, cancelledOrders: 0, refusalOrders: 0, returnCount: 0, returnedPieces: 0, latestOutcome: null, latestAt: null, orderSequenceByPostingNumber: {}, recentOrders: [] };
            const historyExpanded = expandedHistoryBuyers.has(historyKey);
            return <article className={`stock-prep-risk-card stock-prep-risk-card--${order.riskLevel ?? "none"}`} key={historyKey}>
              <div className="stock-prep-risk-content">
                <div className="stock-prep-risk-heading"><div><strong>买家编号：{prefix ?? "无法识别"}</strong><p>{order.currentOrderCount ?? 1} 笔待备货 · {items.reduce((sum, item) => sum + item.quantity, 0)} 件</p><small>{buyerRiskLabel(order)}</small></div></div>
                <div className="stock-prep-risk-history">
                  <div className="stock-prep-risk-history-summary">
                    <strong>近一年历史 · {buyerHistoryStateLabel(history.syncState)}</strong>
                    <span>{history.ordersInYear} 笔订单</span><span>签收 {history.deliveredOrders}</span><span>取消 {history.cancelledOrders}</span><span>拒收 {history.refusalOrders}</span><span>退货 {history.returnCount} 次 / {history.returnedPieces} 件</span>
                    {history.latestOutcome && <span>最近：{localizedHistoryOutcome(history.latestOutcome)}{history.latestAt ? ` · ${new Date(history.latestAt).toLocaleDateString("zh-CN")}` : ""}</span>}
                    {history.recentOrders.length > 0 && <button className="secondary-button compact-button" type="button" aria-expanded={historyExpanded} onClick={() => setExpandedHistoryBuyers((current) => { const next = new Set(current); if (next.has(historyKey)) next.delete(historyKey); else next.add(historyKey); return next; })}>{historyExpanded ? "收起历史明细" : "查看历史明细"}</button>}
                  </div>
                  {history.syncState === "failed" && history.syncError && <small className="field-error">失败原因：{history.syncError}</small>}
                  {historyExpanded && <div className="stock-prep-risk-history-list">{history.recentOrders.map((historic) => <div key={historic.postingNumber}>
                    <strong>{historic.postingNumber}</strong><span>{localizedOzonStatus(historic.status)} · {new Date(historic.orderAt).toLocaleDateString("zh-CN")}{historic.cancellationInitiator ? ` · 发起方 ${historic.cancellationInitiator}` : ""}{historic.cancellationType ? ` · ${historic.cancellationType}` : ""}</span>
                    {historic.returns.map((item, index) => <small key={`${item.type}-${index}`}>退货 {item.type} · {item.reason ?? "原因未提供"} · {item.status ?? "状态未知"} · {item.quantity} 件</small>)}
                  </div>)}</div>}
                </div>
                <div className="stock-prep-risk-items">{items.map((item) => <div className="stock-prep-risk-item" key={keyOf(item)}><OrderImagePreview src={item.imageUrl} alt={`${item.offerId} 商品图`} fallbackLabel="暂无商品图" width={42} height={42} className="stock-prep-risk-image" placeholderClassName="stock-prep-risk-image stock-prep-risk-image--empty"/><div><strong>{item.offerId}</strong><p>{item.productName}</p><small>{item.postingNumber} · 近一年第 {history.orderSequenceByPostingNumber[item.postingNumber] ?? "未知"} 次下单 · {item.quantity} 件 · {deadlineLabel(item.shipmentDeadlineAt)}</small></div></div>)}</div>
              </div>
              <div className="stock-prep-risk-controls"><button className="secondary-button compact-button" type="button" onClick={() => setRiskDrawerTarget({ buyerPrefix: prefix ?? null, postingNumber: order.postingNumber })}>查看风险详情</button>{order.riskLevel !== "blacklist" && prefix && <button className="primary-button compact-button" type="button" disabled={approveRiskMutation.isPending} onClick={() => approveRiskMutation.mutate({ buyerPrefix: prefix, keys })}>人工放行</button>}{order.approved && prefix && <button className="secondary-button compact-button" type="button" disabled={revokeRiskMutation.isPending} onClick={() => revokeRiskMutation.mutate({ buyerPrefix: prefix, keys })}>撤回放行</button>}{order.riskLevel !== "blacklist" && prefix && <button className="secondary-button compact-button" type="button" disabled={addOrderBuyerMutation.isPending} onClick={() => { const reason = window.prompt("填写加入黑名单的原因"); if (reason?.trim()) addOrderBuyerMutation.mutate({ postingNumber: order.postingNumber, reason: reason.trim() }); }}>加入黑名单</button>}</div>
            </article>;
          })}</div>
        </section>}
        {filteredActionIssues.length > 0 ? <section className="settings-card stock-prep-action-list"><header><div><p className="eyebrow">WORKFLOW EXCEPTIONS</p><h3>异常与人工决策</h3></div><span>{filteredActionIssues.length} 条</span></header>{filteredActionIssues.map((issue) => <article className={`stock-prep-action-item stock-prep-action-item--${issue.type}`} key={`${issue.type}-${keyOf(issue.key)}`}><OrderImagePreview src={issue.order.imageUrl} alt={`${issue.order.offerId} 商品图`} fallbackLabel="暂无商品图" width={52} height={52} className="stock-prep-product-image" placeholderClassName="stock-prep-product-image stock-prep-product-image--empty"/><div className="stock-prep-action-main"><div><span className="stock-prep-step-chip">{issue.title}</span><strong>{issue.order.postingNumber} · {issue.order.offerId}</strong><span className={`stock-prep-deadline ${issue.order.shipmentDeadlineAt && issue.order.shipmentDeadlineAt < Date.now() ? "is-overdue" : ""}`}><Clock3 size={14}/>{deadlineLabel(issue.order.shipmentDeadlineAt)}</span></div><p>{issue.order.productName}</p><small>{issue.reason}</small><em>下一步：{issue.step}</em></div><div className="stock-prep-action-controls">{issue.type === "uncertain" && <><button className="secondary-button compact-button" type="button" disabled={markAddedMutation.isPending} onClick={() => markAddedMutation.mutate([issue.key])}>标记已加购</button><button className="secondary-button compact-button" type="button" disabled={resetMutation.isPending} onClick={() => resetMutation.mutate([issue.key])}>撤回状态</button></>}{issue.type === "failed" && <button className="primary-button compact-button" type="button" onClick={() => setBatchPreviewKeys([issue.key])}>安全重试</button>}<button className="secondary-button compact-button" type="button" onClick={() => { if (issue.type === "ozon") { setActiveTab("added"); setSelected(new Set([keyOf(issue.key)])); } else { setActiveTab("pending"); setSelected(new Set([keyOf(issue.key)])); setPendingFilter(issue.type === "mapping" ? "unmatched" : issue.type); } }}>打开详情</button></div></article>)}</section> : filteredRiskOrders.length === 0 && <div className="empty-store-state"><Check size={34}/><h3>当前没有需要人工处理的事项</h3><p>正常待采购订单保留在“待采购”，不会混入异常列表。</p></div>}
      </>}
      {activeTab === "pending" && scan && <>
        <section className="stock-prep-summary"><button className={pendingFilter === "all" ? "is-active" : ""} type="button" onClick={() => setPendingFilter("all")}><PackageCheck size={19}/><span>全部待处理</span><strong>{pendingSummary.total.groupCount} 组</strong><small>{pendingSummary.total.orderCount} 张发货单 · {pendingSummary.total.pieceCount} 件</small></button>{pendingSummary.statuses.map((summary) => <button className={pendingFilter === summary.status ? "is-active" : ""} type="button" key={summary.status} onClick={() => setPendingFilter(summary.status as PendingFilter)}><span>{statusNames[summary.status] ?? summary.status}</span><strong>{summary.groupCount} 组</strong><small>{summary.orderCount} 张发货单 · {summary.pieceCount} 件</small></button>)}</section>
        <section className="stock-prep-bulk-actions" aria-label="待采购批量操作">
          <label className="stock-prep-select-all"><input type="checkbox" checked={allPendingSelected} disabled={!selectablePendingEntries.length} onChange={(event) => toggleOrders(selectablePendingEntries.map(({ key }) => key), event.target.checked)}/>全选可操作明细</label>
          <span className="stock-prep-selection-count">已选 {selectedCount} 条明细 · {selectedQuantity} 件</span>
          <div className="stock-prep-bulk-buttons">
            <button className="secondary-button" type="button" disabled={!resetPendingEntries.length || resetMutation.isPending} onClick={() => resetOrders(resetPendingEntries.map(({ key }) => key))}>{resetMutation.isPending ? "撤回中…" : `撤回状态 ${resetPendingEntries.length ? `(${resetPendingEntries.length})` : ""}`}</button>
            <button className="secondary-button" type="button" disabled={!markAddedEntries.length || markAddedMutation.isPending} onClick={() => { if (window.confirm("只修改 GMV 本地状态，不会操作 1688 购物车。确认这些订单已经加入采购车吗？")) markAddedMutation.mutate(markAddedEntries.map(({ key }) => key)); }}>{markAddedMutation.isPending ? "标记中…" : `人工标记已加购 ${markAddedEntries.length ? `(${markAddedEntries.length})` : ""}`}</button>
            <button className="primary-button" type="button" disabled={!cartEntries.length || batchMutation.isPending || ["queued","running"].includes(batchQuery.data?.status ?? "")} onClick={submitCart}><ShoppingCart size={17}/>{batchMutation.isPending ? "正在校验…" : `加入采购车 ${cartEntries.length ? `(${cartEntries.length})` : ""}`}</button>
          </div>
          <small>撤回只修改 GMV 状态，不会扣减 1688 购物车数量；再次加购会继续累加。不同操作只处理当前选中且符合条件的明细。</small>
        </section>
        <p className="field-hint">SKU 组按采购规格汇总；发货单按 Ozon 发货单号去重。同一张多商品发货单可能同时出现在不同状态中。</p>
        <div className="stock-prep-groups">{visiblePendingGroups.map((group, index) => <section className="settings-card stock-prep-group" key={`${group.offerUrl}-${group.skuId}-${index}`}>
          <header><div><p className="eyebrow">{statusNames[group.status] ?? group.status}</p><h3>{group.offerId} <small>· {group.orders.length} 单 · {group.quantity} 件待备</small></h3></div><span className={`stock-prep-state stock-prep-state--${group.status}`}>{statusNames[group.status] ?? group.status}</span>{group.offerUrl && <a href={group.offerUrl} target="_blank" rel="noreferrer">1688 商品</a>}</header>
          <div className="stock-prep-product"><OrderImagePreview src={group.imageUrl} alt={`${group.offerId} 商品主图`} fallbackLabel="暂无商品图" width={58} height={58} className="stock-prep-product-image" placeholderClassName="stock-prep-product-image stock-prep-product-image--empty"/><div>{group.skuId ? <p className="stock-prep-sku">1688 SKU ID：<code>{group.skuId}</code></p> : <p className="stock-prep-warning"><AlertTriangle size={16}/>{group.error}</p>}</div></div>
          <div className="table-scroll"><table className="stock-prep-orders"><thead><tr><th>选择</th><th>Ozon 发货单号</th><th>货号</th><th>商品</th><th>件数</th><th>发货时限</th><th>状态与风险</th><th>操作</th></tr></thead><tbody>{group.orders.map((order) => { const key = { postingNumber: order.postingNumber, offerId: order.offerId }; const approved = Boolean(order.approved); const blocked = order.riskLevel === "blacklist"; const reviewRequired = order.riskLevel === "review"; const selectable = ["failed", "uncertain"].includes(order.state) || (order.state === "pending" && Boolean(group.skuId) && !blocked && (!reviewRequired || approved)); const riskLabel = buyerRiskLabel(order); return <tr key={keyOf(key)}><td><input type="checkbox" checked={selected.has(keyOf(key))} disabled={!selectable} onChange={(event) => toggleOrder(key, event.target.checked)} aria-label={`选择订单 ${order.postingNumber}`}/></td><td>{order.postingNumber}</td><td>{order.offerId}</td><td>{order.productName}</td><td>{order.quantity}</td><td>{deadlineLabel(order.shipmentDeadlineAt)}</td><td>{statusNames[order.state] ?? order.state}{order.error ? ` · ${order.error}` : ""}{riskLabel ? ` · ${riskLabel}` : ""}</td><td>{(reviewRequired || blocked) && !approved ? <button className="secondary-button compact-button" type="button" onClick={() => setRiskDrawerTarget({ buyerPrefix: order.buyerPrefix ?? null, postingNumber: order.postingNumber })}>查看风险详情</button> : <span className="stock-prep-row-hint">使用上方批量操作</span>}</td></tr>; })}</tbody></table></div>
        </section>)}</div>
      </>}
      {activeTab === "added" && (() => {
        const postings = fulfillmentQuery.data?.postings ?? [];
        const addedPostingNumbers = new Set(addedGroups.flatMap((group) => group.orders.map((order) => order.postingNumber)));
        const visiblePostings = postings.filter((posting) => addedPostingNumbers.has(posting.posting_number));
        const readyPostings = visiblePostings.filter((posting) => posting.can_prepare);
        const manualPostings = visiblePostings.filter((posting) => posting.status === "awaiting_packaging" && !posting.can_prepare);
        const selectedPostingNumbers = new Set(selectedAddedOrders.map((order) => order.postingNumber));
        const selectedReadyPostings = readyPostings.filter((posting) => selectedPostingNumbers.has(posting.posting_number));
        const selectedAddedOrderCount = selectedPostingNumbers.size;

        return <>
          {fulfillmentQuery.isLoading && <p>正在读取 Ozon 发货单状态…</p>}
          {fulfillmentQuery.isError && <p className="field-error">{fulfillmentQuery.error.message}</p>}
          <section className="stock-prep-bulk-actions" aria-label="已加购批量操作">
            <label className="stock-prep-select-all">
              <input
                type="checkbox"
                checked={readyPostings.length > 0 && readyPostings.every((posting) => selectedPostingNumbers.has(posting.posting_number))}
                disabled={!readyPostings.length}
                onChange={(event) => toggleOrders(addedOrders.filter((order) => readyPostings.some((posting) => posting.posting_number === order.postingNumber)), event.target.checked)}
              />
              全选可提交备货明细
            </label>
            <span className="stock-prep-selection-count">已选 {selectedAddedOrders.length} 条明细 · {selectedAddedOrderCount} 单 · {selectedQuantity} 件</span>
            <div className="stock-prep-bulk-buttons">
              <button className="secondary-button" type="button" disabled={!selectedAddedOrders.length || resetMutation.isPending} onClick={() => resetOrders(selectedAddedOrders)}>{resetMutation.isPending ? "撤回中…" : `撤回状态 ${selectedAddedOrders.length ? `(${selectedAddedOrders.length})` : ""}`}</button>
              <button className="primary-button" disabled={!selectedReadyPostings.length || preparePostingMutation.isPending} onClick={() => preparePostingMutation.mutate(selectedReadyPostings.map((posting) => posting.posting_number))} type="button">{preparePostingMutation.isPending ? `正在提交 ${preparingPosting ?? ""}` : `批量提交 Ozon 备货 ${selectedReadyPostings.length ? `(${selectedReadyPostings.length} 单)` : ""}`}</button>
            </div>
            <small>可提交备货 {readyPostings.length} 单 / 待人工处理 {manualPostings.length} 单。撤回只修改 GMV 状态，不会扣减 1688 购物车数量。</small>
          </section>
          {scan && (visibleAddedGroups.length ? <div className="stock-prep-groups">
            {visibleAddedGroups.map((group, index) => <section className="settings-card stock-prep-group" key={`${group.offerUrl}-${group.skuId}-${index}`}>
              <header>
                <div><p className="eyebrow">已加购</p><h3>{group.offerId} <small>· {group.orders.length} 单 · {group.quantity} 件</small></h3></div>
                <span className="stock-prep-state stock-prep-state--added">已加购</span>
                {group.offerUrl && <a href={group.offerUrl} target="_blank" rel="noreferrer">1688 商品</a>}
              </header>
              <div className="stock-prep-product">
                <OrderImagePreview src={group.imageUrl} alt={`${group.offerId} 商品主图`} fallbackLabel="暂无商品图" width={58} height={58} className="stock-prep-product-image" placeholderClassName="stock-prep-product-image stock-prep-product-image--empty"/>
                <div>{group.skuId ? <p className="stock-prep-sku">1688 SKU ID：<code>{group.skuId}</code></p> : <p className="stock-prep-warning"><AlertTriangle size={16}/>{group.error}</p>}</div>
              </div>
              <div className="table-scroll"><table className="stock-prep-orders">
                <thead><tr><th>选择</th><th>Ozon 发货单号</th><th>货号</th><th>商品</th><th>件数</th><th>采购状态</th><th>Ozon 备货</th></tr></thead>
                <tbody>{group.orders.map((order) => {
                  const posting = postingByNumber.get(order.postingNumber);
                  const prepareError = prepareErrors[order.postingNumber];
                  return <tr key={keyOf(order)}>
                    <td><input type="checkbox" checked={selected.has(keyOf(order))} onChange={(event) => toggleOrder(order, event.target.checked)} aria-label={`选择订单 ${order.postingNumber}`}/></td>
                    <td>{order.postingNumber}</td>
                    <td>{order.offerId}</td>
                    <td>{order.productName}</td>
                    <td>{order.quantity}</td>
                    <td>已加购</td>
                    <td className="stock-prep-prepare-cell">
                      {posting?.can_prepare ? <><small className="stock-prep-ready-label">可提交备货</small><button className="secondary-button compact-button" type="button" aria-label={`提交 Ozon 备货 ${order.postingNumber}`} disabled={preparePostingMutation.isPending} onClick={() => preparePostingMutation.mutate([order.postingNumber])}>{preparingPosting === order.postingNumber ? "提交中…" : "提交 Ozon 备货"}</button></> : <small>{posting?.prepare_block_reason ?? (fulfillmentQuery.isLoading ? "正在读取备货状态…" : "请刷新订单状态")}</small>}
                      {prepareError && <small className="field-error">{prepareError}</small>}
                    </td>
                  </tr>;
                })}</tbody>
              </table></div>
            </section>)}
          </div> : <div className="empty-store-state"><ShoppingCart size={34}/><h3>暂无已加购订单</h3><p>当前扫描结果中的已加购订单会显示在这里。</p></div>)}
        </>;
      })()}
      {completedBatch && activeTab !== "config" && <section className="settings-card stock-prep-batch-result"><header><div><p className="eyebrow">BATCH RESULT</p><h3>最近一次加购结果</h3></div><span>{statusNames[completedBatch.status] ?? completedBatch.status}</span></header><div className="stock-prep-result-summary"><strong>成功 {completedBatch.items.filter((item) => item.status === "added").length}</strong><span>失败 {completedBatch.items.filter((item) => item.status === "failed").length}</span><span>待核实 {completedBatch.items.filter((item) => item.status === "uncertain").length}</span>{completedBatch.items.some((item) => item.status === "failed") && <button className="secondary-button compact-button" type="button" onClick={() => setBatchPreviewKeys(completedBatch.items.filter((item) => item.status === "failed").flatMap(batchOrderKeys))}>重试失败项</button>}</div><div className="table-scroll"><table className="stock-prep-orders"><thead><tr><th>货号 / SKU</th><th>供应商</th><th>采购车</th><th>数量变化</th><th>结果</th></tr></thead><tbody>{completedBatch.items.map((item) => <tr key={item.id}><td>{item.offer_id}<br/><small>SKU {item.sku_id}</small></td><td>{item.supplier_name ?? "未识别"}</td><td>{item.cart_mode === "dropship" ? "代发车" : item.cart_mode === "wholesale" ? "批发车" : "未确定"}</td><td>{item.cart_before == null || item.cart_after == null ? "未读取" : `${item.cart_before} → ${item.cart_after}`}</td><td>{statusNames[item.status] ?? item.status}{item.error ? ` · ${item.error}` : ""}</td></tr>)}</tbody></table></div></section>}
      {!scan && ["action", "pending", "added"].includes(activeTab) && !scanMutation.isPending && <div className="empty-store-state"><ShoppingCart size={34}/><h3>准备扫描订单</h3><p>请在“配置”标签选择店铺、配置 SKU 表并扫描。</p></div>}
      {batchQuery.isError && <div className="field-error" role="alert">批次状态读取失败：{batchQuery.error.message}</div>}
      {batchPreviewKeys && <div className="stock-prep-dialog-backdrop" role="presentation"><section className="stock-prep-dialog" role="dialog" aria-modal="true" aria-labelledby="stock-prep-preview-title"><header><div><p className="eyebrow">BATCH PREFLIGHT</p><h3 id="stock-prep-preview-title">确认加入 1688 采购车</h3></div><button className="secondary-button compact-button" type="button" onClick={() => setBatchPreviewKeys(null)}>取消</button></header><p>将按商品合并处理，供应商与普通车/代发车路线会在执行时读取，并记录到最终结果。</p><div className="stock-prep-preview-metrics"><div><span>订单明细</span><strong>{previewEntries.length}</strong></div><div><span>SKU 组</span><strong>{new Set(previewEntries.map(({ group }) => `${group.offerUrl}\u0000${group.skuId}`)).size}</strong></div><div><span>商品页</span><strong>{new Set(previewEntries.map(({ group }) => group.offerUrl)).size}</strong></div><div><span>预计件数</span><strong>{previewEntries.reduce((sum, { order }) => sum + order.quantity, 0)}</strong></div></div><div className="stock-prep-preview-status">{[...new Set(previewEntries.map(({ order }) => order.state))].map((state) => <span key={state}>{statusNames[state] ?? state} {previewEntries.filter(({ order }) => order.state === state).length} 条</span>)}</div><footer><button className="secondary-button" type="button" onClick={() => setBatchPreviewKeys(null)}>返回检查</button><button className="primary-button" type="button" disabled={!previewEntries.length || batchMutation.isPending} onClick={() => batchMutation.mutate(previewEntries.map(({ key }) => key))}><ShoppingCart size={17}/>{batchMutation.isPending ? "正在校验…" : "确认启动加购"}</button></footer></section></div>}
      {riskDrawerTarget && riskDrawerOrders.length > 0 && <StockPrepRiskDrawer
        buyerPrefix={riskDrawerTarget.buyerPrefix}
        orders={riskDrawerOrders}
        approving={approveRiskMutation.isPending}
        blacklisting={addOrderBuyerMutation.isPending}
        onClose={() => setRiskDrawerTarget(null)}
        onApprove={() => { if (riskDrawerTarget.buyerPrefix) approveRiskMutation.mutate({ buyerPrefix: riskDrawerTarget.buyerPrefix, keys: riskOrderKeys(riskDrawerTarget.buyerPrefix, riskDrawerTarget.postingNumber) }); }}
        onAddBlacklist={() => { const reason = window.prompt("填写加入黑名单的原因"); if (reason?.trim()) addOrderBuyerMutation.mutate({ postingNumber: riskDrawerTarget.postingNumber, reason: reason.trim() }); }}
      />}
    </main>;
}

function keyOf(key: StockPrepOrderKey): string { return `${key.postingNumber}\u0000${key.offerId}`; }
