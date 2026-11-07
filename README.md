# VAG BBT-server

MCP-koppeling tussen Claude en de BBT-DMS (bbt-cloud.be) van VAG N.V.
Pure Node.js, geen externe pakketten.

Twee manieren om te draaien:
- **Lokaal (MacBook, Claude Desktop)**: `server/index.js` via stdio, verpakt als `.mcpb`-extensie.
- **Webversie (vaste Windows-pc)**: `server/http.js`, bereikbaar via ngrok, met login (OAuth 2.1 + wachtwoord).

## Inhoud
- `server/index.js` – alle BBT-functies (planning, facturen, orders, klanten, stock, ...)
- `server/stockwagen.js` – stockwagen controleren + aanmaken (met bevestigingscode)
- `server/http.js` – webversie met login
- `windows/` – installatie- en updatescripts voor de Windows-pc
- `manifest.json` – voor de Claude Desktop-extensie

## Geheimen
De BBT API-key, het wachtwoord en de ngrok-token staan **nooit** in deze repo.
Op de Windows-pc staan ze in `C:\vag-bbt\.env` en `C:\vag-bbt\ngrok.yml`
(enkel leesbaar voor administrators). Tokens van ingelogde clients worden enkel als hash bewaard.

---

## Installatie op de Windows-pc

### 1. Programma's installeren
PowerShell openen **als administrator** en:
```powershell
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Git.Git
winget install -e --id Ngrok.Ngrok
```
Sluit PowerShell daarna en open een **nieuw** venster als administrator.

### 2. Code ophalen
```powershell
New-Item -ItemType Directory -Force C:\vag-bbt | Out-Null
cd C:\vag-bbt
git clone https://github.com/vangeelnico/vag-bbt-server.git
cd vag-bbt-server
```
Git vraagt de eerste keer om in te loggen bij GitHub (browser).

### 3. Klaarleggen
- **ngrok-domein**: dashboard.ngrok.com > Domains – noteer je gratis adres (`xxx.ngrok-free.app`).
- **ngrok-authtoken**: dashboard.ngrok.com > Your Authtoken.
- **BBT API-key**: BBT > Instellingen > Algemeen > Bedrijf > API-key.
- **Wachtwoord**: kies een nieuw, lang wachtwoord (min. 12 tekens). Hiermee geef je Claude toegang.

### 4. Installeren
```powershell
powershell -ExecutionPolicy Bypass -File .\windows\install-windows.ps1
```
Het script opent Kladblok voor de instellingen, vraagt je ngrok-authtoken, en zet
de server en ngrok zo dat ze vanzelf starten na een herstart of crash.

### 5. Koppelen in Claude
Claude > Instellingen > Connectors > **Aangepaste connector toevoegen**
- Naam: `BBT DMS`
- URL: `https://xxx.ngrok-free.app/mcp`

Claude opent een loginpagina: geef je wachtwoord in. Klaar.

## Bijwerken
Na een wijziging op GitHub, op de Windows-pc (als administrator):
```powershell
cd C:\vag-bbt\vag-bbt-server
powershell -ExecutionPolicy Bypass -File .\windows\update-windows.ps1
```

## Problemen
- Logbestand: `C:\vag-bbt\logs\server.log`
- Werkt de server lokaal? Browser op de pc: `http://127.0.0.1:8787/`
- Werkt ngrok? Browser: `https://xxx.ngrok-free.app/` (eenmalig ngrok-waarschuwing wegklikken)
- ngrok herstarten: `ngrok service restart`
- Alle toegang intrekken: stop de server, verwijder `C:\vag-bbt\data\oauth.json`, start opnieuw.
  Wijzig ook `ADMIN_PASSWORD` als je vermoedt dat het gelekt is.

## Beperkingen
- Factuur-PDF's en exports worden op de Windows-pc bewaard (`C:\vag-bbt\export`), niet op je MacBook.
- Gratis ngrok: 20.000 aanvragen en 1 GB per maand – ruim voor testen.
