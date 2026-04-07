# Registers a Windows Scheduled Task to run the KungFu DB backup once per day.
#
# 1) Edit $BackupDir and $DailyAt below (use another drive, OneDrive, or UNC for real redundancy).
# 2) Open PowerShell as Administrator (Right-click → Run as administrator).
# 3) Run:
#      Set-Location 'D:\dev\AI\kungfu'   # your clone path
#      .\scripts\register-daily-backup-task.ps1
#
# Remove the task later: Unregister-ScheduledTask -TaskName 'KungFu daily DB backup' -Confirm:$false

$BackupDir = 'D:\Backups\KungFu'
$DailyAt = '03:15'

$TaskName = 'KungFu daily DB backup'
$Wrapper = Join-Path $PSScriptRoot 'backup-daily.ps1'
if (-not (Test-Path -LiteralPath $Wrapper)) {
  throw "Missing script: $Wrapper"
}

$arg = "-NoProfile -ExecutionPolicy Bypass -File `"$Wrapper`" -BackupDir `"$BackupDir`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
$trigger = New-ScheduledTaskTrigger -Daily -At $DailyAt
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force `
  -Description 'SQLite online backup for KungFu (scripts/backup-db.mjs). Edit task arguments or re-run register script to change folder.'

Write-Host "Registered scheduled task '$TaskName' daily at $DailyAt -> $BackupDir"
Write-Host 'Logs append to logs\backup-daily.log under the project folder.'
