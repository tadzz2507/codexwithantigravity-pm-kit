param([Parameter(Mandatory = $true)][string]$ProjectId)

$statePath = Join-Path $env:USERPROFILE ".codex-antigravity-pm\runners\$ProjectId.pid"
if (-not (Test-Path -LiteralPath $statePath)) { Write-Host "Worker not started for $ProjectId."; exit 0 }
$state = $null
try { $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json } catch { }
$runnerPid = if ($state -and $state.Pid) { [int]$state.Pid } else { 0 }
$process = if ($runnerPid) { Get-Process -Id $runnerPid -ErrorAction SilentlyContinue } else { $null }
$matchesState = $process -and $state.StartTimeUtc -and $process.StartTime.ToUniversalTime().ToString("o") -eq [string]$state.StartTimeUtc
if ($matchesState) {
  & taskkill.exe /PID $runnerPid /T /F | Out-Null
  Write-Host "Worker and child processes stopped for $ProjectId."
}
else { Write-Host "Worker was already stopped for $ProjectId." }
Remove-Item -LiteralPath $statePath -Force
