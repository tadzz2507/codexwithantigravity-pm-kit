param([Parameter(Mandatory = $true)][string]$ProjectId)

$stateDir = Join-Path $env:USERPROFILE ".codex-antigravity-pm\runners"
$statePath = Join-Path $stateDir "$ProjectId.pid"
$logPath = Join-Path $stateDir "$ProjectId.log"
if (-not (Test-Path -LiteralPath $statePath)) { Write-Host "Worker not started for $ProjectId."; exit 1 }
$state = $null
try { $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json } catch { }
$runnerPid = if ($state -and $state.Pid) { [int]$state.Pid } else { 0 }
$process = if ($runnerPid) { Get-Process -Id $runnerPid -ErrorAction SilentlyContinue } else { $null }
$matchesState = $process -and $state.StartTimeUtc -and $process.StartTime.ToUniversalTime().ToString("o") -eq [string]$state.StartTimeUtc
if ($matchesState) { Write-Host "Worker running for $ProjectId (PID $runnerPid)." } else { Write-Host "Worker stopped for $ProjectId." }
if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Tail 20 }
