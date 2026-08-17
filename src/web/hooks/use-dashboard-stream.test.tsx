// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useDashboardStream } from "./use-dashboard-stream";

interface FakeEventSource {
  url: string;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
  dispatch: (type: string) => void;
}

class FakeEventSourceClass {
  public static instances: FakeEventSource[] = [];
  public readonly url: string;
  public onopen: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public readonly close = vi.fn();
  private readonly listeners = new Map<string, Set<() => void>>();

  public constructor(url: string) {
    this.url = url;
    FakeEventSourceClass.instances.push(this as unknown as FakeEventSource);
  }

  public addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  public dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

function latestSource(): FakeEventSource {
  const source = FakeEventSourceClass.instances.at(-1) as unknown as FakeEventSource | undefined;
  if (!source) {
    throw new Error("no EventSource created");
  }
  return source;
}

beforeEach(() => {
  FakeEventSourceClass.instances = [];
  vi.stubGlobal("EventSource", FakeEventSourceClass);
});

describe("useDashboardStream", () => {
  it("invokes onOrderCreated only for posting.created events", () => {
    const onEvent = vi.fn();
    const onOrderCreated = vi.fn();
    renderHook(() => useDashboardStream(false, onEvent, onOrderCreated));

    const source = latestSource();
    act(() => {
      source.onopen?.();
      source.dispatch("posting.created");
      source.dispatch("posting.updated");
      source.dispatch("sync.status");
    });

    expect(onOrderCreated).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(3);
  });

  it("closes the stream while paused and reconnects on resume", () => {
    const onEvent = vi.fn();
    const { rerender } = renderHook(({ paused }) => useDashboardStream(paused, onEvent), {
      initialProps: { paused: false },
    });

    const first = latestSource();
    rerender({ paused: true });
    expect(first.close).toHaveBeenCalledTimes(1);

    rerender({ paused: false });
    expect(FakeEventSourceClass.instances.length).toBe(2);
  });
});
