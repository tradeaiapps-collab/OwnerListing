# LOCAL TEST KIT: wipes the local database and loads fresh demo data. Your .env.local is kept.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
if (-not (Test-Path ".env.local")) { Write-Host "Run scripts\local-setup.ps1 first." -ForegroundColor Red; exit 1 }
Write-Host "This deletes ALL local test data (not your code). Close the two site windows first." -ForegroundColor Yellow
if ((Read-Host "Type YES to continue") -ne "YES") { Write-Host "Cancelled."; exit 0 }
docker compose -f docker-compose.local.yml down -v
docker compose -f docker-compose.local.yml up -d --wait
if ($LASTEXITCODE -ne 0) { Write-Host "The database did not start." -ForegroundColor Red; exit 1 }
node --env-file=.env.local scripts/migrate.mjs
if ($LASTEXITCODE -ne 0) { exit 1 }
node --env-file=.env.local scripts/seed-demo.mjs
Write-Host "Reset done. Start the sites with scripts\local-start.ps1"
