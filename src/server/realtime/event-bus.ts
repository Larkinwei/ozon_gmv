import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import type { DashboardEvent, DashboardEventType } from "../../shared/contracts";

const EVENT_NAME = "dashboard-event";

export class DashboardEventBus {
  private readonly emitter = new EventEmitter();
  private readonly history: DashboardEvent[] = [];

  public publish<T>(type: DashboardEventType, data: T): DashboardEvent<T> {
    const event: DashboardEvent<T> = {
      id: `${Date.now()}-${randomUUID()}`,
      type,
      occurredAt: new Date().toISOString(),
      data,
    };
    this.history.push(event);
    if (this.history.length > 200) {
      this.history.splice(0, this.history.length - 200);
    }
    this.emitter.emit(EVENT_NAME, event);
    return event;
  }

  public subscribe(listener: (event: DashboardEvent) => void): () => void {
    this.emitter.on(EVENT_NAME, listener);
    return () => this.emitter.off(EVENT_NAME, listener);
  }

  public eventsAfter(id?: string): DashboardEvent[] {
    if (!id) {
      return [];
    }
    const index = this.history.findIndex((event) => event.id === id);
    return index >= 0 ? this.history.slice(index + 1) : [];
  }
}

