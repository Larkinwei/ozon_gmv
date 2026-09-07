import type { StoreView } from "../shared/contracts";

/** A failed sync is no longer in progress even when it has no successful finish timestamp. */
export function isStoreSynchronizing(store: StoreView): boolean {
  if (!store.lastSyncStartedAt || store.lastSyncError) {
    return false;
  }
  return !store.lastSyncFinishedAt || store.lastSyncStartedAt > store.lastSyncFinishedAt;
}
