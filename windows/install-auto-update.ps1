# VAG BBT-server - automatische update installeren
# Uitvoeren in PowerShell ALS ADMINISTRATOR, vanuit de repo-map:
#   powershell -ExecutionPolicy Bypass -File .\windows\install-auto-update.ps1

$ErrorActionPreference = "Stop"
$Root      = "C:\vag-bbt"
$Repo      = Split-Path -Parent $PSScriptRoot
$TokenFile = Join-Path $Root "github-token.txt"
$TaskName  = "VAG BBT-server auto-update"

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host "FOUT: start PowerShell als administrator." -ForegroundColor Red; exit 1 }

# 1. GitHub-token (alleen-lezen) bewaren in beveiligd bestand
if (-not (Test-Path $TokenFile)) {
  $sec = Read-Host "Plak je GitHub-token (alleen-lezen, enkel voor vag-bbt-server)" -AsSecureString
  $tok = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()
  if (-not $tok) { Write-Host "FOUT: geen token ingegeven." -ForegroundColor Red; exit 1 }
  Set-Content -Path $TokenFile -Value $tok -Encoding ascii -NoNewline
}
icacls $TokenFile /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" | Out-Null

# 2. Token testen
$tok = (Get-Content $TokenFile -Raw).Trim()
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$tok"))
$ErrorActionPreference = "Continue"
git -c "safe.directory=$($Repo -replace '\\','/')" -c "http.extraHeader=Authorization: Basic $basic" -C $Repo fetch --quiet origin main
if ($LASTEXITCODE -ne 0) { Write-Host "FOUT: token werkt niet. Verwijder $TokenFile en probeer opnieuw." -ForegroundColor Red; exit 1 }
Write-Host "Token werkt." -ForegroundColor Green
$ErrorActionPreference = "Stop"

# 3. Geplande taak elke 15 minuten
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
$action    = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Repo\windows\auto-update.ps1`"" -WorkingDirectory $Repo
$trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null

# 4. Meteen een eerste keer uitvoeren
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 15
Write-Host "`nKLAAR. Elke 15 minuten wordt GitHub gecontroleerd." -ForegroundColor Green
Write-Host "Logboek: C:\vag-bbt\logs\update.log (enkel regels bij een echte update of fout)"
if (Test-Path "C:\vag-bbt\logs\update.log") { Get-Content "C:\vag-bbt\logs\update.log" -Tail 5 }
