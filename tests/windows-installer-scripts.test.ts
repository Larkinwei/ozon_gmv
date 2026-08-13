import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function installerFile(name: string): string {
  return readFileSync(resolve("installer", "windows", name), "utf8");
}

describe("Windows upgrade recovery scripts", () => {
  it("force-stops only the verified service process tree and records the actual failure", () => {
    const serviceScript = installerFile("install-service.ps1");
    const installerDefinition = installerFile("setup.iss");

    expect(serviceScript).toContain('$process.Name -ne "OzonGMVService.exe"');
    expect(serviceScript).toContain("taskkill.exe /PID $serviceProcess.ProcessId /T /F");
    expect(serviceScript).toContain('Write-InstallLog "Upgrade preparation failed:');
    expect(installerDefinition).toContain("logs\\installer.log");
  });

  it("keeps a manual data and program backup before the clean reinstall", () => {
    const repairScript = readFileSync(resolve("scripts", "repair-windows-upgrade.ps1"), "utf8");
    const backupIndex = repairScript.lastIndexOf("Backup-OzonData");
    const unregisterIndex = repairScript.lastIndexOf("Remove-OzonServiceRegistration $ServiceExecutable");
    const moveIndex = repairScript.lastIndexOf("Move-Item -LiteralPath $InstallDir");

    expect(backupIndex).toBeGreaterThan(-1);
    expect(unregisterIndex).toBeGreaterThan(backupIndex);
    expect(moveIndex).toBeGreaterThan(unregisterIndex);
    expect(repairScript).not.toContain("Remove-Item $DataDir");
  });
});
