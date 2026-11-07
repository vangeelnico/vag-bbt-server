# VAG BBT-server - automatische update (draait elke 15 min als geplande taak, als SYSTEM)
# 1. Kijkt of er op GitHub (branch main) iets nieuws is.
# 2. Zo ja: code ophalen, controleren, server herstarten.
# 3. Start de nieuwe versie niet goed op: vorige versie terugzetten.

$ErrorActionPreference = "Stop"
$Root      = "C:\vag-bbt"
$Repo      = Split-Path -Parent $PSScriptRoot
$TokenFile = Join-Path $Root "github-token.txt"
$LogFile   = Join-Path $Root "logs\update.log"
$TaskName  = "VAG BBT-server"
$Branch    = "main"

function Log($t) { Add-Content -Path $LogFile -Value ("{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $t) }

# Leesbare token-header (token staat enkel in een beveiligd bestand, nooit in .git/config)
if (-not (Test-Path $TokenFile)) { Log "FOUT: $TokenFile ontbreekt"; exit 1 }
$token = (Get-Content $TokenFile -Raw).Trim()
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$token"))
$gitArgs = @("-c", "safe.directory=$($Repo -replace '\\','/')", "-c", "http.extraHeader=Authorization: Basic $basic", "-C", $Repo)

# (Windows PowerShell 5.1 ziet tekst op stderr van git/node als fout; daarom lokaal "Continue" en zelf de exitcode controleren.)
function Git {
  param([Parameter(ValueFromRemainingArguments)]$a)
  $ErrorActionPreference = "Continue"
  $out = & git @gitArgs @a 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) { throw "git $($a[0]) mislukt: $($out -join ' ')" }
  return ($out -join "`n")
}

# Poort uit .env
$Port = "8787"
Get-Content (Join-Path $Root ".env") | ForEach-Object { if ($_ -match "^\s*PORT\s*=\s*(\d+)") { $Port = $Matches[1] } }

function Restart-Server {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*server\http.js*" } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
  Start-Sleep -Seconds 1
  Start-ScheduledTask -TaskName $TaskName
}
function Test-Server {
  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 2
    try { $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/" -TimeoutSec 5; if ($r.Content -match "draait") { return $r.Content } } catch {}
  }
  return $null
}

try {
  Git fetch --quiet origin $Branch | Out-Null
  $old = (Git rev-parse HEAD).Trim()
  $new = (Git rev-parse "origin/$Branch").Trim()
  if ($old -eq $new) { exit 0 }   # niets nieuw: stil stoppen

  Log "Nieuwe versie gevonden: $($old.Substring(0,7)) -> $($new.Substring(0,7))"
  Git reset --hard --quiet $new | Out-Null

  # Syntaxcontrole voor we herstarten
  foreach ($f in Get-ChildItem (Join-Path $Repo "server") -Filter *.js) {
    $ErrorActionPreference = "Continue"
    & node --check $f.FullName 2>&1 | Out-Null
    $ErrorActionPreference = "Stop"
    if ($LASTEXITCODE -ne 0) { throw "syntaxfout in $($f.Name)" }
  }

  Restart-Server
  $ok = Test-Server
  if (-not $ok) { throw "server start niet met de nieuwe versie" }
  Log "OK: $ok"
}
catch {
  Log "FOUT: $($_.Exception.Message)"
  if ($old -and $new -and $old -ne $new) {
    try {
      Git reset --hard --quiet $old | Out-Null
      Restart-Server
      $ok = Test-Server
      Log ("Teruggezet naar {0}: {1}" -f $old.Substring(0,7), $(if ($ok) { $ok } else { "SERVER REAGEERT NIET" }))
    } catch { Log "Terugzetten mislukt: $($_.Exception.Message)" }
  }
  exit 1
}
