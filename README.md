# VAG BBT-server

MCP-koppeling tussen Claude en de BBT-DMS (bbt-cloud.be) van VAG N.V.
Pure Node.js (geen externe pakketten).

## Inhoud
- `server/index.js` – leesfuncties (planning, facturen, orders, klanten, stock, ...)
- `server/stockwagen.js` – stockwagen controleren + aanmaken (met bevestigingscode)
- `manifest.json` – voor de Claude Desktop-extensie (.mcpb)

## Geheimen
De BBT API-key staat **nooit** in deze repo. Lokaal via de extensie-instellingen,
op de server via een `.env`-bestand (zie `.env.example`).

## Planning
- v0.2.2: lokaal op de MacBook (stdio)
- volgende: draaien op de vaste Windows-pc, bereikbaar via ngrok, met login (OAuth)
