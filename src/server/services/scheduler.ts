import { addDays, subDays, subHours, subMinutes } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import type { SyncService } from "./sync-service";

const MINUTE = 60_000;
const BEIJING_TIMEZONE = "Asia/Shanghai";
const NIGHTLY_RECONCILIATION_TIME = "03:00:00";

export interface SchedulerHandle {
  stop: () => void;
}

/** Calculates the next 03:00 Beijing reconciliation without relying on the ECS host timezone. */
export function millisecondsUntilNextNightlyRun(now = new Date()): number {
  const today = formatInTimeZone(now, BEIJING_TIMEZONE, "yyyy-MM-dd");
  let target = fromZonedTime(`${today}T${NIGHTLY_RECONCILIATION_TIME}`, BEIJING_TIMEZONE);
  if (target.getTime() <= now.getTime()) {
    const tomorrow = formatInTimeZone(addDays(now, 1), BEIJING_TIMEZONE, "yyyy-MM-dd");
    target = fromZonedTime(`${tomorrow}T${NIGHTLY_RECONCILIATION_TIME}`, BEIJING_TIMEZONE);
  }
  return target.getTime() - now.getTime();
}

/** Starts local polling plus short- and long-window reconciliation schedules. */
export function startScheduler(syncService: SyncService): SchedulerHandle {
  const incrementalTimer = setInterval(() => {
    const now = new Date();
    void syncService.syncActiveStores(subMinutes(now, 15), now, undefined, 10_000, "ozon").catch(() => undefined);
  }, MINUTE);

  const wildberriesOrdersTimer = setInterval(() => {
    const now = new Date();
    void syncService.syncActiveStores(subMinutes(now, 120), now, undefined, 10_000, "wildberries", ["orders"]).catch(() => undefined);
  }, 5 * MINUTE);

  const wildberriesSalesTimer = setInterval(() => {
    const now = new Date();
    void syncService.syncActiveStores(subHours(now, 24), now, undefined, 10_000, "wildberries", ["sales"]).catch(() => undefined);
  }, 15 * MINUTE);

  const reconcileTimer = setInterval(() => {
    const now = new Date();
    void syncService.syncActiveStores(subHours(now, 24), now, undefined, 10_000, "ozon").catch(() => undefined);
  }, 15 * MINUTE);

  let stopped = false;
  let nightlyTimer: ReturnType<typeof setTimeout>;
  const scheduleNightlyReconciliation = (): void => {
    nightlyTimer = setTimeout(() => {
      if (stopped) {
        return;
      }
      const now = new Date();
      void syncService.syncActiveStores(subDays(now, 7), now, undefined, 10_000, "ozon").catch(() => undefined);
      void syncService.syncActiveStores(subDays(now, 7), now, undefined, 10_000, "wildberries").catch(() => undefined);
      scheduleNightlyReconciliation();
    }, millisecondsUntilNextNightlyRun());
    nightlyTimer.unref();
  };
  scheduleNightlyReconciliation();

  incrementalTimer.unref();
  reconcileTimer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(incrementalTimer);
      clearInterval(wildberriesOrdersTimer);
      clearInterval(wildberriesSalesTimer);
      clearInterval(reconcileTimer);
      clearTimeout(nightlyTimer);
    },
  };
}
