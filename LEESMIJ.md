# BBT DMS – koppeling voor Claude (v0.2.2)

## Installeren / bijwerken
1. Dubbelklik op `bbt-dms.mcpb` (of sleep het naar Claude › Instellingen › Extensies).
2. Klik op **Installeren** (vervangt de vorige versie "BBT DMS (alleen lezen)").
3. Vul je **BBT API-key** in als erom gevraagd wordt (BBT › Instellingen › Algemeen › Bedrijf › API-key).
4. Start een nieuw gesprek.

## Lezen
Planning en vrije slots, facturen en factuur-PDF's, orders (werkorders, bestekken, offertes, bestelbonnen, leveringsbons, tickets), klanten en contactpersonen, klantwagens, stockwagens, zoeken op wagen of klant, artikels en stockaantallen, leveranciers, uurregistratie, garanties en de BBT-codes (config).

## Stockwagen aanmaken (nieuw)
Geef Claude bv. een Yucon-PDF en zeg *"Maak deze wagen aan in BBT"*.
1. **Controleren** – Claude vult de gegevens in en de koppeling controleert: verplichte velden, VIN, datums, prijzen, kW/pk, BBT-codes, en of het VIN al in de stock staat. Je krijgt een volledig voorstel met een **bevestigingscode**. Er verandert nog niets in BBT.
2. **Aanmaken** – pas als jij "ok" zegt (en de Claude-app toestemming vraagt), wordt exact dat voorstel naar BBT gestuurd. Daarna leest de koppeling de wagen terug en meldt afwijkingen.

Veiligheid:
- Bestaande wagens worden nooit gewijzigd; een VIN dat al in de stock staat wordt geweigerd.
- Een bevestigingscode is 30 minuten geldig en één keer bruikbaar.
- Elke aanmaak wordt gelogd in `export/stockwagens-aangemaakt.log.jsonl`.
- Testomgeving: de publieke BBT-testsleutel werkt momenteel niet (vraag een eigen testsleutel aan helpdesk@bbt-cloud.be).

Niet via de API: **opties, foto's en publicatie** blijven manueel in BBT.

## Exports
`Documenten/Claude Local/BBT_server/export` (JSON + CSV voor Excel, factuur-PDF's in `facturen`).

## Problemen
- "Geen API-key": vul de key in bij de instellingen van de extensie.
- "Authenticatie mislukt": key nakijken of aanvragen via helpdesk@bbt-cloud.be.
- Werkt alleen als je Mac aanstaat en de Claude-app open is.
