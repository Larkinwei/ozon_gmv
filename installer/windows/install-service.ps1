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
$InstallLog = Join-Path $DataDir "logs\installer.log"
$NotificationAgentScript = Join-Path $InstallDir "app\dist\server\notification-agent.js"
$NotificationTaskName = "OzonGMVNotifications"

function Write-InstallLog([string]$Message) {
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $InstallLog) | Out-Null
    Add-Content -Path $InstallLog -Encoding UTF8 -Value "$([DateTimeOffset]::Now.ToString('o')) [$Phase] $Message"
  } catch {
    # Installation must not fail only because diagnostic logging is unavailable.
  }
}

function Stop-OzonService {
  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if (-not $service -or $service.Status -eq "Stopped") {
    Write-InstallLog "Service stop skipped; service state is $(if ($service) { $service.Status } else { 'not installed' })."
    return
  }

  $stopTimer = [System.Diagnostics.Stopwatch]::StartNew()
  Write-InstallLog "Requesting service stop from state $($service.Status)."
  try {
    Stop-Service -Name $ServiceName -Force -ErrorAction Stop
    $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
    Write-InstallLog "Service stopped gracefully after $([int]$stopTimer.Elapsed.TotalSeconds) seconds."
    return
  } catch {
    Write-InstallLog "Graceful stop failed: $($_.Exception.Message)"
  }

  $serviceProcess = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
  if (-not $serviceProcess -or $serviceProcess.State -eq "Stopped") {
    return
  }
  if ($serviceProcess.ProcessId -eq 0) {
    throw "Service is still $($serviceProcess.State) but has no process ID."
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($serviceProcess.ProcessId)" -ErrorAction SilentlyContinue
  if (-not $process -or $process.Name -ne "OzonGMVService.exe") {
    throw "Refusing to terminate an unverified service process with PID $($serviceProcess.ProcessId)."
  }

  Write-InstallLog "Force-stopping verified service process tree PID $($serviceProcess.ProcessId)."
  & taskkill.exe /PID $serviceProcess.ProcessId /T /F | Out-Null
  Write-InstallLog "taskkill returned exit code $LASTEXITCODE after $([int]$stopTimer.Elapsed.TotalSeconds) seconds."
  Start-Sleep -Seconds 2
  $serviceProcess = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
  if ($serviceProcess -and $serviceProcess.State -ne "Stopped") {
    throw "Service remained in state $($serviceProcess.State) after its process tree was terminated."
  }
  Write-InstallLog "Service is stopped after $([int]$stopTimer.Elapsed.TotalSeconds) seconds."
}

function Stop-NotificationAgent {
  $nodeProcesses = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
  foreach ($process in $nodeProcesses) {
    if ($process.CommandLine -and $process.CommandLine.Contains($NotificationAgentScript)) {
      Write-InstallLog "Stopping verified notification agent PID $($process.ProcessId)."
      Invoke-CimMethod -InputObject $process -MethodName Terminate | Out-Null
    }
  }
}

function Remove-NotificationTask {
  if (Get-ScheduledTask -TaskName $NotificationTaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $NotificationTaskName -Confirm:$false
  }
}

function Start-NotificationTask {
  if (Get-ScheduledTask -TaskName $NotificationTaskName -ErrorAction SilentlyContinue) {
    Start-ScheduledTask -TaskName $NotificationTaskName
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
    Start-NotificationTask
  }
}

if ($Phase -eq "prepare") {
  Write-InstallLog "Preparing an in-place upgrade (PID $PID)."
  Write-InstallLog "Protecting the data directory."
  Protect-DataDirectory
  Write-InstallLog "Data directory permissions are ready."
  Write-InstallLog "Saving detected proxy settings if available."
  Save-DetectedProxy
  Write-InstallLog "Proxy settings step completed."
  $databaseBackup = $null
  $serviceWasInstalled = [bool](Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)
  Write-InstallLog "Existing install detected: $(Test-Path (Join-Path $InstallDir 'runtime\node.exe')); service registered: $serviceWasInstalled."
  if (Test-Path (Join-Path $InstallDir "runtime\node.exe")) {
    try {
      Write-InstallLog "Stopping notification agent."
      Stop-NotificationAgent
      Write-InstallLog "Notification agent stop step completed."
      Stop-OzonService
      $maintenance = Join-Path $InstallDir "app\dist\server\maintenance.js"
      if (Test-Path $maintenance) {
        $backupTimer = [System.Diagnostics.Stopwatch]::StartNew()
        Write-InstallLog "Starting database upgrade backup."
        $env:DATA_DIR = $DataDir
        $maintenanceOutput = $null
        $maintenanceExitCode = 0
        Push-Location (Join-Path $InstallDir "app")
        try {
          $maintenanceOutput = & (Join-Path $InstallDir "runtime\node.exe") $maintenance backup-upgrade 2>&1
          $maintenanceExitCode = $LASTEXITCODE
        } finally {
          Pop-Location
        }
        if ($maintenanceExitCode -ne 0) {
          $maintenanceDetail = ($maintenanceOutput | Out-String).Trim()
          Write-InstallLog "Upgrade backup command failed: $maintenanceDetail"
          throw "Upgrade backup failed."
        }
        $databaseBackup = ([string]($maintenanceOutput | Select-Object -Last 1)).Trim()
        if (-not $databaseBackup -or -not (Test-Path $databaseBackup)) {
          throw "Upgrade backup file was not created."
        }
        Write-InstallLog "Database upgrade backup completed in $([int]$backupTimer.Elapsed.TotalSeconds) seconds."
      } else {
        Write-InstallLog "Database backup skipped; maintenance script is absent from the existing install."
      }
      Write-InstallLog "Creating rollback snapshot at $RollbackProgram."
      New-Item -ItemType Directory -Force -Path $RollbackRoot | Out-Null
      if (Test-Path $RollbackProgram) {
        Write-InstallLog "Removing previous rollback snapshot."
        Remove-Item $RollbackProgram -Recurse -Force
      }
      New-Item -ItemType Directory -Force -Path $RollbackProgram | Out-Null
      $copyTimer = [System.Diagnostics.Stopwatch]::StartNew()
      Write-InstallLog "Copying the existing installation into the rollback snapshot with bounded retries."
      & robocopy.exe $InstallDir $RollbackProgram /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /XJ /NFL /NDL /NJH /NJS | Out-Null
      $copyExitCode = $LASTEXITCODE
      if ($copyExitCode -ge 8) {
        throw "Rollback snapshot copy failed; robocopy exited with code $copyExitCode."
      }
      Write-InstallLog "Rollback snapshot copied in $([int]$copyTimer.Elapsed.TotalSeconds) seconds (robocopy code $copyExitCode)."
      @{ databaseBackup = $databaseBackup; preparedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } |
        ConvertTo-Json | Set-Content -Encoding UTF8 $RollbackState
      Write-InstallLog "Rollback state saved."
      Write-InstallLog "Unregistering the old service."
      Unregister-OzonService
      Write-InstallLog "Old service unregistered; upgrade preparation completed."
    } catch {
      Write-InstallLog "Upgrade preparation failed: $($_.Exception.Message)"
      if ($serviceWasInstalled) {
        Write-InstallLog "Attempting to restart the existing service after preparation failure."
        Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
      }
      throw
    }
  }
  exit 0
}

if ($Phase -eq "uninstall") {
  Stop-NotificationAgent
  Remove-NotificationTask
  Stop-OzonService
  Unregister-OzonService
  & netsh.exe advfirewall firewall delete rule name="Ozon GMV Wallboard (Private LAN)" | Out-Null
  & netsh.exe advfirewall firewall delete rule name="Ozon GMV Wallboard (Tailscale)" | Out-Null
  if ($DeleteData -and (Test-Path $DataDir)) {
    Remove-Item $DataDir -Recurse -Force
  }
  exit 0
}

Protect-DataDirectory
try {
  Write-InstallLog "Installing and starting the new service version (PID $PID)."
  & $ServiceExe install | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Service installation command exited with code $LASTEXITCODE." }
  Write-InstallLog "Service wrapper installed."
  & sc.exe config $ServiceName start= delayed-auto | Out-Null
  Write-InstallLog "Service startup mode configured (exit code $LASTEXITCODE)."
  & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
  & sc.exe failureflag $ServiceName 1 | Out-Null
  & netsh.exe advfirewall firewall delete rule name="Ozon GMV Wallboard (Private LAN)" | Out-Null
  & netsh.exe advfirewall firewall add rule name="Ozon GMV Wallboard (Private LAN)" dir=in action=allow protocol=TCP localport=3002 profile=private remoteip=localsubnet | Out-Null
  & netsh.exe advfirewall firewall delete rule name="Ozon GMV Wallboard (Tailscale)" | Out-Null
  & netsh.exe advfirewall firewall add rule name="Ozon GMV Wallboard (Tailscale)" dir=in action=allow protocol=TCP localport=3002 profile=any remoteip=100.64.0.0/10 | Out-Null
  Write-InstallLog "Firewall rules configured. Starting the service."
  & $ServiceExe start | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Service start command exited with code $LASTEXITCODE." }

  $ready = $false
  $readinessTimer = [System.Diagnostics.Stopwatch]::StartNew()
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    Start-Sleep -Seconds 2
    if ($attempt -in @(4, 14, 24)) {
      Write-InstallLog "Waiting for service readiness ($([int]$readinessTimer.Elapsed.TotalSeconds)/60 seconds)."
    }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3001/readyz" -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        $ready = $true
        Write-InstallLog "Service readiness check passed after $([int]$readinessTimer.Elapsed.TotalSeconds) seconds."
        break
      }
    } catch {}
  }
  if (-not $ready) {
    throw "Ozon GMV service did not become ready within 60 seconds."
  }
  Write-InstallLog "Installation completed successfully."
} catch {
  Write-InstallLog "Installation or readiness check failed: $($_.Exception.Message)"
  Restore-PreviousVersion
  throw
}
