# One-time setup on Windows (PowerShell): installs dependencies and builds the app.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$v = (node -p "process.versions.node") 2>$null
if (-not $v) { throw 'Node.js 22.13+ is required. Install the LTS from https://nodejs.org' }
$parts = $v.Split('.')
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 13)) { throw "Node.js 22.13+ is required (found $v)" }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { corepack enable }
pnpm install --frozen-lockfile
pnpm build
if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host 'Created .env - edit PCH_HOST before using from other devices.' }
Write-Host 'Setup complete. Start with: scripts\start.ps1'
