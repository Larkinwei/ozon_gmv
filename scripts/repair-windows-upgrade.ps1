#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"
$ServiceName = "OzonGMVService"
$DefaultInstallDir = Join-Path $env:ProgramFiles "Ozon GMV Dashboard"
$DataDir = Join-Path $env:ProgramData "Ozon GMV Dashboard"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$DesktopDir = [Environment]::GetFolderPath("Desktop")
if (-not $DesktopDir) {
  $DesktopDir = $env:TEMP
}
$BackupDir = Join-Path $DesktopDir "Ozon-GMV-manual-backup-$Timestamp"

function Get-OzonService {
  Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
}

function Get-ServiceExecutablePath([string]$PathName) {
  if ($PathName -match '^"([^"]+)"') {
    return $Matches[1]
  }
  if ($PathName -match '^(.+?\.exe)(?:\s|$)') {
    return $Matches[1]
  }
  return $null
}

function Stop-OzonServiceTree {
  $service = Get-OzonService
  if (-not $service) {
    return
  }

  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  for ($attempt = 0; $attempt -lt 15; $attempt += 1) {
    Start-Sleep -Seconds 1
    $service = Get-OzonService
    if (-not $service -or $service.State -eq "Stopped") {
      return
    }
  }

  $service = Get-OzonService
  if (-not $service -or $service.ProcessId -eq 0) {
    return
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($service.ProcessId)" -ErrorAction SilentlyContinue
  $serviceExecutable = if ($process) { Get-ServiceExecutablePath $process.CommandLine } else { $null }
  if (-not $serviceExecutable -or [IO.Path]::GetFileName($serviceExecutable) -ne "OzonGMVService.exe") {
    throw "拒绝终止无法确认身份的服务进程 PID $($service.ProcessId)。"
  }

  & taskkill.exe /PID $service.ProcessId /T /F | Out-Null
  Start-Sleep -Seconds 2
  $service = Get-OzonService
  if ($service -and $service.State -ne "Stopped") {
    throw "旧版服务仍未停止，请重启电脑后再次运行此脚本。"
  }
}

function Backup-OzonData {
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
  foreach ($name in @("data", "config")) {
    $source = Join-Path $DataDir $name
    if (Test-Path $source) {
      Copy-Item -LiteralPath $source -Destination $BackupDir -Recurse -Force
    }
  }
}

function Remove-OzonServiceRegistration([string]$ServiceExecutable) {
  if (Test-Path $ServiceExecutable) {
    & $ServiceExecutable uninstall | Out-Null
  }
  if (Get-OzonService) {
    & sc.exe delete $ServiceName | Out-Null
  }
  for ($attempt = 0; $attempt -lt 10; $attempt += 1) {
    if (-not (Get-OzonService)) {
      return
    }
    Start-Sleep -Seconds 1
  }
  throw "旧服务注册仍被 Windows 占用，请重启电脑后直接运行新版安装器。"
}

$service = Get-OzonService
$serviceExecutable = if ($service) { Get-ServiceExecutablePath $service.PathName } else { $null }
$InstallDir = if ($serviceExecutable) { Split-Path -Parent $serviceExecutable } else { $DefaultInstallDir }
$ServiceExecutable = Join-Path $InstallDir "OzonGMVService.exe"
$PreviousProgramDir = "$InstallDir.old-$Timestamp"

Write-Host "1/4 正在停止旧版服务..."
Stop-OzonServiceTree
Write-Host "2/4 正在备份业务数据到 $BackupDir ..."
Backup-OzonData
Write-Host "3/4 正在注销旧版服务..."
Remove-OzonServiceRegistration $ServiceExecutable
if (Test-Path $InstallDir) {
  Write-Host "4/4 正在保留并移走旧程序到 $PreviousProgramDir ..."
  Move-Item -LiteralPath $InstallDir -Destination $PreviousProgramDir
}

Write-Host ""
Write-Host "修复完成。现在请右键以管理员身份运行 OzonGMV-Setup-1.4.0.exe。" -ForegroundColor Green
Write-Host "业务数据备份：$BackupDir"
if (Test-Path $PreviousProgramDir) {
  Write-Host "旧程序备份：$PreviousProgramDir"
}
