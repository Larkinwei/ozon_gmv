// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrderDetail } from "../../shared/contracts";
import { OrderDetailDrawer } from "./OrderDetailDrawer";

const detail: OrderDetail = {
  id: "00000000-0000-4000-8000-000000000001",
  postingNumber: "123-0001-1",
  orderNumber: "123-0001",
  storeId: "store-1",
  storeName: "YOGOLD",
  storeColor: "#EC4899",
  orderAt: "2026-08-06T04:00:00.000Z",
  fulfillment: "FBS",
  status: "awaiting_packaging",
  substatus: "posting_created",
  cancelled: false,
  cancelledAt: null,
  amount: { amount: "398.00", currency: "CNY" },
  items: [{
    id: "item-1",
    sku: "1001",
    offerId: "OFFER-1001",
    name: "Спортивный костюм",
    imageUrl: "https://cdn.example.com/1001.jpg",
    quantity: 2,
    unitPrice: { amount: "199.00", currency: "CNY" },
    subtotal: { amount: "398.00", currency: "CNY" },
  }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

describe("OrderDetailDrawer", () => {
  it("loads product details, traps focus in the dialog, and closes with Escape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(detail), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const onClose = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <OrderDetailDrawer orderId={detail.id} onClose={onClose} />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("dialog", { name: "订单详情" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭订单详情" })).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    expect(await screen.findByText("Спортивный костюм")).toBeInTheDocument();
    expect(screen.getByText("SKU：1001")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Спортивный костюм 主图" })).toHaveAttribute(
      "src",
      "https://cdn.example.com/1001.jpg",
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
