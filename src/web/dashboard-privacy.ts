import { useSyncExternalStore } from "react";

const PRIVACY_KEY = "gmv.dashboard.hide_store_identity";
const listeners = new Set<() => void>();
let hiddenSnapshot = readStorage();

function readStorage(): boolean {
  try {
    return window.localStorage.getItem(PRIVACY_KEY) === "true";
  } catch {
    return false;
  }
}

function writeStorage(hidden: boolean): void {
  try {
    if (hidden) {
      window.localStorage.setItem(PRIVACY_KEY, "true");
    } else {
      window.localStorage.removeItem(PRIVACY_KEY);
    }
  } catch {
    // Private mode / disabled storage: keep the in-memory state only.
  }
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export const HIDDEN_PLACEHOLDER = "***";

export const dashboardPrivacy = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): boolean {
    return hiddenSnapshot;
  },
  setHidden(hidden: boolean): void {
    if (hiddenSnapshot === hidden) {
      return;
    }
    hiddenSnapshot = hidden;
    writeStorage(hidden);
    notify();
  },
};

export function useDashboardPrivacy(): boolean {
  return useSyncExternalStore(
    dashboardPrivacy.subscribe,
    dashboardPrivacy.getSnapshot,
    () => false,
  );
}
