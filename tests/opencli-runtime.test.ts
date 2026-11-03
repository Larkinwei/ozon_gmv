import { describe, expect, it } from "vitest";

import { normalizeOpenCliArguments, parseOpenCliDoctorOutput } from "../src/server/services/opencli-runtime";

describe("OpenCLI runtime", () => {
  it("parses the plain doctor report produced by global OpenCLI 1.x", () => {
    const report = parseOpenCliDoctorOutput(`opencli v1.8.6 doctor (node v25.8.1)

[OK] Daemon: running on port 19825 (v1.8.6)
[OK] Extension: connected (v1.0.26)

Profiles:
  • profile-id: connected v1.0.26
[OK] Connectivity: connected in 0.4s

Everything looks good!`);

    expect(report).toMatchObject({
      cliVersion: "1.8.6",
      daemonRunning: true,
      extensionConnected: true,
      extensionVersion: "1.0.26",
      connectivity: { ok: true },
    });
    expect(report.profiles).toHaveLength(1);
  });

  it("keeps the structured doctor report produced by bundled OpenCLI 2.x", () => {
    const report = parseOpenCliDoctorOutput(JSON.stringify({
      cliVersion: "2.0.2",
      daemonRunning: true,
      extensionConnected: true,
      extensionVersion: "2.0.0",
      connectivity: { ok: true },
      profiles: [{ contextId: "profile-id", extensionConnected: true }],
    }));

    expect(report.cliVersion).toBe("2.0.2");
    expect(report.extensionConnected).toBe(true);
    expect(report.profiles).toHaveLength(1);
  });

  it("uses the positional browser session required by OpenCLI 1.x", () => {
    expect(normalizeOpenCliArguments(["browser", "price-job", "state"], 1)).toEqual([
      "browser", "price-job", "state",
    ]);
  });

  it("uses the session option required by OpenCLI 2.x", () => {
    expect(normalizeOpenCliArguments(["browser", "price-job", "state"], 2)).toEqual([
      "browser", "state", "--session", "price-job",
    ]);
  });
});
