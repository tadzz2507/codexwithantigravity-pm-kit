@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
if errorlevel 1 exit /b %errorlevel%
echo.
echo Installation complete. Restart Codex, then refresh MCP in Antigravity.
