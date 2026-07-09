# Register yimsg server as a Windows scheduled task that starts at boot
# (even if nobody logs in) and restarts automatically after a crash.
# Deploy directory: C:\yimsg (separate from the dev repo).
#
# Run this from an elevated (Administrator) PowerShell:
#   powershell -ExecutionPolicy Bypass -File tools\scripts\install-windows-autostart.ps1

$ErrorActionPreference = "Stop"

$deployRoot = "C:\yimsg"
$serverExe = Join-Path $deployRoot "server.exe"
$configFile = Join-Path $deployRoot "config.toml"
$taskName = "YimsgServer"

if (-not (Test-Path $serverExe)) {
    Write-Error "server.exe not found at $serverExe"
}
if (-not (Test-Path $configFile)) {
    Write-Error "config.toml not found at $configFile"
}

Write-Host "Step 1: remove old task if present"
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "old task removed"
}

Write-Host "Step 2: stop any running server.exe"
Get-Process -Name server -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

Write-Host "Step 3: open firewall for TCP 80"
if (-not (Get-NetFirewallRule -DisplayName "Yimsg HTTP 80" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "Yimsg HTTP 80" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow | Out-Null
    Write-Host "firewall rule added"
} else {
    Write-Host "firewall rule already exists"
}

Write-Host "Step 4: build action/trigger/settings/principal"
$action = New-ScheduledTaskAction -Execute $serverExe -Argument "config.toml" -WorkingDirectory $deployRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Write-Host "Step 5: register task"
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null

Write-Host "Step 6: start once to verify"
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName $taskName | Select-Object LastRunTime, LastTaskResult
Get-Process -Name server -ErrorAction SilentlyContinue | Select-Object Id, StartTime, Path

try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1/" -UseBasicParsing -TimeoutSec 5
    Write-Host "http://127.0.0.1/ -> $($r.StatusCode)"
} catch {
    Write-Host "http://127.0.0.1/ FAILED: $($_.Exception.Message)"
}
