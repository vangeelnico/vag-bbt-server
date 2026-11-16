// Stockviewer – web-app om stockwagens samen met klanten te bekijken (iPad/iPhone, PWA).
// Alleen-lezen t.o.v. BBT. Leads worden lokaal bewaard (DATA_DIR/stock-leads.json).
//
// Twee soorten data, elk een eigen endpoint (beide achter dezelfde login):
//   /stock/api/cars   → KLANTVELDEN (whitelist). Nooit aankoopprijs, marge, schade, locatie, leverancier,
//                        memo, interne statussen, reservatienaam, referentie of VIN.
//   /stock/api/intern → interne velden; de app haalt die pas op bij het wisselen naar dealermodus.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CACHE_MS = 10 * 60 * 1000;          // stockdata 10 min in cache
const MIN_REFRESH_MS = 15 * 1000;          // "vernieuwen" max. 1x per 15 s naar BBT
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dagen ingelogd op de iPad
const COOKIE = "vag_stock";
const PUBLIC_DIR = path.join(__dirname, "..", "public", "stock");
const STATIC = {
  "": ["index.html", "text/html; charset=utf-8"],
  "index.html": ["index.html", "text/html; charset=utf-8"],
  "app.js": ["app.js", "text/javascript; charset=utf-8"],
  "app.css": ["app.css", "text/css; charset=utf-8"],
  "sw.js": ["sw.js", "text/javascript; charset=utf-8"],
  "manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
  "icon.svg": ["icon.svg", "image/svg+xml"],
  "icon-180.png": ["icon-180.png", "image/png"],
  "icon-192.png": ["icon-192.png", "image/png"],
  "icon-512.png": ["icon-512.png", "image/png"],
  "icon-maskable-512.png": ["icon-maskable-512.png", "image/png"],
};
const IMG_HOST = "https://bbt-storage.b-cdn.net";
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", `img-src 'self' data: ${IMG_HOST}`,
  "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'", "frame-ancestors 'none'",
  "base-uri 'none'", "form-action 'self'", "object-src 'none'",
].join("; ");

// ---------------------------------------------------------------- hulpfuncties
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("base64url");
const rnd = (n = 32) => crypto.randomBytes(n).toString("base64url");
function safeEqual(a, b) { return crypto.timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b))); }
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const str = (v) => (v === null || v === undefined ? "" : String(v)).replace(/\s+/g, " ").trim();
function plain(html) { // BBT-notities bevatten soms HTML (<br />, &nbsp;, &gt;)
  return str(String(html || "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
}
const label = (v) => (v && typeof v === "object" ? str(v.NL || v.EN || Object.values(v)[0]) : str(v));
const date = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || "")) && !String(v).startsWith("0000") ? String(v).slice(0, 10) : "");
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; } }
function writeJson(file, data) { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(data, null, 1)); fs.renameSync(tmp, file); }
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("te groot")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Kleurfamilie voor de filterchips (BBT-kleuren zijn vrije tekst: "Polarwit", "Arktic wit", "Obsidiaanzwart met.")
const KLEUREN = [
  ["Zwart", /zwart|schwarz|black|noir/], ["Wit", /wit|weiss|wei(ß|ss)|white|blanc|opalith/],
  ["Grijs", /grijs|grau|grey|gray|gris|graphit|grafiet|seleniet|berg|antraciet/],
  ["Zilver", /zilver|silber|silver|argent/], ["Blauw", /blauw|blau|blue|bleu/],
  ["Rood", /rood|rot\b|red|rouge|hyacint/], ["Groen", /groen|gr(ü|u)n|green|vert/],
  ["Bruin/beige", /bruin|braun|brown|beige|zand|kashmir|cashmere/],
];
function kleurGroep(c) { const s = c.toLowerCase(); for (const [n, re] of KLEUREN) if (re.test(s)) return n; return c ? "Andere" : ""; }
function modelGroep(model) {
  const m = str(model);
  const first = (m.split(" ")[0] || "").replace(/-$/, "");
  if (/^[A-Z]$/.test(first)) return first + "-Klasse";
  if (/^(AMG)$/i.test(first)) { const sec = m.split(" ")[1] || ""; return "AMG " + sec.replace(/\d.*/, ""); }
  return first || "Andere";
}

// ---------------------------------------------------------------- module
module.exports = function createStockviewer({ bbtPost, log, DATA_DIR }) {
  const PASSWORD = process.env.STOCK_PASSWORD || "";
  const FIXTURE = process.env.STOCK_FIXTURE || ""; // enkel voor testen: JSON-bestand i.p.v. BBT
  const LOC_FILE_LOCAL = path.join(DATA_DIR, "stock-locaties.json");
  const LEADS_FILE = path.join(DATA_DIR, "stock-leads.json");
  const SESS_FILE = path.join(DATA_DIR, "stock-sessions.json");
  if (PASSWORD && PASSWORD.length < 8) log("STOCKVIEWER: STOCK_PASSWORD is te kort (min. 8 tekens) – stockviewer uitgeschakeld.");
  const enabled = PASSWORD.length >= 8;
  if (!PASSWORD) log("STOCKVIEWER: STOCK_PASSWORD ontbreekt in .env – /stock is uitgeschakeld.");

  function locaties() {
    const def = readJson(path.join(__dirname, "stock-locaties.json"), {});
    const local = readJson(LOC_FILE_LOCAL, null);
    const cfg = local && typeof local === "object" ? { ...def, ...local } : def;
    return { namen: cfg.locaties || {}, direct: new Set((cfg.direct_beschikbaar || [1]).map(String)) };
  }

  // ------------------------------------------------ sessies (enkel hash bewaard)
  let sessions = readJson(SESS_FILE, {});
  function saveSessions() { const n = Date.now(); for (const [k, s] of Object.entries(sessions)) if (s.exp < n) delete sessions[k]; writeJson(SESS_FILE, sessions); }
  function sessionOk(req) { const t = parseCookies(req)[COOKIE]; const s = t && sessions[sha(t)]; return !!(s && s.exp > Date.now()); }
  const failures = new Map();
  const global = { n: 0, since: Date.now(), until: 0 };
  function ipOf(req) { const p = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean); return p.length ? p[p.length - 1] : req.socket.remoteAddress || "?"; }
  function locked(ip) { if (global.until > Date.now()) return true; const f = failures.get(ip); return !!(f && f.until > Date.now()); }
  function fail(ip) {
    if (Date.now() - global.since > 3600e3) { global.n = 0; global.since = Date.now(); }
    if (++global.n >= 20) { global.until = Date.now() + 15 * 60e3; global.n = 0; log("STOCKVIEWER: alle logins 15 min geblokkeerd"); }
    const f = failures.get(ip) || { n: 0, until: 0 }; f.n += 1;
    if (f.n >= 5) { f.until = Date.now() + 15 * 60e3; f.n = 0; log(`STOCKVIEWER: login geblokkeerd voor ${ip}`); }
    failures.set(ip, f);
  }

  // ------------------------------------------------ data + cache
  let cache = null; let inflight = null;
  async function fetchRaw() {
    if (FIXTURE) return readJson(FIXTURE, []);
    const d = await bbtPost("/carpark/getCars/", { publishedOnly: 0 });
    if (Array.isArray(d)) return d;
    if (d && typeof d === "object") { let best = []; for (const v of Object.values(d)) if (Array.isArray(v) && v.length > best.length) best = v; return best; }
    throw new Error("Onverwacht antwoord van BBT");
  }
  async function getCars(force = false) {
    const age = cache ? Date.now() - cache.at : Infinity;
    if (cache && (age < CACHE_MS && !force || force && age < MIN_REFRESH_MS)) return cache;
    if (!inflight) inflight = fetchRaw().then((raw) => {
      const list = raw.filter((c) => c && typeof c === "object" && !Number(c.archived) && !Number(c.invoiced) && !Number(c.sold_by) && !date(c.date_out));
      cache = { at: Date.now(), raw: list, byId: new Map(list.map((c) => [String(c.id), c])) };
      log(`STOCKVIEWER: ${list.length} wagens geladen${FIXTURE ? " (testbestand)" : " uit BBT"}`);
      return cache;
    }).finally(() => { inflight = null; });
    try { return await inflight; } catch (e) { if (cache) return cache; throw e; }
  }

  // KLANTVELDEN – whitelist. Voeg hier NOOIT interne velden toe.
  function toPublic(c, loc) {
    const pics = Array.isArray(c.pictures) ? c.pictures : [];
    const prijs = num(c.desired_selling_price);
    return {
      id: String(c.id),
      merk: str(c.brand), model: str(c.model), uitvoering: str(c.model_execution).replace(/\s*-\s*$/, ""),
      modelgroep: modelGroep(c.model),
      bouwjaar: str(c.buildyear), inschrijving: date(c.first_subscription),
      km: Math.round(num(c.km)), kleur: str(c.color), kleurgroep: kleurGroep(str(c.color)), interieur: str(c.interior),
      brandstof: label(c.fuel_label), transmissie: label(c.transmission_label),
      kw: Math.round(num(c.kw)) || null, pk: Math.round(num(c.horsepower)) || null,
      co2: str(c.co2_wltp), euronorm: str(c.euronorm_label),
      carrosserie: (str(c.website_group_label) && str(c.website_group_label) !== "Geen") ? str(c.website_group_label) : "Andere",
      deuren: str(c.doors), versnellingen: str(c.gears), cilinderinhoud: str(c.cylinders_capacity),
      prijs: prijs > 0 ? Math.round(prijs) : null,
      opties: (Array.isArray(c.options_label) ? c.options_label : []).map(str).filter(Boolean),
      fotos: pics.map((p) => ({ t: p.thumbnail || p.medium || p.large, m: p.medium || p.large || p.original, l: p.large || p.original || p.medium }))
        .filter((p) => p.m && String(p.m).startsWith(IMG_HOST)),
      carpass: /^https:\/\/([a-z0-9-]+\.)?car-pass\.be\//i.test(str(c.car_pass)) ? str(c.car_pass) : "",
      direct_beschikbaar: loc.direct.has(String(c.location)),
      gereserveerd: !!str(c.reservation),
    };
  }
  function toIntern(c, loc) {
    const lid = String(c.location ?? "");
    return {
      referentie: str(c.reference), vin: str(c.chassis_number), nummerplaat: str(c.license_plate),
      locatie: loc.namen[lid] || (lid && lid !== "0" ? "Locatie #" + lid : "–"), locatie_id: lid,
      aankoopprijs: num(c.purchase_price), marge: num(c.net_margin), nieuwprijs: num(c.new_price),
      schade: !!Number(c.damage), schade_details: plain(c.damage_details), schadebedrag: num(c.anticipated_damage_amount),
      leverancier: c.supplier ? "#" + c.supplier : "", memo: plain(c.memo), notitie: plain(c.other),
      status: str(c.status).split(";").filter(Boolean).join(", "), reservatie: plain(c.reservation),
      aankoopdatum: date(c.purchase_date),
    };
  }

  // ------------------------------------------------ leads (lokaal JSON)
  function leads() { const l = readJson(LEADS_FILE, []); return Array.isArray(l) ? l : []; }
  function clean(v, max) { return str(v).slice(0, max); }

  // ------------------------------------------------ HTTP
  const BASE_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Content-Security-Policy": CSP };
  function json(res, status, body, extra = {}) {
    res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
    res.end(JSON.stringify(body));
  }
  function serveStatic(res, name) {
    const s = STATIC[name];
    if (!s) return false;
    let body; try { body = fs.readFileSync(path.join(PUBLIC_DIR, s[0])); } catch (_) { return false; }
    const extra = name === "sw.js" ? { "Service-Worker-Allowed": "/stock/" } : {};
    res.writeHead(200, { ...BASE_HEADERS, "Content-Type": s[1], "Cache-Control": /html|javascript|css|manifest/.test(s[1]) ? "no-cache" : "public, max-age=86400", ...extra });
    res.end(body);
    return true;
  }
  // CSRF: POST's moeten JSON zijn met onze eigen header (kan een andere site niet zomaar meesturen).
  const fromApp = (req) => req.headers["x-stockviewer"] === "1" && String(req.headers["content-type"] || "").includes("application/json");

  return async function handleStock(req, res, url) {
    const raw = url.pathname;
    if (raw === "/stock") { res.writeHead(301, { Location: "/stock/" }); res.end(); return; }
    const sub = raw.slice("/stock/".length);

    if (!sub.startsWith("api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { fout: "Method not allowed" });
      if (serveStatic(res, sub)) return;
      return json(res, 404, { fout: "Niet gevonden" });
    }
    if (!enabled) return json(res, 503, { fout: "Stockviewer is niet ingesteld (STOCK_PASSWORD ontbreekt in .env)." });
    const route = sub.slice(4);

    if (route === "login" && req.method === "POST") {
      if (!fromApp(req)) return json(res, 400, { fout: "Ongeldige aanvraag" });
      const ip = ipOf(req);
      if (locked(ip)) return json(res, 429, { fout: "Te veel foute pogingen. Probeer over 15 minuten opnieuw." });
      let p = {}; try { p = JSON.parse(await readBody(req)); } catch (_) {}
      if (!safeEqual(String(p.code || ""), PASSWORD)) { fail(ip); log(`STOCKVIEWER: foute code vanaf ${ip}`); return json(res, 401, { fout: "Foute toegangscode." }); }
      failures.delete(ip);
      const t = rnd(32); sessions[sha(t)] = { exp: Date.now() + SESSION_TTL_MS, created: new Date().toISOString(), ua: String(req.headers["user-agent"] || "").slice(0, 120) }; saveSessions();
      log(`STOCKVIEWER: login ok vanaf ${ip}`);
      return json(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE}=${t}; Path=/stock; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}` });
    }
    if (route === "logout" && req.method === "POST") {
      const t = parseCookies(req)[COOKIE]; if (t) { delete sessions[sha(t)]; saveSessions(); }
      return json(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE}=; Path=/stock; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }

    if (!sessionOk(req)) return json(res, 401, { fout: "Inloggen vereist" });
    if (req.method === "POST" && !fromApp(req)) return json(res, 400, { fout: "Ongeldige aanvraag" });
    const force = url.searchParams.get("refresh") === "1";

    if (route === "cars" && req.method === "GET") {
      const c = await getCars(force); const loc = locaties();
      return json(res, 200, { bijgewerkt: new Date(c.at).toISOString(), wagens: c.raw.map((x) => toPublic(x, loc)) });
    }
    if (route === "intern" && req.method === "GET") {
      const c = await getCars(force); const loc = locaties();
      const out = {}; for (const x of c.raw) out[String(x.id)] = toIntern(x, loc);
      return json(res, 200, { bijgewerkt: new Date(c.at).toISOString(), intern: out });
    }
    if (route === "leads" && req.method === "GET") return json(res, 200, { leads: leads().slice().reverse() });
    if (route === "leads" && req.method === "POST") {
      let p = {}; try { p = JSON.parse(await readBody(req)); } catch (_) { return json(res, 400, { fout: "Ongeldige gegevens" }); }
      const lead = { naam: clean(p.naam, 120), telefoon: clean(p.telefoon, 40), email: clean(p.email, 160), opmerking: String(p.opmerking || "").slice(0, 2000).trim() };
      if (!lead.naam) return json(res, 400, { fout: "Naam is verplicht." });
      if (!lead.telefoon && !lead.email) return json(res, 400, { fout: "Geef een telefoonnummer of e-mailadres." });
      if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) return json(res, 400, { fout: "E-mailadres lijkt niet juist." });
      const c = await getCars(false); const car = c.byId.get(String(p.wagen_id || ""));
      if (!car) return json(res, 400, { fout: "Wagen niet gevonden (vernieuw de stock)." });
      const rec = {
        id: rnd(9), aangemaakt: new Date().toISOString(), ...lead,
        wagen: { id: String(car.id), referentie: str(car.reference), model: [str(car.brand), str(car.model), str(car.model_execution)].filter(Boolean).join(" "), prijs: num(car.desired_selling_price) || null },
        doorgestuurd: false, // fase 2: Microsoft Lists
      };
      const all = leads(); all.push(rec); writeJson(LEADS_FILE, all);
      log(`STOCKVIEWER: lead bewaard voor wagen ${rec.wagen.referentie}`);
      return json(res, 201, { ok: true, id: rec.id });
    }
    return json(res, 404, { fout: "Niet gevonden" });
  };
};

module.exports._internals = { kleurGroep, modelGroep, plain };
