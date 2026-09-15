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
Check "MCP server" { if (-not (Test-Path -LiteralPath $serverPath)) { throw "missing dist/index.js" }; $serverPath } "Run install.cmd."
Check "Antigravity config" { $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json; if (-not $config.mcpServers.'codex-antigravity-pm') { throw "server entry missing" }; $configPath } "Run configure-antigravity.ps1."
Check "Database" { if (-not (Test-Path -LiteralPath $dbPath)) { throw "database not created yet" }; (Get-Item -LiteralPath $dbPath).Length.ToString() + " bytes" } "Open Codex or Antigravity once."
if ($failed) { exit 1 }
Write-Host "Harness healthy." -ForegroundColor Cyan
