import { describe, expect, it } from "vitest";

import { buildWindowsToastArguments } from "../src/server/desktop-notifications/windows-toast";

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
      "-d", "short",
      "-s", "Notification.Default",
      "-appID", "com.ozon.gmv-dashboard",
      "-pipeName", "\\\\.\\pipe\\ozon-gmv-test",
    ]);
  });

  it("omits an image for summary notifications", () => {
    const args = buildWindowsToastArguments("pipe", { title: "另外 2 笔新订单", message: "99.00 RUB", onActivate: () => undefined });
    expect(args).not.toContain("-p");
    expect(args).toContain("short");
  });
});
