import { describe, expect, it } from "vitest";

import { buildWindowsToastArguments, isWindowsToastFailure } from "../src/server/desktop-notifications/windows-toast";

describe("Windows Toast adapter", () => {
  it("passes a local image and the native short duration to SnoreToast", () => {
    const args = buildWindowsToastArguments("\\\\.\\pipe\\ozon-gmv-test", {
      title: "新订单 · 店铺 A",
      message: "135.00 CNY\\n商品 · 1 件 · FBS",
      imagePath: "C:\\Users\\tester\\AppData\\Local\\Ozon GMV Dashboard\\notification-images\\product.png",
      onActivate: () => undefined,
    });

    expect(args).toEqual([
      "-t", "新订单 · 店铺 A",
      "-m", "135.00 CNY\\n商品 · 1 件 · FBS",
      "-p", "C:\\Users\\tester\\AppData\\Local\\Ozon GMV Dashboard\\notification-images\\product.png",
      "-s", "Notification.Default",
      "-appID", "com.ozon.gmv-dashboard",
      "-pipeName", "\\\\.\\pipe\\ozon-gmv-test",
    ]);
  });

  it("omits an image for summary notifications", () => {
    const args = buildWindowsToastArguments("pipe", { title: "另外 2 笔新订单", message: "99.00 RUB", onActivate: () => undefined });
    expect(args).not.toContain("-p");
    expect(args).not.toContain("-d");
  });

  it("treats normal SnoreToast outcomes as submitted", () => {
    expect([0, 1, 2, 3, 4, 5, null].some((code) => isWindowsToastFailure(code))).toBe(false);
  });

  it("treats both signed and unsigned failure codes as errors", () => {
    expect(isWindowsToastFailure(-1)).toBe(true);
    expect(isWindowsToastFailure(0xFFFFFFFF)).toBe(true);
  });
});
