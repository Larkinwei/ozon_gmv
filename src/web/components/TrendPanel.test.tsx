// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { TimeSeriesPoint } from "../../shared/contracts";
import { TrendPanel } from "./TrendPanel";

afterEach(cleanup);

const points: TimeSeriesPoint[] = [
  {
    bucket: "2026-08-01T16:00:00.000Z",
    label: "08-02",
    orders: 5,
    gmv: [{ amount: "370.75", currency: "RUB" }],
    stores: [
      {
        storeId: "store-a",
        storeName: "店铺 A",
        color: "#3B82F6",
        orders: 2,
        gmv: [{ amount: "120.50", currency: "RUB" }],
      },
      {
        storeId: "store-b",
        storeName: "店铺 B",
        color: "#22C55E",
        orders: 3,
        gmv: [{ amount: "250.25", currency: "RUB" }],
      },
    ],
  },
  {
    bucket: "2026-08-02T16:00:00.000Z",
    label: "08-03",
    orders: 0,
    gmv: [{ amount: "0.00", currency: "RUB" }],
    stores: [
      {
        storeId: "store-a",
        storeName: "店铺 A",
        color: "#3B82F6",
        orders: 0,
        gmv: [{ amount: "0.00", currency: "RUB" }],
      },
      {
        storeId: "store-b",
        storeName: "店铺 B",
        color: "#22C55E",
        orders: 0,
        gmv: [{ amount: "0.00", currency: "RUB" }],
      },
    ],
  },
];

function createStorePoint(storeCount: number): TimeSeriesPoint {
  const stores = Array.from({ length: storeCount }, (_, index) => {
    const rank = storeCount - index;
    return {
      storeId: `store-${index + 1}`,
      storeName: `店铺 ${index + 1}`,
      color: `hsl(${index * 37} 80% 60%)`,
      orders: rank,
      gmv: [{ amount: `${rank * 100}.00`, currency: "RUB" }],
    };
  });
  const orders = stores.reduce((sum, store) => sum + store.orders, 0);
  const gmv = stores.reduce((sum, store) => sum + Number(store.gmv[0]?.amount ?? 0), 0);
  return {
    bucket: "2026-08-05T16:00:00.000Z",
    label: "08-06",
    orders,
    gmv: [{ amount: gmv.toFixed(2), currency: "RUB" }],
    stores,
  };
}

function createDensePoints(pointCount: number): TimeSeriesPoint[] {
  const point = createStorePoint(3);
  return Array.from({ length: pointCount }, (_, index) => ({
    ...point,
    bucket: `2026-08-${String(index + 1).padStart(2, "0")}T16:00:00.000Z`,
    label: `08-${String(index + 1).padStart(2, "0")}`,
  }));
}

describe("TrendPanel", () => {
  it("renders each time bucket as one clipped stack with seamless shared geometry", () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}

      observe(target: Element): void {
        this.callback([
          {
            target,
            contentRect: { width: 411, height: 180 },
          } as ResizeObserverEntry,
        ], this);
      }

      disconnect(): void {}
      unobserve(): void {}
    };

    const { container } = render(<TrendPanel points={points} />);
    const stacks = [...container.querySelectorAll<SVGGElement>(".orders-chart [data-order-stack]")];
    globalThis.ResizeObserver = originalResizeObserver;
    expect(stacks).toHaveLength(1);
    const stack = stacks[0];
    if (!stack) {
      throw new Error("Expected the non-empty order bucket to render one stack");
    }

    const segments = [...stack.querySelectorAll<SVGRectElement>("[data-store-segment]")];
    expect(segments).toHaveLength(2);
    const horizontalBounds = segments.map((segment) => ({
      x: Number(segment.getAttribute("x")),
      width: Number(segment.getAttribute("width")),
    }));

    expect(new Set(horizontalBounds.map(({ x }) => x)).size).toBe(1);
    expect(new Set(horizontalBounds.map(({ width }) => width)).size).toBe(1);
    const verticalBounds = segments
      .map((segment) => ({
        top: Number(segment.getAttribute("y")),
        bottom: Number(segment.getAttribute("y")) + Number(segment.getAttribute("height")),
      }))
      .sort((left, right) => left.top - right.top);
    const [topSegment, bottomSegment] = verticalBounds;
    if (!topSegment || !bottomSegment) {
      throw new Error("Expected the stack to contain two visible store segments");
    }
    expect(topSegment.bottom).toBe(bottomSegment.top);
    expect(stack.querySelector("clipPath rect")).toHaveAttribute("rx", "2");
    for (const segment of segments) {
      expect(segment).not.toHaveAttribute("fill-opacity");
    }
    expect(container.querySelector(".orders-chart .recharts-reference-line-line")).not.toBeInTheDocument();
  });

  it("toggles store GMV lines without removing the store legend", () => {
    render(<TrendPanel points={points} />);

    expect(screen.getByText("总计")).toBeInTheDocument();
    const storeA = screen.getByRole("button", { name: "店铺 A" });
    expect(storeA).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(storeA);
    expect(storeA).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /显示全部/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /订单量堆叠柱状图/ })).toBeInTheDocument();
  });

  it("shows time-by-store rows in the accessible data table", () => {
    render(<TrendPanel points={points} />);
    fireEvent.click(screen.getByRole("button", { name: /数据表/ }));

    const table = screen.getByRole("table", { name: /按时间和店铺拆分/ });
    expect(within(table).getAllByText("店铺 A")).toHaveLength(2);
    expect(within(table).getByText(/120,50/)).toBeInTheDocument();
    expect(within(table).getByText(/250,25/)).toBeInTheDocument();
  });

  it("exposes exact bucket details to keyboard users", () => {
    render(<TrendPanel points={points} />);
    const charts = screen.getByRole("group", { name: /左右方向键/ });

    fireEvent.focus(charts);
    const detail = within(charts).getByRole("status");
    expect(detail).toHaveTextContent("08-03");
    expect(detail).toHaveClass("chart-tooltip--left");
    fireEvent.keyDown(charts, { key: "ArrowLeft" });
    expect(detail).toHaveTextContent("08-02");
    expect(detail).toHaveTextContent("店铺 B");
    expect(detail).toHaveTextContent("250,25");
    expect(detail).toHaveTextContent("3 单");
    expect(detail).toHaveClass("chart-tooltip--right");
    expect(within(charts).getAllByTestId("trend-detail")).toHaveLength(1);
  });

  it("defaults to the top five store lines while keeping every store in the legend", () => {
    render(<TrendPanel points={[createStorePoint(8)]} />);

    for (let index = 1; index <= 5; index += 1) {
      expect(screen.getByRole("button", { name: `店铺 ${index}` })).toHaveAttribute("aria-pressed", "true");
    }
    for (let index = 6; index <= 8; index += 1) {
      expect(screen.getByRole("button", { name: `店铺 ${index}` })).toHaveAttribute("aria-pressed", "false");
    }

    fireEvent.click(screen.getByRole("button", { name: /显示全部/ }));
    expect(screen.getByRole("button", { name: "店铺 8" })).toHaveAttribute("aria-pressed", "true");
  });

  it("combines GMV and orders into one compact detail with overflow totals", () => {
    render(<TrendPanel points={[createStorePoint(8)]} />);
    const charts = screen.getByRole("group", { name: /左右方向键/ });

    fireEvent.click(screen.getByRole("button", { name: "店铺 1" }));
    fireEvent.focus(charts);
    const detail = within(charts).getByTestId("trend-detail");
    expect(detail).toHaveTextContent("总 GMV");
    expect(detail).toHaveTextContent("总订单");
    expect(detail).toHaveTextContent("其他 2 家");
    expect(detail).toHaveTextContent("300,00");
    expect(detail).toHaveTextContent("3 单");
    expect(within(detail).getByText("店铺 1")).toBeInTheDocument();
    expect(within(detail).queryByText("店铺 7")).not.toBeInTheDocument();
    expect(within(detail).queryByText("店铺 8")).not.toBeInTheDocument();
  });

  it("keeps a twenty-store detail bounded with one aggregate row", () => {
    render(<TrendPanel points={[createStorePoint(20)]} />);
    const charts = screen.getByRole("group", { name: /左右方向键/ });

    fireEvent.focus(charts);
    const detail = within(charts).getByTestId("trend-detail");
    expect(detail).toHaveTextContent("其他 14 家");
    expect(detail).toHaveTextContent("10 500,00");
    expect(detail).toHaveTextContent("105 单");
    expect(within(detail).getAllByRole("listitem")).toHaveLength(7);
  });

  it("uses square slender stacks for dense ranges", () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}

      observe(target: Element): void {
        this.callback([
          {
            target,
            contentRect: { width: 920, height: 180 },
          } as ResizeObserverEntry,
        ], this);
      }

      disconnect(): void {}
      unobserve(): void {}
    };

    const { container } = render(<TrendPanel points={createDensePoints(30)} />);
    const stack = container.querySelector<SVGGElement>(".orders-chart [data-order-stack]");
    globalThis.ResizeObserver = originalResizeObserver;
    expect(stack?.querySelector("clipPath rect")).toHaveAttribute("rx", "0");
    const segment = stack?.querySelector<SVGRectElement>("[data-store-segment]");
    expect(Number(segment?.getAttribute("width"))).toBeLessThanOrEqual(10);
  });
});
