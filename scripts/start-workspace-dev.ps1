$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in @(3101, 3102) }
if ($listeners) {
  $details = ($listeners | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) PID $($_.OwningProcess)" }) -join ", "
  throw "Workspace debug ports 3101/3102 are already occupied: $details"
}

$env:DATA_DIR = Join-Path $env:ProgramData "Ozon GMV Dashboard"
$env:ADMIN_PORT = "3101"
$env:WALLBOARD_PORT = "3102"
$env:PUBLIC_BASE_URL = "http://127.0.0.1:3101"
$env:VITE_API_PROXY_TARGET = "http://127.0.0.1:3101"
$env:OZON_GMV_ADMIN_URL = "http://127.0.0.1:3101"
$env:OZON_GMV_UI_URL = "http://127.0.0.1:5173"

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $env:DATA_DIR "config") -ErrorAction Stop | Out-Null
} catch {
  throw "Cannot write DATA_DIR '$env:DATA_DIR'. Run this command from an elevated PowerShell first: icacls `"$env:DATA_DIR`" /grant `"$([System.Security.Principal.WindowsIdentity]::GetCurrent().Name):(OI)(CI)M`" /T"
}

Write-Host "Starting current workspace from $workspace"
Write-Host "Shared DATA_DIR=$env:DATA_DIR"
Write-Host "Debug API: http://127.0.0.1:3101 (installed service remains on 3001)"
Write-Host "Live UI: http://127.0.0.1:5173"
Push-Location $workspace
try {
  npm run dev
} finally {
  Pop-Location
}
