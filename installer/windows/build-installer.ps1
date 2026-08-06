param(
  [string]$Version = "",
  [string]$IsccPath = ""
)

$ErrorActionPreference = "Stop"
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "Windows installer must be built on Windows x64."
}

$WindowsDir = $PSScriptRoot
$ProjectDir = Resolve-Path (Join-Path $WindowsDir "..\..")
$StageDir = Join-Path $WindowsDir "stage"
$NodeVersion = "24.18.0"
$NodeArchiveName = "node-v$NodeVersion-win-x64.zip"
$NodeSha256 = "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821"
$WinSwVersion = "2.12.0"
$WinSwSha256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da"

if (-not $Version) {
  $Version = (Get-Content (Join-Path $ProjectDir "package.json") -Raw | ConvertFrom-Json).version
}
if (Test-Path $StageDir) {
  Remove-Item $StageDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $StageDir, (Join-Path $StageDir "runtime"), (Join-Path $StageDir "app") | Out-Null

$DownloadDir = Join-Path $StageDir "downloads"
New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null
$NodeArchive = Join-Path $DownloadDir $NodeArchiveName
Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/$NodeArchiveName" -OutFile $NodeArchive
if ((Get-FileHash $NodeArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $NodeSha256) {
  throw "Node.js archive checksum mismatch."
}
Expand-Archive $NodeArchive -DestinationPath $DownloadDir
$NodeSource = Join-Path $DownloadDir "node-v$NodeVersion-win-x64"
Copy-Item (Join-Path $NodeSource "node.exe"), (Join-Path $NodeSource "LICENSE") -Destination (Join-Path $StageDir "runtime")

$WinSwTarget = Join-Path $StageDir "OzonGMVService.exe"
Invoke-WebRequest "https://github.com/winsw/winsw/releases/download/v$WinSwVersion/WinSW-x64.exe" -OutFile $WinSwTarget
if ((Get-FileHash $WinSwTarget -Algorithm SHA256).Hash.ToLowerInvariant() -ne $WinSwSha256) {
  throw "WinSW checksum mismatch."
}

$env:Path = "$NodeSource;$env:Path"
Push-Location $ProjectDir
try {
  & (Join-Path $NodeSource "npm.cmd") ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
  & (Join-Path $NodeSource "npm.cmd") run typecheck
  if ($LASTEXITCODE -ne 0) { throw "Type checking failed." }
  & (Join-Path $NodeSource "npm.cmd") test
  if ($LASTEXITCODE -ne 0) { throw "Tests failed." }
  & (Join-Path $NodeSource "npm.cmd") run build
  if ($LASTEXITCODE -ne 0) { throw "Application build failed." }
} finally {
  Pop-Location
}

$StageApp = Join-Path $StageDir "app"
Copy-Item (Join-Path $ProjectDir "package.json"), (Join-Path $ProjectDir "package-lock.json") -Destination $StageApp
Copy-Item (Join-Path $ProjectDir "dist") -Destination $StageApp -Recurse
Copy-Item (Join-Path $ProjectDir "migrations") -Destination $StageApp -Recurse
Push-Location $StageApp
try {
  & (Join-Path $NodeSource "npm.cmd") ci --omit=dev --ignore-scripts=false
  if ($LASTEXITCODE -ne 0) { throw "Production dependency installation failed." }
} finally {
  Pop-Location
}

if (-not $IsccPath) {
  $candidates = @(
    "${env:ProgramFiles}\Inno Setup 7\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
  )
  $IsccPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $IsccPath -or -not (Test-Path $IsccPath)) {
  throw "Inno Setup compiler was not found. Install Inno Setup 7 or pass -IsccPath."
}

& $IsccPath "/DAppVersion=$Version" (Join-Path $WindowsDir "setup.iss")
if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup compilation failed."
}
Write-Host "Installer created at: $(Join-Path $WindowsDir "output\OzonGMV-Setup-$Version.exe")"
