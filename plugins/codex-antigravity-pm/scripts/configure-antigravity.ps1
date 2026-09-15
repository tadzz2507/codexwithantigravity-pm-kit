param(
  [string]$DatabasePath = "$env:USERPROFILE\.codex-antigravity-pm\project.db",
  [string]$Actor = "antigravity"
)

$ErrorActionPreference = "Stop"
$pluginRoot = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $pluginRoot "server\dist\index.js"
if (-not (Test-Path -LiteralPath $serverPath)) {
  throw "Missing $serverPath. Run npm install and npm run build in the server folder first."
}
$nodePath = (Get-Command node -ErrorAction Stop).Source

$configPath = Join-Path $env:USERPROFILE ".gemini\config\mcp_config.json"
$configDir = Split-Path -Parent $configPath
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
if (Test-Path -LiteralPath $configPath) {
  Copy-Item -LiteralPath $configPath -Destination "$configPath.backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
  $raw = Get-Content -Raw -LiteralPath $configPath
  $config = if ([string]::IsNullOrWhiteSpace($raw)) { [pscustomobject]@{} } else { $raw | ConvertFrom-Json }
} else {
  $config = [pscustomobject]@{}
}
if ($null -eq $config) { $config = [pscustomobject]@{} }
if (-not $config.PSObject.Properties["mcpServers"] -or $null -eq $config.mcpServers) {
  $config | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{})
}
$entry = [pscustomobject]@{
  command = $nodePath
  args = @($serverPath)
  cwd = (Join-Path $pluginRoot "server")
  env = [pscustomobject]@{ PM_ROLE = "worker"; PM_ACTOR = $Actor; PM_DB_PATH = $DatabasePath }
  startup_timeout_sec = 30
  tool_timeout_sec = 60
  default_tools_approval_mode = "auto"
}
$config.mcpServers | Add-Member -Force -NotePropertyName "codex-antigravity-pm" -NotePropertyValue $entry
$config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $configPath -Encoding utf8
Write-Host "Antigravity MCP configured at $configPath"
Write-Host "Refresh Installed MCP Servers in Antigravity, then use /mcp to verify."
