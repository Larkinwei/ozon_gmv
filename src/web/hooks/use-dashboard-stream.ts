import { useEffect, useState } from "react";

import { dashboardStreamUrl, DEMO_MODE } from "../api";

export type StreamStatus = "connected" | "reconnecting" | "paused";

/** Connects to the authenticated dashboard event stream and reports connectivity. */
export function useDashboardStream(
  paused: boolean,
  onEvent: () => void,
  onOrderCreated?: () => void,
): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>(DEMO_MODE ? "connected" : "reconnecting");

  useEffect(() => {
    if (paused) {
      setStatus("paused");
      return;
    }
    if (DEMO_MODE) {
      setStatus("connected");
      return;
    }

    const source = new EventSource(dashboardStreamUrl());
    source.onopen = () => setStatus("connected");
    source.onerror = () => setStatus("reconnecting");
    const handleEvent = (): void => onEvent();
    source.addEventListener("posting.created", () => {
      onOrderCreated?.();
      onEvent();
    });
    source.addEventListener("posting.updated", handleEvent);
    source.addEventListener("sync.status", handleEvent);
    return () => source.close();
  }, [onEvent, onOrderCreated, paused]);

  return status;
}
