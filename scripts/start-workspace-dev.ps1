$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$serviceName = "OzonGMVService"
$taskName = "OzonGMVNotifications"

function Stop-InstalledService {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if (-not $service -or $service.Status -eq "Stopped") {
    return
  }

  $servicePath = (Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction SilentlyContinue).PathName
  $serviceExe = if ($servicePath) { $servicePath.Trim('"') } else { $null }
  if ($serviceExe -and (Test-Path $serviceExe)) {
    Write-Host "Stopping installed Ozon GMV service..."
    & $serviceExe stop | Out-Host
    return
  }

  Stop-Service -Name $serviceName -Force
}

function Stop-InstalledNotificationAgent {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) {
    return
  }

  Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
  $launcherArgument = ($task.Actions | Select-Object -First 1).Arguments
  $launcherPath = $launcherArgument.Trim('"')
  $installDir = Split-Path -Parent $launcherPath
  $installedAgentScript = Join-Path $installDir "app\dist\server\notification-agent.js"
  $processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
  foreach ($process in $processes) {
    if ($process.CommandLine -and $process.CommandLine.Contains($installedAgentScript)) {
      Write-Host "Stopping installed notification agent PID $($process.ProcessId)..."
      Invoke-CimMethod -InputObject $process -MethodName Terminate | Out-Null
    }
  }
}

$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($service) {
  Stop-InstalledService
  try {
    Set-Service -Name $serviceName -StartupType Manual
  } catch {
    Write-Warning "Installed service stopped, but startup type could not be changed. Run Set-Service -Name OzonGMVService -StartupType Manual from an elevated PowerShell."
  }
}

Stop-InstalledNotificationAgent

$listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in @(3001, 3002) }
if ($listeners) {
  $details = ($listeners | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) PID $($_.OwningProcess)" }) -join ", "
  throw "Ports 3001/3002 are still occupied: $details"
}

$env:DATA_DIR = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $env:ProgramData "Ozon GMV Dashboard" }
$env:OZON_GMV_ADMIN_URL = "http://127.0.0.1:3001"
$env:OZON_GMV_UI_URL = "http://127.0.0.1:5173"

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $env:DATA_DIR "config") -ErrorAction Stop | Out-Null
} catch {
  throw "Cannot write DATA_DIR '$env:DATA_DIR'. Run this command from an elevated PowerShell first: icacls `"$env:DATA_DIR`" /grant `"$([System.Security.Principal.WindowsIdentity]::GetCurrent().Name):(OI)(CI)M`" /T"
}

Write-Host "Starting current workspace from $workspace"
Write-Host "DATA_DIR=$env:DATA_DIR"
Write-Host "Live UI: http://127.0.0.1:5173"
Push-Location $workspace
try {
  npm run dev
} finally {
  Pop-Location
}
