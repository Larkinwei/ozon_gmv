param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir
)

$ErrorActionPreference = "Stop"
$TaskName = "OzonGMVNotifications"
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
  Start-ScheduledTask -TaskName $TaskName
  exit 0
}

$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($currentIdentity -eq "NT AUTHORITY\SYSTEM") {
  # Automatic upgrades reuse the task registered by the original interactive installer.
  exit 0
}

$launcher = Join-Path $InstallDir "notification-agent.vbs"
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR "System32\wscript.exe") -Argument "`"$launcher`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentIdentity
$principal = New-ScheduledTaskPrincipal -UserId $currentIdentity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
