// Stockwagen aanmaken in BBT – in twee stappen:
//   1. bbt_stockwagen_controleren  → valideert, zoekt dubbels, vertaalt codes, toont voorbeeld + bevestigingscode
//   2. bbt_stockwagen_aanmaken     → stuurt EXACT het gecontroleerde voorstel door (enkel via de code) en verifieert
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// API-veld → { label, soort, get (veldnaam in carpark/getCars), verplicht }
// soort: str = tekst, num = bedrag/getal (als getal verstuurd), nstr = getal als tekst (zoals BBT-voorbeeld), code = integer-code, date = JJJJ-MM-DD
const FIELDS = {
  type:                { label: "Soort wagen (code, bv. 4 = consignatie)", soort: "code", get: "type", verplicht: true, config: ["type", "types", "cartype_kind", "kind"] },
  marge:               { label: "Margewagen (1 = marge, 0 = btw-wagen)", soort: "code", get: "car_vat_type", verplicht: true },
  carType:             { label: "Carrosserietype (code)", soort: "code", get: "car_type", config: ["carType", "carTypes", "car_type", "car_types", "bodyType", "bodyTypes", "body"] },
  brand:               { label: "Merk", soort: "str", get: "brand", verplicht: true },
  model:               { label: "Model", soort: "str", get: "model", verplicht: true },
  modelExecution:      { label: "Uitvoering", soort: "str", get: "model_execution" },
  modelCode:           { label: "Modelcode (car_code)", soort: "str", get: "car_code" },
  referenceNumber:     { label: "Referentienummer", soort: "str", get: "reference" },
  chassisNumber:       { label: "Chassisnummer (VIN)", soort: "str", get: "chassis_number", verplicht: true },
  purchasePrice:       { label: "Aankoopprijs (excl. btw)", soort: "num", get: "purchase_price", verplicht: true },
  desiredSellingPrice: { label: "Gewenste verkoopprijs", soort: "num", get: "desired_selling_price", verplicht: true },
  sellingPrice:        { label: "Verkoopprijs", soort: "num", get: "selling_price" },
  newPrice:            { label: "Nieuwprijs", soort: "num", get: "new_price" },
  color:               { label: "Kleur", soort: "str", get: "color" },
  km:                  { label: "Kilometerstand", soort: "nstr", get: "km", verplicht: true },
  engineNumber:        { label: "Motornummer", soort: "str", get: "engine_number" },
  pvgNumber:           { label: "PVG-nummer", soort: "str", get: "pvg_number" },
  cylinders:           { label: "Cilinders", soort: "nstr", get: "cylinders" },
  cylinderCapacity:    { label: "Cilinderinhoud (cc)", soort: "nstr", get: "cylinders_capacity" },
  firstSubscription:   { label: "Eerste inschrijving", soort: "date", get: "first_subscription", verplicht: true },
  purchaseDate:        { label: "Aankoopdatum", soort: "date", get: "purchase_date" },
  deliveryDate:        { label: "Leveringsdatum", soort: "date", get: "delivery_date" },
  co2:                 { label: "CO2", soort: "nstr", get: "co2" },
  co2Wltp:             { label: "CO2 WLTP", soort: "nstr", get: "co2_wltp" },
  co2Nedc:             { label: "CO2 NEDC", soort: "nstr", get: "co2_nedc" },
  fuelCombined:        { label: "Verbruik gemengd", soort: "nstr", get: "fuel_combined" },
  fuelCity:            { label: "Verbruik stad", soort: "nstr", get: "fuel_city" },
  fuelRoads:           { label: "Verbruik buiten stad", soort: "nstr", get: "fuel_roads" },
  pk:                  { label: "Vermogen (pk)", soort: "nstr", get: "horsepower" },
  fiscalPower:         { label: "Fiscale pk", soort: "nstr", get: "fiscal_power" },
  kw:                  { label: "Vermogen (kW)", soort: "nstr", get: "kw" },
  doors:               { label: "Deuren", soort: "nstr", get: "doors" },
  batteryCapacity:     { label: "Batterijcapaciteit", soort: "nstr", get: "battery_capacity" },
  loadConnection:      { label: "Laadaansluiting", soort: "str", get: "load_connection" },
  fastLoadConnection:  { label: "Snellaadaansluiting", soort: "str", get: "fast_load_connection" },
  fastLoadPower:       { label: "Snellaadvermogen", soort: "nstr", get: "fast_load_power" },
  radius:              { label: "Actieradius", soort: "nstr", get: "radius" },
  vehicleConsumption:  { label: "Elektrisch verbruik", soort: "nstr", get: "vehicle_consumption" },
  weight:              { label: "Gewicht (kg)", soort: "nstr", get: "weight" },
  fuel:                { label: "Brandstof (code)", soort: "code", get: "fuel", verplicht: true, config: ["fuel", "fuels", "fuelType", "fuelTypes"] },
  transmission:        { label: "Transmissie (code)", soort: "code", get: "transmission", verplicht: true, config: ["transmission", "transmissions"] },
  euronorm:            { label: "Euronorm (code)", soort: "code", get: "euronorm", config: ["euronorm", "euronorms", "euroNorm", "euroNorms"] },
  keycode:             { label: "Sleutelcode", soort: "str", get: "keycode" },
  securityCode:        { label: "Veiligheidscode", soort: "str", get: "security_code" },
  buildyear:           { label: "Bouwjaar", soort: "nstr", get: "buildyear" },
  documentNumber:      { label: "Documentnummer", soort: "str", get: "docnumber" },
  interior:            { label: "Interieur", soort: "str", get: "interior" },
  gears:               { label: "Aantal versnellingen", soort: "nstr", get: "gears" },
  amountKeys:          { label: "Aantal sleutels", soort: "nstr", get: "amount_keys" },
  warranty:            { label: "Garantie (code)", soort: "code", get: "warranty", config: ["warranty", "warranties", "garantie"] },
};

// Extra velden (niet gedocumenteerd): we sturen de BBT-veldnaam én gangbare varianten mee;
// BBT negeert onbekende sleutels, de controle achteraf toont welke variant werkt.
const EXTRA_ALIASES = {
  colorcode: ["colorCode", "color_code"],
  interiorcode: ["interiorCode", "interior_code"],
  car_code: ["carCode"],
  framenr: ["frameNr", "frameNumber", "fin", "finNumber"],
  transmission_nr: ["transmissionNr", "transmissionNumber", "gearboxNumber"],
  damage_details: ["damageDetails"],
  location: ["locationId"],
  supplier: ["supplierId"],
  memo: ["remarks", "remark"],
};
function aliasesFor(k) {
  const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const snake = k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
  return [...new Set([camel, snake, ...(EXTRA_ALIASES[k] || [])])].filter((x) => x !== k);
}

// labels uit bestaande stockwagens (betrouwbaar, zoals BBT ze zelf toont)
const STOCK_LABELS = { fuel: "fuel_label", transmission: "transmission_label", euronorm: "euronorm_label" };

const PENDING_TTL_MS = 30 * 60 * 1000;
const pending = new Map(); // code → { payload, extra, test, at, preview }

// ---------------------------------------------------------------- helpers
function norm(k) { return String(k).toLowerCase().replace(/[_\s-]/g, ""); }

function labelText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object") {
    for (const k of ["NL", "nl", "name_nl", "label_nl", "name", "label", "description", "title", "value", "text"]) {
      if (v[k] !== undefined && v[k] !== null && typeof v[k] !== "object") return String(v[k]);
      if (v[k] && typeof v[k] === "object") { const t = labelText(v[k]); if (t) return t; }
    }
  }
  return null;
}

// Zoek een configsectie (object of lijst) op basis van naamhints. Geeft Map code → label terug, of null.
function configSection(config, hints) {
  if (!config || typeof config !== "object" || !hints) return null;
  const want = hints.map(norm);
  let sec = null;
  const visit = (obj, depth) => {
    if (sec || !obj || typeof obj !== "object" || depth > 2) return;
    for (const [k, v] of Object.entries(obj)) {
      if (want.includes(norm(k)) && v && typeof v === "object") { sec = v; return; }
    }
    for (const v of Object.values(obj)) if (v && typeof v === "object" && !Array.isArray(v)) visit(v, depth + 1);
  };
  visit(config, 0);
  if (!sec) return null;
  const map = new Map();
  if (Array.isArray(sec)) {
    for (const it of sec) {
      if (!it || typeof it !== "object") continue;
      const id = ["id", "value", "key", "code", "ID", "Id"].map((k) => it[k]).find((x) => x !== undefined && x !== null);
      if (id === undefined) continue;
      const rest = { ...it }; delete rest.id; delete rest.value; delete rest.key; delete rest.code;
      map.set(String(id), labelText(rest) || labelText(it) || "?");
    }
  } else {
    for (const [k, v] of Object.entries(sec)) map.set(String(k), labelText(v) || "?");
  }
  return map.size ? map : null;
}

function toDate(v) {
  if (v === undefined || v === null || v === "") return "";
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/); // DD/MM/JJJJ (Belgisch)
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  throw new Error(`ongeldige datum '${s}' (gebruik JJJJ-MM-DD)`);
}

function validDate(s) {
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

function toNumber(v, label) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return v;
  // "29.000,50" / "29000.50" / "29 000" / "€ 29.000"
  let s = String(v).replace(/[€\s]/g, "");
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  if (!isFinite(n)) throw new Error(`${label}: '${v}' is geen geldig getal`);
  return n;
}

function sameValue(sent, stored, soort) {
  if (stored === undefined) return null;
  const a = sent === null || sent === undefined ? "" : String(sent).trim();
  const b = stored === null || stored === undefined ? "" : String(stored).trim();
  if (soort === "num" || soort === "nstr" || soort === "code") {
    if (a === "" && (b === "" || Number(b) === 0)) return true;
    const na = Number(a), nb = Number(b);
    if (a !== "" && b !== "" && isFinite(na) && isFinite(nb)) return Math.abs(na - nb) < 0.005;
  }
  if (soort === "date" && a === "" && (b === "" || b.startsWith("0000"))) return true;
  return a.toLowerCase() === b.toLowerCase();
}

function fmt(v) {
  if (v === "" || v === null || v === undefined) return "—";
  return String(v);
}

function euro(n) {
  return "€ " + Number(n).toLocaleString("nl-BE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = function ({ bbtPost, getConfig, EXPORT_DIR, TEST_API_KEY, API_KEY, log }) {
  const keyFor = (test) => (test ? TEST_API_KEY : API_KEY);

  async function stockCars(test) {
    const d = await bbtPost("/carpark/getCars/", { publishedOnly: 0 }, { key: keyFor(test) });
    if (Array.isArray(d)) return d;
    if (d && typeof d === "object") {
      let best = [];
      for (const v of Object.values(d)) if (Array.isArray(v) && v.length > best.length) best = v;
      return best;
    }
    return [];
  }

  function findByVin(cars, vin) {
    const v = vin.toUpperCase();
    return cars.filter((c) => c && [c.chassis_number, c.framenr, c.chassisNumber].some((x) => x && String(x).toUpperCase().replace(/\s/g, "") === v));
  }

  async function searchVin(vin, test) {
    try {
      const r = await bbtPost("/search/", { term: vin }, { key: keyFor(test) });
      const text = JSON.stringify(r || "");
      return text.toUpperCase().includes(vin) ? r : null;
    } catch (e) { return null; }
  }

  function auditLog(entry) {
    try {
      const dir = EXPORT_DIR;
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "stockwagens-aangemaakt.log.jsonl"), JSON.stringify({ tijd: new Date().toISOString(), ...entry }) + "\n");
    } catch (e) { log("auditlog mislukt", e.message); }
  }

  // ------------------------------------------------------------ stap 1
  async function controleren(a) {
    const test = !!a.testomgeving;
    const fouten = [];
    const waarschuwingen = [];
    const payload = {};

    for (const [k, f] of Object.entries(FIELDS)) {
      let v = a[k];
      try {
        if (f.soort === "date") v = toDate(v);
        else if (f.soort === "num") { const n = toNumber(v, f.label); v = n === null ? (k === "sellingPrice" ? 0 : "") : n; }
        else if (f.soort === "nstr") { const n = toNumber(v, f.label); v = n === null ? "" : String(n); }
        else if (f.soort === "code") {
          if (v === undefined || v === null || v === "") v = "";
          else { v = Number(v); if (!Number.isInteger(v)) throw new Error(`${f.label}: code moet een geheel getal zijn`); }
        } else v = v === undefined || v === null ? "" : String(v).trim();
      } catch (e) { fouten.push(e.message); v = ""; }
      if (f.verplicht && (v === "" || v === null)) fouten.push(`${f.label} ontbreekt (verplicht).`);
      payload[k] = v;
    }

    // VIN
    if (payload.chassisNumber) {
      payload.chassisNumber = payload.chassisNumber.toUpperCase().replace(/[\s-]/g, "");
      if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(payload.chassisNumber)) fouten.push(`Chassisnummer '${payload.chassisNumber}' is geen geldig VIN (17 tekens, zonder I, O of Q).`);
    }
    if (payload.marge !== "" && payload.marge !== 0 && payload.marge !== 1) fouten.push("Margewagen moet 0 of 1 zijn.");

    // datums & logica
    const today = new Date().toISOString().slice(0, 10);
    for (const k of ["firstSubscription", "purchaseDate", "deliveryDate"]) {
      if (payload[k] && !validDate(payload[k])) fouten.push(`${FIELDS[k].label}: '${payload[k]}' bestaat niet.`);
    }
    if (payload.firstSubscription && payload.firstSubscription > today) fouten.push("Eerste inschrijving ligt in de toekomst.");
    if (payload.purchaseDate && payload.purchaseDate > today) waarschuwingen.push("Aankoopdatum ligt in de toekomst.");
    if (!payload.purchaseDate) waarschuwingen.push("Geen aankoopdatum ingevuld.");
    if (payload.buildyear && payload.firstSubscription && Number(payload.buildyear) > Number(payload.firstSubscription.slice(0, 4))) waarschuwingen.push("Bouwjaar ligt na het jaar van eerste inschrijving.");
    if (payload.km !== "" && Number(payload.km) < 0) fouten.push("Kilometerstand kan niet negatief zijn.");
    if (payload.km !== "" && Number(payload.km) > 400000) waarschuwingen.push(`Kilometerstand ${payload.km} is ongewoon hoog — nakijken.`);
    if (typeof payload.purchasePrice === "number" && typeof payload.desiredSellingPrice === "number") {
      if (payload.desiredSellingPrice <= payload.purchasePrice) waarschuwingen.push(`Gewenste verkoopprijs (${euro(payload.desiredSellingPrice)}) is niet hoger dan de aankoopprijs (${euro(payload.purchasePrice)}).`);
      if (payload.purchasePrice <= 0) fouten.push("Aankoopprijs moet groter dan 0 zijn.");
    }
    if (typeof payload.newPrice === "number" && typeof payload.desiredSellingPrice === "number" && payload.newPrice > 0 && payload.newPrice < payload.desiredSellingPrice) waarschuwingen.push("Nieuwprijs is lager dan de gewenste verkoopprijs.");
    if (payload.kw && payload.pk) {
      const verwacht = Number(payload.kw) * 1.35962;
      if (Math.abs(verwacht - Number(payload.pk)) > 3) waarschuwingen.push(`kW (${payload.kw}) en pk (${payload.pk}) komen niet overeen (verwacht ±${Math.round(verwacht)} pk).`);
    }
    if (payload.kw && !payload.pk) payload.pk = String(Math.round(Number(payload.kw) * 1.35962));

    // codes vertalen
    let config = null, cars = [];
    try { config = await getConfig(test); } catch (e) { waarschuwingen.push("Config kon niet opgehaald worden: " + e.message); }
    try { cars = await stockCars(test); } catch (e) { fouten.push("Bestaande stock kon niet opgehaald worden voor de dubbelcontrole: " + e.message); }

    const labels = {};
    for (const [k, f] of Object.entries(FIELDS)) {
      if (f.soort !== "code" || payload[k] === "" || k === "marge") continue;
      const code = String(payload[k]);
      let label = null, gecontroleerd = false;
      // enkel in de sectie 'car' zoeken (anders matcht bv. 'type' de ordertypes)
      const sec = configSection(config && config.car && typeof config.car === "object" ? config.car : config, f.config);
      if (sec) { gecontroleerd = true; label = sec.get(code) || null; if (!label) fouten.push(`${f.label}: code ${code} bestaat niet in BBT. Geldige codes: ${[...sec.entries()].slice(0, 40).map(([c, l]) => `${c}=${l}`).join(", ")}`); }
      if (!label && STOCK_LABELS[k]) {
        const ref = cars.find((c) => String(c[f.get]) === code && c[STOCK_LABELS[k]]);
        if (ref) { label = labelText(ref[STOCK_LABELS[k]]); if (!gecontroleerd) gecontroleerd = true; }
      }
      if (!label && !gecontroleerd) {
        const voorbeeld = cars.filter((c) => String(c[f.get]) === code).slice(0, 3).map((c) => `${c.brand} ${c.model}`);
        waarschuwingen.push(`${f.label}: code ${code} kon niet vertaald worden${voorbeeld.length ? ` (gebruikt bij o.a. ${voorbeeld.join(", ")})` : " en komt in de huidige stock niet voor"} — nakijken.`);
      }
      labels[k] = label;
    }

    // dubbels
    let dubbels = [];
    if (payload.chassisNumber && cars.length) {
      dubbels = findByVin(cars, payload.chassisNumber);
      if (dubbels.length) fouten.push(`Deze wagen staat al in de BBT-stock (BBT-id ${dubbels.map((d) => d.id).join(", ")}, ${dubbels.map((d) => `${d.brand} ${d.model}`).join(", ")}). Aanmaken geweigerd om dubbels te vermijden.`);
      else {
        const s = await searchVin(payload.chassisNumber, test);
        if (s) waarschuwingen.push("Dit chassisnummer komt al voor in BBT buiten de stock (bv. als klantwagen of verkochte wagen). Nakijken of dit dezelfde wagen is.");
      }
    }

    // extra (niet-gedocumenteerde) velden
    const extra = {};
    if (a.extra_velden && typeof a.extra_velden === "object") {
      for (const [k, v] of Object.entries(a.extra_velden)) {
        if (k in FIELDS || k === "carId" || k === "token") { fouten.push(`extra_velden.${k} is geen extra veld; gebruik de gewone parameter.`); continue; }
        if (v !== undefined && v !== null && typeof v !== "object") extra[k] = typeof v === "string" ? v : v;
      }
      if (Object.keys(extra).length) waarschuwingen.push(`Extra velden (${Object.keys(extra).join(", ")}) staan niet in de BBT-documentatie; na het aanmaken controleer ik of BBT ze bewaard heeft.`);
    }

    // carId = VIN: uniek en nooit gelijk aan een intern (numeriek) BBT-id → geen risico om een bestaande wagen te overschrijven
    payload.carId = payload.chassisNumber || "";

    const regels = [];
    for (const [k, f] of Object.entries(FIELDS)) {
      const v = payload[k];
      if ((v === "" || v === null) && !f.verplicht) continue;
      let t = fmt(v);
      if (f.soort === "num" && typeof v === "number") t = euro(v);
      if (k === "marge" && v !== "") t = v === 1 ? "1 – margewagen" : "0 – btw-wagen (geen marge)";
      if (labels[k]) t += ` – ${labels[k]}`;
      regels.push(`${f.label}: ${t}`);
    }
    for (const [k, v] of Object.entries(extra)) regels.push(`[extra] ${k}: ${fmt(v)}`);

    const out = [];
    out.push(test ? "⚠️ TESTOMGEVING (BBT-demo, niet jullie echte BBT)" : "Omgeving: BBT van VAG N.V. (echt)");
    out.push("", "VOORSTEL STOCKWAGEN", ...regels.map((r) => "• " + r));
    if (typeof payload.purchasePrice === "number" && typeof payload.desiredSellingPrice === "number") {
      out.push("", `Brutomarge (gewenste verkoopprijs − aankoop): ${euro(payload.desiredSellingPrice - payload.purchasePrice)}`);
    }
    if (waarschuwingen.length) out.push("", "WAARSCHUWINGEN", ...waarschuwingen.map((w) => "• " + w));
    if (fouten.length) {
      out.push("", "FOUTEN – kan zo niet aangemaakt worden", ...fouten.map((w) => "• " + w));
      out.push("", "Geen bevestigingscode: los eerst de fouten op en controleer opnieuw.");
      return out.join("\n");
    }

    // opruimen + code uitgeven
    for (const [c, p] of pending) if (Date.now() - p.at > PENDING_TTL_MS) pending.delete(c);
    const code = crypto.createHash("sha256").update(JSON.stringify({ payload, extra, test, t: Date.now(), r: Math.random() })).digest("hex").slice(0, 6).toUpperCase();
    pending.set(code, { payload, extra, test, at: Date.now() });
    out.push("", `BEVESTIGINGSCODE: ${code} (30 minuten geldig, één keer bruikbaar)`);
    out.push("", "Toon dit volledige voorstel aan de gebruiker en roep bbt_stockwagen_aanmaken pas aan nadat de gebruiker uitdrukkelijk bevestigd heeft. Bij een wijziging: opnieuw controleren (nieuwe code).");
    return out.join("\n");
  }

  // ------------------------------------------------------------ stap 2
  async function aanmaken(a) {
    const code = String(a.bevestigingscode || "").trim().toUpperCase();
    const p = pending.get(code);
    if (!p) return "Onbekende of verlopen bevestigingscode. Voer eerst bbt_stockwagen_controleren uit en laat de gebruiker het voorstel bevestigen.";
    if (Date.now() - p.at > PENDING_TTL_MS) { pending.delete(code); return "Bevestigingscode is verlopen (30 min). Controleer opnieuw."; }
    pending.delete(code); // één keer bruikbaar
    const { payload, extra, test } = p;

    // laatste dubbelcontrole vlak voor het versturen
    const voor = await stockCars(test);
    const dubbel = findByVin(voor, payload.chassisNumber);
    if (dubbel.length) return `Niet aangemaakt: wagen met VIN ${payload.chassisNumber} staat intussen al in de stock (BBT-id ${dubbel.map((d) => d.id).join(", ")}).`;

    const vehicle = { ...payload };
    for (const [k, v] of Object.entries(extra)) {
      vehicle[k] = v;
      for (const al of aliasesFor(k)) if (!(al in vehicle) && !(al in FIELDS)) vehicle[al] = v;
    }
    let antwoord;
    try {
      antwoord = await bbtPost("/carpark/", { vehicles: [vehicle] }, { key: keyFor(test) });
    } catch (e) {
      auditLog({ resultaat: "fout", test, vin: payload.chassisNumber, fout: e.message, verstuurd: vehicle });
      return "BBT weigerde het aanmaken: " + e.message;
    }
    const antwoordTekst = typeof antwoord === "string" ? antwoord : JSON.stringify(antwoord);

    // verificatie
    let gevonden = [];
    for (let i = 0; i < 3 && !gevonden.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1500));
      try { gevonden = findByVin(await stockCars(test), payload.chassisNumber); } catch (_) {}
    }

    const out = [];
    if (test) out.push("⚠️ TESTOMGEVING (BBT-demo)");
    if (!gevonden.length) {
      auditLog({ resultaat: "niet teruggevonden", test, vin: payload.chassisNumber, antwoord: antwoordTekst.slice(0, 2000), verstuurd: vehicle });
      out.push("BBT antwoordde, maar de wagen werd (nog) niet teruggevonden in de stock. Kijk dit na in BBT voor je opnieuw probeert, om een dubbel te vermijden.");
      out.push("Antwoord van BBT: " + antwoordTekst.slice(0, 1500));
      return out.join("\n");
    }
    if (gevonden.length > 1) out.push(`⚠️ Er staan nu ${gevonden.length} wagens met dit VIN in de stock (BBT-id ${gevonden.map((g) => g.id).join(", ")}). Nakijken!`);
    const car = gevonden[gevonden.length - 1];

    const afwijkingen = [];
    for (const [k, f] of Object.entries(FIELDS)) {
      if (!f.get || payload[k] === "" || payload[k] === null) continue;
      const ok = sameValue(payload[k], car[f.get], f.soort);
      if (ok === false) afwijkingen.push(`${f.label}: verstuurd ${fmt(payload[k])}, in BBT ${fmt(car[f.get])}`);
    }
    const extraStatus = Object.keys(extra).map((k) => {
      const kand = [k, ...aliasesFor(k)].find((x) => car[x] !== undefined);
      const stored = kand ? car[kand] : undefined;
      return `${k}: ${stored !== undefined && sameValue(extra[k], stored, "str") ? "bewaard ✓" : "NIET bewaard (BBT negeert dit veld)"}`;
    });

    auditLog({ resultaat: "aangemaakt", test, bbt_id: car.id, vin: payload.chassisNumber, afwijkingen, verstuurd: vehicle });

    out.push(`✅ Stockwagen aangemaakt in BBT: ${car.brand} ${car.model} – VIN ${payload.chassisNumber}`);
    out.push(`BBT-id: ${car.id}${car.reference ? ` · referentie ${car.reference}` : ""}${car.date_created ? ` · aangemaakt ${car.date_created}` : ""}`);
    out.push(afwijkingen.length ? "Afwijkingen tussen verstuurd en bewaard:\n" + afwijkingen.map((x) => "• " + x).join("\n") : "Alle verstuurde velden staan correct in BBT.");
    if (extraStatus.length) out.push("Extra velden:\n" + extraStatus.map((x) => "• " + x).join("\n"));
    out.push("Nog manueel in BBT: opties, foto's en publicatie.");
    return out.join("\n");
  }

  // ------------------------------------------------------------ tool-definities
  const props = {};
  for (const [k, f] of Object.entries(FIELDS)) {
    const t = f.soort === "code" ? "integer" : f.soort === "num" ? "number" : f.soort === "nstr" ? ["number", "string"] : "string";
    props[k] = { type: t, description: f.label + (f.soort === "date" ? " (JJJJ-MM-DD)" : "") + (f.verplicht ? " – verplicht" : "") };
  }
  props.extra_velden = { type: "object", description: "Optioneel: velden die niet in de BBT-documentatie staan (bv. memo, options, colorcode, interiorcode, damage_details). Na het aanmaken wordt gemeld of BBT ze bewaard heeft.", additionalProperties: { type: ["string", "number"] } };
  props.testomgeving = { type: "boolean", description: "true = in de BBT-testomgeving (demo) i.p.v. de echte BBT van VAG. Handig om eerst te proberen." };

  return [
    {
      name: "bbt_stockwagen_controleren",
      description: "STAP 1 van een nieuwe stockwagen in BBT. Controleert de gegevens (verplichte velden, VIN, datums, prijzen, codes via BBT-config), zoekt dubbels op VIN en geeft een leesbaar voorstel met bevestigingscode terug. Wijzigt niets in BBT. Codes (type, carType, fuel, transmission, euronorm, warranty) haal je met bbt_config of kopieer je van een vergelijkbare wagen uit bbt_stockwagens. Vraag bij twijfel over marge/btw of prijzen (bruto/netto) eerst de gebruiker.",
      props, required: ["type", "marge", "brand", "model", "chassisNumber", "purchasePrice", "desiredSellingPrice", "km", "firstSubscription", "fuel", "transmission"],
      run: controleren,
    },
    {
      name: "bbt_stockwagen_aanmaken",
      title: "Stockwagen aanmaken in BBT",
      write: true,
      description: "STAP 2: maakt de stockwagen ECHT aan in BBT, exact zoals in het gecontroleerde voorstel. Gebruik dit ALLEEN nadat de gebruiker het voorstel van bbt_stockwagen_controleren gezien en uitdrukkelijk bevestigd heeft. Verifieert daarna wat BBT bewaard heeft.",
      props: { bevestigingscode: { type: "string", description: "De code uit bbt_stockwagen_controleren." } },
      required: ["bevestigingscode"],
      run: aanmaken,
    },
  ];
};

module.exports._internals = { FIELDS, configSection, toDate, toNumber, sameValue };
