param([string]$DatabasePath = "$env:USERPROFILE\.codex-antigravity-pm\project.db")

$ErrorActionPreference = "Stop"
$kitRoot = $PSScriptRoot
$pluginRoot = Join-Path $kitRoot "plugins\codex-antigravity-pm"
$serverRoot = Join-Path $pluginRoot "server"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 22.5+ is required." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is required." }
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { throw "Codex CLI is required." }

Push-Location $serverRoot
try {
  npm install
  npm test
} finally { Pop-Location }

codex plugin marketplace add $kitRoot
if ($LASTEXITCODE -ne 0) { throw "Failed to add Codex marketplace." }
codex plugin add codex-antigravity-pm@codex-antigravity-local
if ($LASTEXITCODE -ne 0) { throw "Failed to install Codex plugin. Close Codex and run install.cmd again." }

& (Join-Path $pluginRoot "scripts\configure-antigravity.ps1") -DatabasePath $DatabasePath
Write-Host "Installation complete. Restart Codex, then refresh MCP servers in Antigravity."
