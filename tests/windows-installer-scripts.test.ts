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

  it("runs upgrade maintenance from the installed app directory and preserves its error output", () => {
    const serviceScript = installerFile("install-service.ps1");
    const enterDirectoryIndex = serviceScript.indexOf('Push-Location (Join-Path $InstallDir "app")');
    const maintenanceIndex = serviceScript.indexOf("$maintenanceOutput = &");
    const leaveDirectoryIndex = serviceScript.indexOf("Pop-Location", maintenanceIndex);

    expect(enterDirectoryIndex).toBeGreaterThan(-1);
    expect(maintenanceIndex).toBeGreaterThan(enterDirectoryIndex);
    expect(leaveDirectoryIndex).toBeGreaterThan(maintenanceIndex);
    expect(serviceScript).toContain('Write-InstallLog "Upgrade backup command failed: $maintenanceDetail"');
  });

  it("tests a second in-place installation and verifies that an upgrade backup was created", () => {
    const workflow = readFileSync(resolve(".github", "workflows", "windows-installer.yml"), "utf8");

    expect(workflow).toContain('Install-OzonPackage "Fresh install"');
    expect(workflow).toContain('Install-OzonPackage "In-place upgrade"');
    expect(workflow).toContain('ozon-gmv-upgrade-*.db');
    expect(workflow).toContain('$notifierTask.State -ne "Running"');
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
