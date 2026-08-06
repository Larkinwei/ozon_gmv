param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("prepare", "install", "uninstall")]
  [string]$Phase,
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,
  [Parameter(Mandatory = $true)]
  [string]$DataDir,
  [switch]$DeleteData
)

$ErrorActionPreference = "Stop"
$ServiceName = "OzonGMVService"
$ServiceExe = Join-Path $InstallDir "OzonGMVService.exe"
$RollbackRoot = Join-Path $DataDir "backups\upgrade-rollback"
$RollbackProgram = Join-Path $RollbackRoot "program"
$RollbackState = Join-Path $RollbackRoot "state.json"

function Stop-OzonService {
  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($service -and $service.Status -ne "Stopped") {
    Stop-Service -Name $ServiceName -Force
    $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
  }
}

function Unregister-OzonService {
  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    if (Test-Path $ServiceExe) {
      & $ServiceExe uninstall | Out-Null
    } else {
      & sc.exe delete $ServiceName | Out-Null
    }
  }
}

function Protect-DataDirectory {
  New-Item -ItemType Directory -Force -Path $DataDir, (Join-Path $DataDir "data"), (Join-Path $DataDir "config"), (Join-Path $DataDir "logs"), (Join-Path $DataDir "backups") | Out-Null
  & icacls.exe $DataDir /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
}

function Save-DetectedProxy {
  $internetSettings = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction SilentlyContinue
  if (-not $internetSettings -or $internetSettings.ProxyEnable -ne 1 -or -not $internetSettings.ProxyServer) {
    return
  }
  $proxy = [string]$internetSettings.ProxyServer
  if ($proxy.Contains(";")) {
    $httpsEntry = ($proxy.Split(";") | Where-Object { $_ -like "https=*" } | Select-Object -First 1)
    $proxy = if ($httpsEntry) { $httpsEntry.Substring(6) } else { $proxy.Split(";")[0].Split("=")[-1] }
  }
  if (-not $proxy.Contains("://")) {
    $proxy = "http://$proxy"
  }
  $proxyJson = @{ proxy = $proxy } | ConvertTo-Json
  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText((Join-Path $DataDir "config\detected-proxy.json"), $proxyJson, $utf8WithoutBom)
}

function Restore-PreviousVersion {
  Stop-OzonService
  Unregister-OzonService
  if (-not (Test-Path $RollbackProgram)) {
    return
  }
  Get-ChildItem -LiteralPath $InstallDir -Force | Remove-Item -Recurse -Force
  Copy-Item -Path (Join-Path $RollbackProgram "*") -Destination $InstallDir -Recurse -Force
  if (Test-Path $RollbackState) {
    $state = Get-Content $RollbackState -Raw | ConvertFrom-Json
    if ($state.databaseBackup -and (Test-Path $state.databaseBackup)) {
      $databasePath = Join-Path $DataDir "data\ozon-gmv.db"
      Remove-Item "$databasePath-wal", "$databasePath-shm" -Force -ErrorAction SilentlyContinue
      Copy-Item $state.databaseBackup $databasePath -Force
    }
  }
  if (Test-Path $ServiceExe) {
    & $ServiceExe install | Out-Null
    & $ServiceExe start | Out-Null
  }
}

if ($Phase -eq "prepare") {
  Protect-DataDirectory
  Save-DetectedProxy
  $databaseBackup = $null
  $serviceWasInstalled = [bool](Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)
  if (Test-Path (Join-Path $InstallDir "runtime\node.exe")) {
    try {
      Stop-OzonService
      $maintenance = Join-Path $InstallDir "app\dist\server\maintenance.js"
      if (Test-Path $maintenance) {
        $env:DATA_DIR = $DataDir
        $databaseBackup = & (Join-Path $InstallDir "runtime\node.exe") $maintenance backup-upgrade
        if ($LASTEXITCODE -ne 0) { throw "Upgrade backup failed." }
      }
      New-Item -ItemType Directory -Force -Path $RollbackRoot | Out-Null
      if (Test-Path $RollbackProgram) {
        Remove-Item $RollbackProgram -Recurse -Force
      }
      New-Item -ItemType Directory -Force -Path $RollbackProgram | Out-Null
      Copy-Item -Path (Join-Path $InstallDir "*") -Destination $RollbackProgram -Recurse -Force
      @{ databaseBackup = $databaseBackup; preparedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } |
        ConvertTo-Json | Set-Content -Encoding UTF8 $RollbackState
      Unregister-OzonService
    } catch {
      if ($serviceWasInstalled) {
        Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
      }
      throw
    }
  }
  exit 0
}

if ($Phase -eq "uninstall") {
  Stop-OzonService
  Unregister-OzonService
  & netsh.exe advfirewall firewall delete rule name="Ozon GMV Wallboard (Private LAN)" | Out-Null
  if ($DeleteData -and (Test-Path $DataDir)) {
    Remove-Item $DataDir -Recurse -Force
  }
  exit 0
}

Protect-DataDirectory
try {
  & $ServiceExe install | Out-Null
  & sc.exe config $ServiceName start= delayed-auto | Out-Null
  & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
  & sc.exe failureflag $ServiceName 1 | Out-Null
  & netsh.exe advfirewall firewall delete rule name="Ozon GMV Wallboard (Private LAN)" | Out-Null
  & netsh.exe advfirewall firewall add rule name="Ozon GMV Wallboard (Private LAN)" dir=in action=allow protocol=TCP localport=3002 profile=private remoteip=localsubnet | Out-Null
  & $ServiceExe start | Out-Null

  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    Start-Sleep -Seconds 2
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3001/readyz" -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        $ready = $true
        break
      }
    } catch {}
  }
  if (-not $ready) {
    throw "Ozon GMV service did not become ready within 60 seconds."
  }
} catch {
  Restore-PreviousVersion
  throw
}
