import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { useSearchParams } from "react-router-dom";

import type { DashboardRange, RecentOrder } from "../../shared/contracts";
import { fetchDashboard, fetchStores } from "../api";
import { DashboardHeader } from "../components/DashboardHeader";
import { KpiGrid } from "../components/KpiGrid";
import { LiveOrders } from "../components/LiveOrders";
import { OrderDetailDrawer } from "../components/OrderDetailDrawer";
import { StoreRanking } from "../components/StoreRanking";
import { SyncStrip } from "../components/SyncStrip";
import { TrendPanel } from "../components/TrendPanel";
import { useDashboardStream } from "../hooks/use-dashboard-stream";
import { soundPlayer } from "../sound-player";

interface DashboardPageProps {
  wallboard?: boolean;
}

function defaultCustomTime(offsetHours: number): string {
  return formatInTimeZone(new Date(Date.now() + offsetHours * 60 * 60 * 1000), "Asia/Shanghai", "yyyy-MM-dd'T'HH:mm");
}

function toUtc(value: string): string | undefined {
  return value ? fromZonedTime(value, "Asia/Shanghai").toISOString() : undefined;
}

function DashboardSkeleton(): React.JSX.Element {
  return (
    <div className="dashboard-skeleton" aria-busy="true" aria-label="正在加载大屏数据">
      <div className="skeleton-row skeleton-kpis" />
      <div className="skeleton-row skeleton-main" />
      <div className="skeleton-row skeleton-bottom" />
    </div>
  );
}

export default function DashboardPage({ wallboard = false }: DashboardPageProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const orderIdFromUrl = searchParams.get("order");
  const [storeId, setStoreId] = useState("all");
  const [range, setRange] = useState<DashboardRange>("today");
  const [customFrom, setCustomFrom] = useState(() => defaultCustomTime(-24));
  const [customTo, setCustomTo] = useState(() => defaultCustomTime(0));
  const [feedPaused, setFeedPaused] = useState(false);
  const [feedOrders, setFeedOrders] = useState<RecentOrder[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(() => orderIdFromUrl);

  useEffect(() => {
    setSelectedOrderId(orderIdFromUrl);
  }, [orderIdFromUrl]);

  function selectOrder(orderId: string): void {
    setSelectedOrderId(orderId);
    setSearchParams((current) => {
      current.set("order", orderId);
      return current;
    }, { replace: true });
  }

  function closeOrder(): void {
    setSelectedOrderId(null);
    setSearchParams((current) => {
      current.delete("order");
      return current;
    }, { replace: true });
  }

  const handleStreamEvent = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }, [queryClient]);
  // Autoplay policies block audio until the user interacts with the page once;
  // `unlock` is idempotent, so keeping the listeners for the page lifetime is safe.
  useEffect(() => {
    const unlockAudio = (): void => soundPlayer.unlock();
    window.addEventListener("pointerdown", unlockAudio, { capture: true });
    window.addEventListener("keydown", unlockAudio, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", unlockAudio, { capture: true });
      window.removeEventListener("keydown", unlockAudio, { capture: true });
    };
  }, []);
  const handleOrderCreated = useCallback(() => {
    soundPlayer.play();
  }, []);
  const streamStatus = useDashboardStream(false, handleStreamEvent, handleOrderCreated);
  const filters = useMemo(() => {
    const from = range === "custom" ? toUtc(customFrom) : undefined;
    const to = range === "custom" ? toUtc(customTo) : undefined;
    return {
      range,
      storeId,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    };
  }, [customFrom, customTo, range, storeId]);
  const customRangeValid = range !== "custom" || Boolean(filters.from && filters.to && filters.from < filters.to);

  const storesQuery = useQuery({ queryKey: ["stores"], queryFn: fetchStores, enabled: !wallboard });
  const dashboardQuery = useQuery({
    queryKey: ["dashboard", filters],
    queryFn: () => fetchDashboard(filters),
    enabled: customRangeValid,
    refetchInterval: streamStatus === "reconnecting" ? 30_000 : false,
    placeholderData: (previous) => previous,
  });

  useEffect(() => {
    if (!feedPaused && dashboardQuery.data) {
      setFeedOrders(dashboardQuery.data.recentOrders);
    }
  }, [dashboardQuery.data, feedPaused]);

  const stores = storesQuery.data ?? dashboardQuery.data?.sync ?? [];
  return (
    <div className={wallboard ? "dashboard-page is-wallboard" : "dashboard-page"}>
      <a className="skip-link" href="#dashboard-main">
        跳到主要内容
      </a>
      <DashboardHeader
        stores={stores}
        storeId={storeId}
        range={range}
        streamStatus={streamStatus}
        wallboard={wallboard}
        customFrom={customFrom}
        customTo={customTo}
        onStoreChange={setStoreId}
        onRangeChange={setRange}
        onCustomFromChange={setCustomFrom}
        onCustomToChange={setCustomTo}
      />

      {!customRangeValid && <div className="inline-error" role="alert">结束时间必须晚于开始时间</div>}
      {dashboardQuery.isLoading ? (
        <DashboardSkeleton />
      ) : dashboardQuery.error ? (
        <main className="page-error" id="dashboard-main">
          <h2>数据暂时无法加载</h2>
          <p>{dashboardQuery.error.message}</p>
          <button className="primary-button" type="button" onClick={() => void dashboardQuery.refetch()}>
            重新加载
          </button>
        </main>
      ) : dashboardQuery.data ? (
        <main className="dashboard-main" id="dashboard-main">
          <KpiGrid kpis={dashboardQuery.data.kpis} />
          <div className="dashboard-content-grid">
            <div className="dashboard-left-column">
              <TrendPanel points={dashboardQuery.data.timeSeries} />
              <StoreRanking stores={dashboardQuery.data.stores} />
            </div>
            <LiveOrders
              orders={feedOrders}
              paused={feedPaused}
              onPausedChange={setFeedPaused}
              onOrderSelect={selectOrder}
            />
          </div>
          <SyncStrip stores={dashboardQuery.data.sync} />
        </main>
      ) : null}
      {selectedOrderId && (
        <OrderDetailDrawer orderId={selectedOrderId} onClose={closeOrder} />
      )}
    </div>
  );
}
