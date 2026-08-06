import { AlertTriangle, CheckCircle2, Clock3, Radio, WifiOff } from "lucide-react";

import type { StreamStatus } from "../hooks/use-dashboard-stream";

interface StatusPillProps {
  status: StreamStatus;
}

export function StatusPill({ status }: StatusPillProps): React.JSX.Element {
  if (status === "connected") {
    return (
      <span className="status-pill status-pill--healthy">
        <Radio size={15} aria-hidden="true" /> 实时连接
      </span>
    );
  }
  if (status === "paused") {
    return (
      <span className="status-pill status-pill--warning">
        <Clock3 size={15} aria-hidden="true" /> 已暂停
      </span>
    );
  }
  return (
    <span className="status-pill status-pill--danger">
      <WifiOff size={15} aria-hidden="true" /> 正在重连
    </span>
  );
}

export function HealthIcon({ health }: { health: "healthy" | "delayed" | "error" | "never" }): React.JSX.Element {
  if (health === "healthy") {
    return <CheckCircle2 size={16} aria-hidden="true" />;
  }
  return <AlertTriangle size={16} aria-hidden="true" />;
}

