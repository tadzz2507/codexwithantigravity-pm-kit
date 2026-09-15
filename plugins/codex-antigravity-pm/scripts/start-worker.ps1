param(
  [Parameter(Mandatory = $true)][string]$ProjectId,
  [Parameter(Mandatory = $true)][string]$RepositoryPath,
  [string]$DatabasePath = "$env:USERPROFILE\.codex-antigravity-pm\project.db",
  [int]$PollSeconds = 20,
  [ValidateRange(10, 480)][int]$TurnTimeoutMinutes = 120
)

$ErrorActionPreference = "Stop"
function ConvertTo-ProcessArgument([string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $builder = [Text.StringBuilder]::new().Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') { $backslashes++; continue }
    if ($character -eq '"') {
      [void]$builder.Append('\', ($backslashes * 2) + 1).Append('"')
    } else {
      if ($backslashes) { [void]$builder.Append('\', $backslashes) }
      [void]$builder.Append($character)
    }
    $backslashes = 0
  }
  if ($backslashes) { [void]$builder.Append('\', $backslashes * 2) }
  return $builder.Append('"').ToString()
}

$pluginRoot = Split-Path -Parent $PSScriptRoot
$serverRoot = Join-Path $pluginRoot "server"
$workerPath = Join-Path $serverRoot "dist\worker.js"
$stateDir = Join-Path $env:USERPROFILE ".codex-antigravity-pm\runners"
$statePath = Join-Path $stateDir "$ProjectId.pid"
$logPath = Join-Path $stateDir "$ProjectId.log"
if (-not (Test-Path -LiteralPath $workerPath)) { throw "Worker is not built. Run install.cmd first." }
if ($RepositoryPath -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') { throw "RepositoryPath must be absolute: $RepositoryPath" }
if (-not (Test-Path -LiteralPath $RepositoryPath -PathType Container)) { throw "Repository not found: $RepositoryPath" }
if (-not (Get-Command agy -ErrorAction SilentlyContinue)) { throw "Antigravity CLI 'agy' was not found." }
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$mutexName = "Local\codex-antigravity-pm-worker-$($ProjectId -replace '[^A-Za-z0-9_.-]', '_')"
$mutex = [Threading.Mutex]::new($false, $mutexName)
if (-not $mutex.WaitOne(0)) {
  Write-Host "Worker start already in progress for $ProjectId."
  $mutex.Dispose()
  exit 0
}

try {
  if (Test-Path -LiteralPath $statePath) {
    try { $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json } catch { $state = $null }
    $existingPid = if ($state -and $state.Pid) { [int]$state.Pid } else { 0 }
    $existing = if ($existingPid) { Get-Process -Id $existingPid -ErrorAction SilentlyContinue } else { $null }
    if ($existing -and $state.StartTimeUtc -and $existing.StartTime.ToUniversalTime().ToString("o") -eq [string]$state.StartTimeUtc) {
      Write-Host "Worker already running for $ProjectId (PID $existingPid)."
      exit 0
    }
    Remove-Item -LiteralPath $statePath -Force
  }

  $nodePath = (Get-Command node -ErrorAction Stop).Source
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $nodePath
  $startInfo.WorkingDirectory = $serverRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $processArguments = @($workerPath, "--project", $ProjectId, "--repo", $RepositoryPath, "--poll", "$PollSeconds", "--log", $logPath)
  $startInfo.Arguments = ($processArguments | ForEach-Object { ConvertTo-ProcessArgument ([string]$_) }) -join ' '
  $startInfo.Environment["PM_DB_PATH"] = $DatabasePath
  $startInfo.Environment["PM_TURN_TIMEOUT_MINUTES"] = "$TurnTimeoutMinutes"
  $process = [Diagnostics.Process]::Start($startInfo)
  if (-not $process) { throw "Failed to start background worker." }
  $state = [pscustomobject]@{ Pid = $process.Id; StartTimeUtc = $process.StartTime.ToUniversalTime().ToString("o") }
  $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
  Write-Host "Background worker started for $ProjectId (PID $($process.Id))."
  Write-Host "Log: $logPath"
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
