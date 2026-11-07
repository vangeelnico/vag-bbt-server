# VAG BBT-server - installatie op Windows
# Uitvoeren in PowerShell ALS ADMINISTRATOR, vanuit de repo-map:
#   powershell -ExecutionPolicy Bypass -File .\windows\install-windows.ps1

$ErrorActionPreference = "Stop"
$Root     = "C:\vag-bbt"
$Repo     = Split-Path -Parent $PSScriptRoot
$EnvFile  = Join-Path $Root ".env"
$NgrokCfg = Join-Path $Root "ngrok.yml"
$TaskName = "VAG BBT-server"

function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Fail($t) { Write-Host "FOUT: $t" -ForegroundColor Red; exit 1 }

# --- 0. Administrator?
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Fail "Start PowerShell als administrator (rechtermuisklik > Als administrator uitvoeren)." }

# --- 1. Benodigde programma's
Step "Programma's controleren"
foreach ($cmd in "node", "git", "ngrok") {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Fail "$cmd niet gevonden. Installeer eerst (zie README) en open een NIEUW PowerShell-venster." }
}
$nodeVer = [version]((node -v).TrimStart("v"))
if ($nodeVer -lt [version]"20.6.0") { Fail "Node $nodeVer is te oud, minstens 20.6 nodig (winget upgrade OpenJS.NodeJS.LTS)." }
Write-Host "node $nodeVer, git en ngrok gevonden."

# --- 2. Mappen
Step "Mappen aanmaken in $Root"
foreach ($d in "", "data", "export", "logs") { New-Item -ItemType Directory -Force -Path (Join-Path $Root $d) | Out-Null }

# --- 3. .env
Step "Instellingen (.env)"
if (-not (Test-Path $EnvFile)) {
  Copy-Item (Join-Path $Repo ".env.example") $EnvFile
  Write-Host "Ik open nu $EnvFile in Kladblok. Vul BBT_API_KEY, PUBLIC_URL en ADMIN_PASSWORD in, sla op en sluit Kladblok." -ForegroundColor Yellow
  Start-Process notepad.exe $EnvFile -Wait
}
$envMap = @{}
Get-Content $EnvFile | Where-Object { $_ -match "^\s*([A-Z_]+)\s*=\s*(.*)$" } | ForEach-Object { $envMap[$Matches[1]] = $Matches[2].Trim() }
if (-not $envMap["BBT_API_KEY"]) { Fail "BBT_API_KEY is leeg in $EnvFile" }
$pub = [string]$envMap["PUBLIC_URL"]
if ($pub -match "jouwnaam" -or $pub -notmatch "^https://([a-z0-9.-]+)$") { Fail "PUBLIC_URL is niet ingevuld (bv. https://xxx.ngrok-free.app, zonder / op het einde)." }
$Domain = ([uri]$pub).Host
if (($envMap["ADMIN_PASSWORD"]).Length -lt 12) { Fail "ADMIN_PASSWORD moet minstens 12 tekens zijn." }
$Port = if ($envMap["PORT"]) { $envMap["PORT"] } else { "8787" }
Write-Host "OK - publiek adres: https://$Domain/mcp"

# --- 4. ngrok-configuratie
Step "ngrok instellen"
if (-not (Test-Path $NgrokCfg)) {
  $tok = Read-Host "Plak je ngrok authtoken (ngrok dashboard > Your Authtoken)"
  if (-not $tok) { Fail "Geen authtoken ingegeven." }
@"
version: "2"
authtoken: $tok
tunnels:
  bbt:
    proto: http
    addr: 127.0.0.1:$Port
    domain: $Domain
"@ | Set-Content -Encoding ascii $NgrokCfg
}

# --- 5. Geheimen afschermen: enkel Administrators en SYSTEM
Step "Toegang tot geheimen beperken"
foreach ($p in $EnvFile, $NgrokCfg) { icacls $p /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" | Out-Null }
icacls (Join-Path $Root "data") /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" | Out-Null
Write-Host "OK"

# --- 6. Oude processen stoppen
Step "Eventuele oude versie stoppen"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*server\http.js*" } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }

# --- 7. Geplande taak: start bij opstarten, herstart bij crash
Step "Geplande taak '$TaskName' aanmaken"
$action    = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$Repo\windows\start-server.cmd`"" -WorkingDirectory $Repo
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
try { $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/" -TimeoutSec 5; Write-Host "Server draait: $($r.Content)" -ForegroundColor Green }
catch { Fail "Server reageert niet. Kijk in $Root\logs\server.log" }

# --- 8. ngrok als Windows-dienst
Step "ngrok-dienst installeren"
ngrok service uninstall 2>$null | Out-Null
ngrok service install --config $NgrokCfg
ngrok service start
Start-Sleep -Seconds 5
try { $r = Invoke-WebRequest -UseBasicParsing "https://$Domain/" -TimeoutSec 15; Write-Host "Via internet bereikbaar: $($r.Content)" -ForegroundColor Green }
catch { Write-Host "Nog niet bereikbaar via https://$Domain - wacht even en probeer in je browser. Lukt het niet: ngrok service restart" -ForegroundColor Yellow }

Write-Host "`nKLAAR. Connector-adres voor Claude: https://$Domain/mcp" -ForegroundColor Green
