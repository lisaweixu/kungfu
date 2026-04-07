# Daily backup wrapper for Task Scheduler: finds Node, sets KUNGFU_BACKUP_DIR, runs backup-db.mjs, logs output.
# Usage (manual test):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\backup-daily.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\backup-daily.ps1 -BackupDir "D:\Backups\KungFu"

param(
  [string] $BackupDir = $env:KUNGFU_BACKUP_DIR
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ProjectRoot 'logs'
if (-not (Test-Path -LiteralPath $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir | Out-Null
}
$LogFile = Join-Path $LogDir 'backup-daily.log'

function Write-LogLine([string] $Message) {
  $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $Message
  Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8
}

try {
  if ([string]::IsNullOrWhiteSpace($BackupDir)) {
    $BackupDir = Join-Path $env:USERPROFILE 'KungFuBackups'
  }
  $env:KUNGFU_BACKUP_DIR = $BackupDir

  $node = $null
  foreach ($p in @(
      (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
    )) {
    if (Test-Path -LiteralPath $p) {
      $node = $p
      break
    }
  }
  if (-not $node) {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
      $node = $cmd.Source
    }
  }
  if (-not $node) {
    throw 'Node.js (node.exe) not found. Install Node 22.5+ or add it to PATH.'
  }

  $mjs = Join-Path $ProjectRoot 'scripts\backup-db.mjs'
  if (-not (Test-Path -LiteralPath $mjs)) {
    throw "Missing $mjs"
  }

  $prevNodeOpts = $env:NODE_OPTIONS
  if ([string]::IsNullOrWhiteSpace($env:NODE_OPTIONS)) {
    $env:NODE_OPTIONS = '--no-warnings'
  }
  elseif ($env:NODE_OPTIONS -notmatch '--no-warnings(\s|$)') {
    $env:NODE_OPTIONS = ($env:NODE_OPTIONS.TrimEnd() + ' --no-warnings')
  }

  Write-LogLine "----"
  Write-LogLine "Starting backup (node: $node) -> KUNGFU_BACKUP_DIR=$BackupDir"

  $outLog = Join-Path $env:TEMP ("kungfu-backup-out-{0}.txt" -f [Guid]::NewGuid().ToString('n'))
  $errLog = Join-Path $env:TEMP ("kungfu-backup-err-{0}.txt" -f [Guid]::NewGuid().ToString('n'))
  try {
    $proc = Start-Process -FilePath $node -ArgumentList "`"$mjs`"" -WorkingDirectory $ProjectRoot `
      -Wait -PassThru -NoNewWindow `
      -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    foreach ($line in (Get-Content -LiteralPath $outLog -ErrorAction SilentlyContinue)) {
      Write-LogLine $line
    }
    foreach ($line in (Get-Content -LiteralPath $errLog -ErrorAction SilentlyContinue)) {
      Write-LogLine $line
    }
    if ($proc.ExitCode -ne 0) {
      throw ("backup-db.mjs exited with code {0}" -f $proc.ExitCode)
    }
  }
  finally {
    Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue
    if ($null -eq $prevNodeOpts) {
      Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    }
    else {
      $env:NODE_OPTIONS = $prevNodeOpts
    }
  }

  Write-LogLine 'Finished OK.'
}
catch {
  Write-LogLine "ERROR: $($_.Exception.Message)"
  exit 1
}
