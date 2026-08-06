import { CalendarDays, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";

import type { DashboardRange, StoreView } from "../../shared/contracts";
import { formatBeijingTime } from "../format";
import type { StreamStatus } from "../hooks/use-dashboard-stream";
import { AppNav } from "./AppNav";
import { StatusPill } from "./StatusPill";

const rangeOptions: Array<{ value: DashboardRange; label: string }> = [
  { value: "today", label: "今天" },
  { value: "yesterday", label: "昨天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "custom", label: "自定义" },
];

interface DashboardHeaderProps {
  stores: StoreView[];
  storeId: string;
  range: DashboardRange;
  streamStatus: StreamStatus;
  wallboard: boolean;
  customFrom: string;
  customTo: string;
  onStoreChange: (storeId: string) => void;
  onRangeChange: (range: DashboardRange) => void;
  onCustomFromChange: (value: string) => void;
  onCustomToChange: (value: string) => void;
}

export function DashboardHeader(props: DashboardHeaderProps): React.JSX.Element {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <header className="dashboard-header">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          O
        </div>
        <div>
          <p className="eyebrow">OZON MULTI-STORE</p>
          <h1>GMV 指挥中心</h1>
        </div>
      </div>

      <div className="dashboard-controls">
        <label className="select-control">
          <span className="sr-only">选择店铺</span>
          <select value={props.storeId} onChange={(event) => props.onStoreChange(event.target.value)}>
            <option value="all">全部店铺</option>
            {props.stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
          <ChevronDown size={16} aria-hidden="true" />
        </label>

        <div className="range-switcher" aria-label="日期范围">
          {rangeOptions.map((option) => (
            <button
              className={props.range === option.value ? "range-button is-active" : "range-button"}
              key={option.value}
              type="button"
              onClick={() => props.onRangeChange(option.value)}
              aria-pressed={props.range === option.value}
            >
              {option.label}
            </button>
          ))}
        </div>

        {props.range === "custom" && (
          <div className="custom-range">
            <CalendarDays size={16} aria-hidden="true" />
            <label>
              <span className="sr-only">开始时间</span>
              <input type="datetime-local" value={props.customFrom} onChange={(event) => props.onCustomFromChange(event.target.value)} />
            </label>
            <span>至</span>
            <label>
              <span className="sr-only">结束时间</span>
              <input type="datetime-local" value={props.customTo} onChange={(event) => props.onCustomToChange(event.target.value)} />
            </label>
          </div>
        )}
      </div>

      <div className="header-status">
        <StatusPill status={props.streamStatus} />
        <div className="beijing-clock" aria-label={`北京时间 ${formatBeijingTime(now)}`}>
          <strong>{formatBeijingTime(now)}</strong>
          <span>北京时间 · {formatBeijingTime(now, "MM月dd日")}</span>
        </div>
        <AppNav compact={props.wallboard} />
      </div>
    </header>
  );
}

