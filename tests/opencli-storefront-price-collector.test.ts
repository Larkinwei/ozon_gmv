import { describe, expect, it } from "vitest";
import { OpenCliStorefrontPriceCollector } from "../src/server/services/opencli-storefront-price-collector";

class TestCollector extends OpenCliStorefrontPriceCollector {
  public readonly commands: string[][] = [];
  public readonly waits: number[] = [];
  private readonly outputs: Array<string | Error>;

  public constructor(outputs: Array<string | Error>) {
    super({ executable: "opencli", sessionName: "test-session" });
    this.outputs = [...outputs];
  }

  protected override async run(argumentsList: string[]): Promise<string> {
    this.commands.push(argumentsList);
    if (!argumentsList.includes("eval")) return "";
    const output = this.outputs.shift();
    if (output instanceof Error) throw output;
    return output ?? "{}";
  }

  protected override async sleep(milliseconds: number): Promise<void> {
    this.waits.push(milliseconds);
  }
}

describe("OpenCLI storefront price collector", () => {
  it("reuses one Ozon tab across a batch and closes the session once", async () => {
    const collector = new TestCollector([
      JSON.stringify({ sku: "100000001", greenPrice: "100" }),
      JSON.stringify({ sku: "100000002", greenPrice: "120" }),
    ]);

    await collector.collect("100000001");
    await collector.collect("100000002");
    await collector.close();

    expect(collector.commands.filter((command) => command.includes("open"))).toHaveLength(1);
    expect(collector.commands.filter((command) => command.includes("eval"))).toHaveLength(2);
    expect(collector.commands.filter((command) => command.at(-1) === "close")).toHaveLength(1);
    expect(collector.commands.some((command) => command.includes("tab"))).toBe(false);
  });

  it("backs off and retries a transient rate-limit response", async () => {
    const collector = new TestCollector([
      JSON.stringify({ __httpStatus: 429 }),
      JSON.stringify({ sku: "100000001", greenPrice: "100" }),
    ]);

    await expect(collector.collect("100000001")).resolves.toMatchObject({ sku: "100000001" });
    expect(collector.waits).toEqual([2_500]);
    expect(collector.commands.filter((command) => command.includes("eval"))).toHaveLength(2);
  });

  it("does not retry permanent client errors", async () => {
    const collector = new TestCollector([JSON.stringify({ __httpStatus: 404 })]);

    await expect(collector.collect("100000001")).rejects.toThrow("HTTP 404");
    expect(collector.waits).toEqual([]);
    expect(collector.commands.filter((command) => command.includes("eval"))).toHaveLength(1);
  });
});
