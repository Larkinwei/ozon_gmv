import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("desktop notification service installers", () => {
  it("registers a separate macOS login agent without changing the dashboard data directory", () => {
    const manager = readFileSync("installer/macos/manage-service.sh", "utf8");
    const notifier = readFileSync("installer/macos/com.ozon.gmv-notifier.plist.template", "utf8");
    expect(manager).toContain('NOTIFIER_LABEL="com.ozon.gmv-notifier"');
    expect(manager).toContain("register_notifier");
    expect(manager).toContain('DATA_DIR="$PROJECT_DIR/.data"');
    expect(notifier).toContain("dist/server/notification-agent.js");
    expect(notifier).toContain("MAC_NOTIFIER_BIN");
    expect(notifier).toContain("<key>KeepAlive</key>");
    expect(manager).toContain("build_macos_notifier");
    expect(manager).toContain('NOTIFIER_APP="$DATA_DIR/bin/OzonGMVNotifier.app"');
    expect(manager).toContain('NOTIFIER_BIN="$NOTIFIER_APP/Contents/MacOS/OzonGMVNotifier"');
    expect(manager).toContain("codesign --force --deep --sign -");
    expect(manager).toContain('"$launch_services_register" -f "$NOTIFIER_APP"');

    const appInfo = readFileSync("installer/macos/OzonGMVNotifier.Info.plist", "utf8");
    const nativeHelper = readFileSync("installer/macos/OzonGMVNotifier.swift", "utf8");
    expect(appInfo).toContain("com.ozon.gmv-notifier");
    expect(appInfo).toContain("<key>LSUIElement</key>");
    expect(appInfo).toContain("<key>CFBundleIconFile</key>");
    expect(manager).toContain("OzonGMVNotifier.icns");
    expect(nativeHelper).toContain("UNUserNotificationCenter.current()");
    expect(nativeHelper).toContain("UNNotificationAttachment");
    expect(nativeHelper).toContain('writeStandardOutput("DELIVERED")');
  });

  it("registers the Windows helper for user login and stops it during upgrades", () => {
    const installer = readFileSync("installer/windows/setup.iss", "utf8");
    const launcher = readFileSync("installer/windows/notification-agent.vbs", "utf8");
    expect(installer).toContain("manage-notifier.ps1");
    expect(installer).toContain("runasoriginaluser waituntilterminated");
    expect(installer).toContain('AppUserModelID: "com.ozon.gmv-dashboard"');
    const serviceInstaller = readFileSync("installer/windows/install-service.ps1", "utf8");
    expect(serviceInstaller).toContain("Stop-NotificationAgent");
    expect(serviceInstaller).toContain("$process.CommandLine.Contains($NotificationAgentScript)");
    expect(serviceInstaller).toContain("Remove-NotificationTask");
    const taskManager = readFileSync("installer/windows/manage-notifier.ps1", "utf8");
    expect(taskManager).toContain('New-ScheduledTaskTrigger -AtLogOn');
    expect(taskManager).toContain('-LogonType Interactive');
    expect(launcher).toContain("notification-agent.js");
    expect(launcher).toContain('InStr(LCase(process.CommandLine), "notification-agent.js")');
    expect(launcher).toContain("shell.Run(command, 0, True)");
  });
});
