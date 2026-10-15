# Start the production gateway on Windows. Reads .env from the repository root.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Test-Path apps/gateway/dist/index.js) -or -not (Test-Path apps/web/dist/index.html)) { throw 'Not built yet. Run scripts\setup.ps1 first.' }
node --disable-warning=ExperimentalWarning apps/gateway/dist/index.js
