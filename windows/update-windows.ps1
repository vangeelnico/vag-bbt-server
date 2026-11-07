# VAG BBT-server - nieuwste versie ophalen en herstarten
# Uitvoeren in PowerShell ALS ADMINISTRATOR, vanuit de repo-map:
#   powershell -ExecutionPolicy Bypass -File .\windows\update-windows.ps1

$ErrorActionPreference = "Stop"
$Repo     = Split-Path -Parent $PSScriptRoot
$TaskName = "VAG BBT-server"

Set-Location $Repo
git pull --ff-only
if ($LASTEXITCODE -ne 0) { Write-Host "git pull mislukt - niets herstart." -ForegroundColor Red; exit 1 }

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*server\http.js*" } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
try { $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8787/" -TimeoutSec 5; Write-Host "Bijgewerkt: $($r.Content)" -ForegroundColor Green }
catch { Write-Host "Server reageert niet. Kijk in C:\vag-bbt\logs\server.log" -ForegroundColor Red }
