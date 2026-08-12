import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteSelectionImport, fetchOrderDetail, login, logout, previewSelectionImport, syncStore } from "./api";

describe("web API requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not declare a JSON content type for a bodyless POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await logout();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).has("content-type")).toBe(false);
  });

  it("sends the selected day range when synchronizing a store", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true, days: 30 }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await syncStore("00000000-0000-4000-8000-000000000000", 30);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/stores/00000000-0000-4000-8000-000000000000/sync");
    expect(JSON.parse(String(init.body))).toEqual({ days: 30 });
  });

  it("declares JSON when sending a serialized request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, username: "admin" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await login("admin", "secret");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });

  it("loads an order detail from the current dashboard API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "order-1", items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchOrderDetail("00000000-0000-4000-8000-000000000001");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard/orders/00000000-0000-4000-8000-000000000001",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });

  it("lets the browser declare the multipart boundary for selection imports", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ headers: ["关键词"], sampleRows: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["关键词\n收纳"], "queries.csv", { type: "text/csv" });

    await previewSelectionImport(file);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    expect(new Headers(init.headers).has("content-type")).toBe(false);
  });

  it("accepts a bodyless 204 response when deleting a mistaken import", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteSelectionImport("00000000-0000-4000-8000-000000000001")).resolves.toBeUndefined();
  });
});
