# LOCAL TEST KIT: starts the public site (http://localhost:3005) and the admin site (http://localhost:3006) in two windows.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
if (-not (Test-Path ".env.local")) { Write-Host "Run scripts\local-setup.ps1 first." -ForegroundColor Red; exit 1 }
docker compose -f docker-compose.local.yml up -d --wait
if ($LASTEXITCODE -ne 0) { Write-Host "The database did not start. Is Docker Desktop running?" -ForegroundColor Red; exit 1 }
# Bring the database up to date every start, so pages from newly merged work have their tables and example data.
node --env-file=.env.local scripts/migrate.mjs
if ($LASTEXITCODE -ne 0) { Write-Host "Database migration failed. See the message above." -ForegroundColor Red; exit 1 }
node --env-file=.env.local scripts/seed-demo.mjs
node --env-file=.env.local scripts/seed-admin-demo.mjs
$dir = (Get-Location).Path
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$dir'; `$env:APP_MODE='public'; `$env:NEXT_DIST_DIR='.next'; `$Host.UI.RawUI.WindowTitle='PUBLIC site 3005'; npx next dev -p 3005"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$dir'; `$env:APP_MODE='admin'; `$env:NEXT_DIST_DIR='.next-admin'; `$Host.UI.RawUI.WindowTitle='ADMIN site 3006'; npx next dev -p 3006"
Write-Host "Two windows opened. Wait about 30 seconds, then open:"
Write-Host "  Public: http://localhost:3005/dev-login"
Write-Host "  Admin:  http://localhost:3006/dev-login"
Write-Host "Close the two windows to stop the sites."
