$ErrorActionPreference = "Stop"
$pluginRoot = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $pluginRoot "server\dist\index.js"
$configPath = Join-Path $env:USERPROFILE ".gemini\config\mcp_config.json"
$dbPath = Join-Path $env:USERPROFILE ".codex-antigravity-pm\project.db"
$failed = $false

function Check([string]$Name, [scriptblock]$Test, [string]$Fix) {
  try {
    $value = & $Test
    Write-Host ("{0,-20} OK  {1}" -f $Name, $value) -ForegroundColor Green
  } catch {
    $script:failed = $true
    Write-Host ("{0,-20} FAIL  {1}" -f $Name, $_.Exception.Message) -ForegroundColor Red
    Write-Host ("{0,-20} FIX   {1}" -f "", $Fix) -ForegroundColor Yellow
  }
}

Check "Node" { $version = node --version; if ([version]($version.TrimStart('v')) -lt [version]'22.5.0') { throw "$version; need 22.5+" }; $version } "Install Node.js 22.5+."
Check "Antigravity CLI" { (Get-Command agy -ErrorAction Stop).Source } "Install or repair Google Antigravity CLI."
Check "MCP server" { if (-not (Test-Path -LiteralPath $serverPath)) { throw "missing dist/index.js" }; $serverPath } "Run install.cmd."
Check "Antigravity config" {
  $entry = (Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json).mcpServers.'codex-antigravity-pm'
  if (-not $entry) { throw "server entry missing" }
  if ($entry.env.PM_ROLE -ne "worker" -or $entry.env.PM_ACTOR -ne "antigravity") { throw "worker role or actor mismatch" }
  if ([string]$entry.env.PM_DB_PATH -ne $dbPath) { throw "database mismatch: $($entry.env.PM_DB_PATH)" }
  if ([int]$entry.tool_timeout_sec -lt 50) { throw "tool_timeout_sec must be at least 50" }
  $configPath
} "Run configure-antigravity.ps1."
Check "MCP executable" { $entry = (Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json).mcpServers.'codex-antigravity-pm'; if (-not (Test-Path -LiteralPath $entry.command)) { throw "node executable missing: $($entry.command)" }; $entry.args | ForEach-Object { if (-not (Test-Path -LiteralPath $_)) { throw "server entry missing: $_" } }; $entry.command } "Run configure-antigravity.ps1 after building."
Check "Antigravity MCP" { $list = agy mcp list | Out-String; if ($LASTEXITCODE -ne 0 -or $list -notmatch 'codex-antigravity-pm\s+stdio\s+enabled') { throw "MCP is not enabled" }; "enabled" } "Refresh MCP servers in Antigravity or run configure-antigravity.ps1."
Check "Worker policy" { $source = Get-Content -Raw -LiteralPath (Join-Path $pluginRoot "server\src\worker-policy.ts"); if ($source -notmatch 'gemini-3\.8-flash-high' -or $source -notmatch '"--sandbox"') { throw "required model or sandbox missing" }; "gemini-3.8-flash-high / high / sandbox" } "Reinstall the current kit version."
Check "Codex MCP" { codex mcp get antigravity_pm | Out-Null; if ($LASTEXITCODE -ne 0) { throw "antigravity_pm missing" }; "configured" } "Run install.cmd."
Check "Database" { if (-not (Test-Path -LiteralPath $dbPath)) { throw "database not created yet" }; (Get-Item -LiteralPath $dbPath).Length.ToString() + " bytes" } "Open Codex or Antigravity once."
if ($failed) { exit 1 }
Write-Host "Harness healthy." -ForegroundColor Cyan
