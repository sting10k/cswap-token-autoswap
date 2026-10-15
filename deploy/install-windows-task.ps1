# Registers the watcher as Scheduled Task "ClaudeTokenAutoswap": starts at logon, re-launched every 5 min
# if it died (single instance is enforced by watcher.pid), runs headless via conhost.
$ErrorActionPreference = "Stop"
$appDir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$cswap = (Get-Command cswap).Source
$null = Get-Command claude

$action = New-ScheduledTaskAction -Execute "conhost.exe" `
  -Argument "--headless `"$node`" `"$appDir\token-autoswap-watcher.js`"" -WorkingDirectory $appDir
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit 0 -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "ClaudeTokenAutoswap" -Action $action -Trigger $atLogon, $watchdog `
  -Settings $settings -Force | Out-Null
# Pin cswap's path so the task doesn't depend on PATH at logon
[Environment]::SetEnvironmentVariable("CSWAP_BIN", $cswap, "User")
Start-ScheduledTask -TaskName "ClaudeTokenAutoswap"
Get-ScheduledTask -TaskName "ClaudeTokenAutoswap" | Select-Object TaskName, State
