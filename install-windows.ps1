param([string]$DatabasePath = "$env:USERPROFILE\.codex-antigravity-pm\project.db")

$ErrorActionPreference = "Stop"
$kitRoot = $PSScriptRoot
$pluginRoot = Join-Path $kitRoot "plugins\codex-antigravity-pm"
$serverRoot = Join-Path $pluginRoot "server"
$serverPath = Join-Path $serverRoot "dist\index.js"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 22.5+ is required." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is required." }
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { throw "Codex CLI is required." }
$nodePath = (Get-Command node -ErrorAction Stop).Source

function Configure-DirectCodexMcp {
  codex mcp remove antigravity_pm 2>$null | Out-Null
  codex mcp add antigravity_pm --env "PM_ROLE=manager" --env "PM_ACTOR=codex" --env "PM_DB_PATH=$DatabasePath" -- $nodePath $serverPath
  if ($LASTEXITCODE -ne 0) { throw "Failed to configure the direct Codex MCP fallback." }
  Write-Host "Codex MCP configured directly from $serverPath"
}

Push-Location $serverRoot
try {
  npm install
  npm test
} finally { Pop-Location }

codex plugin marketplace add $kitRoot
if ($LASTEXITCODE -ne 0) { throw "Failed to add Codex marketplace." }
if (Get-Process -Name codex-code-mode-host -ErrorAction SilentlyContinue) {
  Write-Warning "Codex Desktop is running, so the plugin cache is locked. Using direct MCP mode."
  Configure-DirectCodexMcp
} else {
  codex plugin add codex-antigravity-pm@codex-antigravity-local
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Plugin installation failed. Using direct MCP mode."
    Configure-DirectCodexMcp
  }
}

& (Join-Path $pluginRoot "scripts\configure-antigravity.ps1") -DatabasePath $DatabasePath
Write-Host "Installation complete. Restart Codex, then refresh MCP servers in Antigravity."
