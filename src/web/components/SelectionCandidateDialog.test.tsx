// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SelectionCandidate } from "../../shared/contracts";
import { SelectionCandidateDialog } from "./SelectionCandidateDialog";

const candidate: SelectionCandidate = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "厨房收纳架",
  ozonUrl: "https://www.ozon.ru/product/organayzer-1234567890/",
  category: "Дом и сад",
  targetPrice: { amount: "1799.00", currency: "RUB" },
  status: "watching",
  decisionReason: null,
  note: "先确认物流",
  keyword: { id: "00000000-0000-4000-8000-000000000002", phrase: "органайзер", demandScore: 91 },
  marketProduct: null,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
};

afterEach(() => {
  document.body.style.overflow = "";
});

describe("SelectionCandidateDialog", () => {
  it("supports keyboard closing and submits the explicit candidate decision", () => {
    const onClose = vi.fn();
    const onUpdate = vi.fn();
    const view = render(
      <SelectionCandidateDialog
        candidate={candidate}
        pending={false}
        error={null}
        onClose={onClose}
        onCreate={vi.fn()}
        onUpdate={onUpdate}
      />,
    );

    expect(screen.getByRole("dialog", { name: "编辑候选商品" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "商品名称 *" })).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.change(screen.getByRole("combobox", { name: "判断状态" }), { target: { value: "recommended" } });
    fireEvent.change(screen.getByRole("textbox", { name: "判断原因" }), { target: { value: "需求强且目标售价合适" } });
    fireEvent.click(screen.getByRole("button", { name: "保存判断" }));

    expect(onUpdate).toHaveBeenCalledWith(candidate.id, expect.objectContaining({
      status: "recommended",
      decisionReason: "需求强且目标售价合适",
    }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
