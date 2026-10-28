// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";

import { OrderImagePreview } from "./OrderImagePreview";

afterEach(cleanup);

describe("OrderImagePreview", () => {
  it("shows a placeholder when there is no product image", () => {
    render(<OrderImagePreview src={null} alt="商品主图" fallbackLabel="暂无商品主图" width={52} height={52} className="thumb" />);

    expect(screen.getByRole("img", { name: "暂无商品主图" })).toBeInTheDocument();
  });

  it("opens a full-size viewer by click and closes it with Escape", () => {
    render(<OrderImagePreview src="https://cdn.example.com/product.jpg" alt="商品主图" fallbackLabel="暂无商品主图" width={52} height={52} className="thumb" />);

    const trigger = screen.getByRole("button", { name: "放大查看：商品主图" });
    fireEvent.mouseEnter(trigger);
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "商品主图大图" })).toBeInTheDocument();
    expect(document.querySelector(".order-image-preview__hover")).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "商品主图大图" })).not.toBeInTheDocument();
    expect(document.querySelector(".order-image-preview__hover")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("does not restore the hover preview when the viewer close button is clicked", () => {
    render(<OrderImagePreview src="https://cdn.example.com/product.jpg" alt="商品主图" fallbackLabel="暂无商品主图" width={52} height={52} className="thumb" />);

    const trigger = screen.getByRole("button", { name: "放大查看：商品主图" });
    fireEvent.mouseEnter(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "关闭大图" }));

    expect(screen.queryByRole("dialog", { name: "商品主图大图" })).not.toBeInTheDocument();
    expect(document.querySelector(".order-image-preview__hover")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("shows a non-interactive enlarged preview on keyboard focus", () => {
    render(<OrderImagePreview src="https://cdn.example.com/product.jpg" alt="商品主图" fallbackLabel="暂无商品主图" width={52} height={52} className="thumb" />);

    fireEvent.focus(screen.getByRole("button", { name: "放大查看：商品主图" }));
    expect(document.querySelector(".order-image-preview__hover")).toBeInTheDocument();
  });
});
