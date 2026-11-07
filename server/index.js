#!/usr/bin/env node
// BBT DMS – lokale MCP-server (lezen + stockwagens aanmaken met bevestiging)
// Geen externe afhankelijkheden: MCP over stdio (JSON-RPC 2.0, één bericht per regel).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const SERVER_NAME = "bbt-dms";
const SERVER_VERSION = "0.2.2";
const TEST_API_KEY = "481384f3ba7c0a75b3340b473d5e6ade"; // publieke testsleutel uit de BBT-documentatie
const BASE_URL = (process.env.BBT_BASE_URL || "https://bbt-cloud.be/service/api/v1").replace(/\/+$/, "");
const API_KEY = (process.env.BBT_API_KEY || "").trim();
function expandPath(p) {
  if (!p) return "";
  const home = os.homedir();
  return p
    .replace(/\$\{(DOCUMENTS|DOCUMENTS_DIR)\}/g, path.join(home, "Documents"))
    .replace(/\$\{(HOME|HOME_DIR)\}/g, home)
    .replace(/\$\{DESKTOP\}/g, path.join(home, "Desktop"))
    .replace(/^~(?=\/|$)/, home);
}
const DEFAULT_EXPORT_DIR = path.join(os.homedir(), "Documents", "Claude Local", "BBT_server", "export");
let EXPORT_DIR = expandPath((process.env.BBT_EXPORT_DIR || "").trim()) || DEFAULT_EXPORT_DIR;
if (/\$\{/.test(EXPORT_DIR) || !path.isAbsolute(EXPORT_DIR)) EXPORT_DIR = DEFAULT_EXPORT_DIR;
try { fs.mkdirSync(EXPORT_DIR, { recursive: true }); } catch (_) { EXPORT_DIR = DEFAULT_EXPORT_DIR; }
const TOKEN_TTL_MS = 55 * 60 * 1000; // BBT-token is 1 uur geldig
const MAX_TEXT = 90000; // max tekens die we in één antwoord teruggeven
const DEFAULT_LIMIT = 100;

function log(...a) { try { process.stderr.write("[bbt-dms] " + a.join(" ") + "\n"); } catch (_) {} }

// ---------------------------------------------------------------- BBT client
const tokenCaches = new Map(); // sleutel → { token, at }

function extractToken(body) {
  if (!body) return null;
  if (typeof body === "string") {
    const s = body.trim().replace(/^"|"$/g, "");
    if (/^[A-Za-z0-9._\-]{16,}$/.test(s)) return s;
    try { return extractToken(JSON.parse(body)); } catch (_) { return null; }
  }
  if (typeof body === "object") {
    for (const k of ["token", "access_token", "accessToken", "authToken"]) {
      if (typeof body[k] === "string" && body[k]) return body[k];
    }
    for (const v of Object.values(body)) {
      if (v && typeof v === "object") { const t = extractToken(v); if (t) return t; }
    }
  }
  return null;
}

const authInFlight = new Map();
function authenticate(force = false, key = API_KEY) {
  const c = tokenCaches.get(key);
  if (!force && c && c.token && Date.now() - c.at < TOKEN_TTL_MS) return Promise.resolve(c.token);
  if (!authInFlight.has(key)) authInFlight.set(key, doAuthenticate(key).finally(() => authInFlight.delete(key)));
  return authInFlight.get(key);
}

async function doAuthenticate(key) {
  if (!key) throw new Error("Geen BBT API-key ingesteld. Vul ze in bij de instellingen van de extensie 'BBT DMS' in de Claude-app.");
  const fd = new FormData();
  fd.append("clientSecret", key);
  const res = await fetch(BASE_URL + "/auth/", { method: "POST", body: fd });
  const text = await res.text();
  if (!res.ok) throw new Error(`BBT-authenticatie mislukt (HTTP ${res.status}): ${text.slice(0, 300)}`);
  const token = extractToken(text);
  if (!token) throw new Error("BBT-authenticatie gaf geen token terug. Antwoord: " + text.slice(0, 300));
  tokenCaches.set(key, { token, at: Date.now() });
  return token;
}

function looksLikeAuthError(status, text) {
  if (status === 401 || status === 403) return true;
  return /token/i.test(text) && /(invalid|expired|ongeldig|verlopen|not valid|unauthori)/i.test(text);
}

async function bbtPost(route, params = {}, { raw = false, key = API_KEY } = {}) {
  const call = async (token) => {
    const body = { token };
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") body[k] = v;
    return fetch(BASE_URL + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  };
  let res = await call(await authenticate(false, key));
  if (raw && res.ok && !/json|text/i.test(res.headers.get("content-type") || "")) return res;
  let text = await res.text();
  if (looksLikeAuthError(res.status, text)) {
    res = await call(await authenticate(true, key));
    if (raw && res.ok && !/json|text/i.test(res.headers.get("content-type") || "")) return res;
    text = await res.text();
  }
  if (!res.ok) throw new Error(`BBT gaf een fout op ${route} (HTTP ${res.status}): ${text.slice(0, 500)}`);
  if (raw) return { text, contentType: res.headers.get("content-type") || "" };
  try { return JSON.parse(text); } catch (_) { return text; }
}

// ---------------------------------------------------------------- helpers
const configCache = new Map();
async function getConfig(test = false, fresh = false) {
  const key = test ? TEST_API_KEY : API_KEY;
  const c = configCache.get(key);
  if (!fresh && c && Date.now() - c.at < 30 * 60 * 1000) return c.data;
  const data = await bbtPost("/config/", {}, { key });
  configCache.set(key, { data, at: Date.now() });
  return data;
}

function findMainArray(data) {
  if (Array.isArray(data)) return { arr: data, key: null };
  if (data && typeof data === "object") {
    let best = null;
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v) && (!best || v.length > best.arr.length)) best = { arr: v, key: k };
    }
    if (best) return best;
    // object met numerieke sleutels → als lijst behandelen
    const vals = Object.values(data);
    if (vals.length > 1 && vals.every((v) => v && typeof v === "object" && !Array.isArray(v))) return { arr: vals, key: "*" };
  }
  return null;
}

function pickFields(item, fields) {
  if (!fields || !fields.length || !item || typeof item !== "object") return item;
  const out = {};
  for (const f of fields) if (f in item) out[f] = item[f];
  return out;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function saveExport(name, fullData, arr) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const base = path.join(EXPORT_DIR, `${name}_${stamp()}`);
  fs.writeFileSync(base + ".json", JSON.stringify(fullData, null, 2));
  const files = [base + ".json"];
  if (arr && arr.length && arr.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
    const cols = [];
    for (const it of arr) for (const k of Object.keys(it)) if (!cols.includes(k)) cols.push(k);
    const lines = [cols.map(csvEscape).join(";")];
    for (const it of arr) lines.push(cols.map((c) => csvEscape(it[c])).join(";"));
    fs.writeFileSync(base + ".csv", "﻿" + lines.join("\r\n")); // BOM + ; → opent goed in Excel (BE)
    files.push(base + ".csv");
  }
  return files;
}

function shape(name, data, args) {
  const { limit = DEFAULT_LIMIT, offset = 0, fields, zoek, save_to_file } = args || {};
  const main = findMainArray(data);
  const result = {};
  let files = null;

  if (!main) {
    if (save_to_file) files = saveExport(name, data, null);
    let text = JSON.stringify(data, null, 1);
    if (text.length > MAX_TEXT) {
      if (!files) files = saveExport(name, data, null);
      text = text.slice(0, MAX_TEXT) + "\n…(afgekapt)";
    }
    return text + (files ? `\n\nVolledige gegevens opgeslagen in:\n${files.join("\n")}` : "");
  }

  let arr = main.arr;
  if (zoek) {
    const q = String(zoek).toLowerCase();
    arr = arr.filter((it) => JSON.stringify(it).toLowerCase().includes(q));
  }
  if (args && args.__filter) arr = arr.filter(args.__filter);
  if (save_to_file) files = saveExport(name, { ...(typeof data === "object" && !Array.isArray(data) ? data : {}), [main.key || "items"]: arr }, arr);

  const total = arr.length;
  let page = arr.slice(offset, offset + limit).map((it) => pickFields(it, fields));
  result.totaal = total;
  result.offset = offset;
  result.getoond = page.length;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [k, v] of Object.entries(data)) if (k !== main.key && !Array.isArray(v) && typeof v !== "object") result[k] = v;
  }
  result.items = page;
  let text = JSON.stringify(result, null, 1);
  while (text.length > MAX_TEXT && page.length > 1) {
    page = page.slice(0, Math.max(1, Math.floor(page.length / 2)));
    result.items = page;
    result.getoond = page.length;
    result.let_op = "Antwoord ingekort wegens grootte. Gebruik offset/limit, 'fields' of save_to_file voor de rest.";
    text = JSON.stringify(result, null, 1);
  }
  if (!files && total > page.length && total > 500) {
    files = saveExport(name, { items: arr }, arr);
  }
  if (files) text += `\n\nVolledige lijst (${total} items) opgeslagen in:\n${files.join("\n")}`;
  return text;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function checkDate(v, label) {
  if (v === undefined || v === null || v === "") return;
  if (!DATE_RE.test(String(v))) throw new Error(`${label} moet in formaat JJJJ-MM-DD zijn (bv. 2026-10-01).`);
}

// ---------------------------------------------------------------- tool-definities
const common = {
  limit: { type: "integer", minimum: 1, maximum: 1000, description: "Max. aantal items in het antwoord (standaard 100)." },
  offset: { type: "integer", minimum: 0, description: "Vanaf welk item (voor paginering)." },
  fields: { type: "array", items: { type: "string" }, description: "Enkel deze velden per item teruggeven (houdt antwoorden klein)." },
  zoek: { type: "string", description: "Filter: enkel items waarin deze tekst voorkomt (hoofdletterongevoelig), bv. nummerplaat, VIN of naam." },
  save_to_file: { type: "boolean", description: "Volledige resultaat ook opslaan als JSON + CSV in de exportmap." },
};
const dateChange = { date_change: { type: "string", description: "Optioneel: enkel records gewijzigd sinds deze datum (JJJJ-MM-DD). Leeg = alles." } };
const fromTo = {
  from: { type: "string", description: "Begindatum JJJJ-MM-DD." },
  to: { type: "string", description: "Einddatum JJJJ-MM-DD." },
};

const ORDER_TYPES = { werkorder: 1, bestek: 2, leveringsbon: 3, offerte: 4, bestelbon: 5, ticket: 6 };

const TOOLS = [
  {
    name: "bbt_config",
    description: "Configuratie van BBT ophalen: codes voor brandstof, transmissie, carrosserietype (carType), wagentype, garantie, euronorm, ordercategorieën enz. Zonder 'sectie' krijg je de lijst met secties; met 'sectie' de inhoud ervan. Gebruik dit om codes te kiezen voor een nieuwe stockwagen.",
    props: { sectie: { type: "string", description: "Naam van één sectie (bv. fuel). Leeg = overzicht van alle secties." }, testomgeving: { type: "boolean", description: "Config van de BBT-testomgeving i.p.v. die van VAG." } }, required: [],
    run: async (a) => {
      const d = await getConfig(!!a.testomgeving, true);
      if (!d || typeof d !== "object") return String(d);
      if (a.sectie) {
        const k = Object.keys(d).find((x) => x.toLowerCase() === String(a.sectie).toLowerCase());
        if (!k) return `Sectie '${a.sectie}' niet gevonden. Beschikbaar: ${Object.keys(d).join(", ")}`;
        let t = JSON.stringify(d[k]);
        if (t.length > MAX_TEXT) { const f = saveExport("config_" + k, d[k], null); t = t.slice(0, MAX_TEXT) + `…(afgekapt, volledig in ${f[0]})`; }
        return t;
      }
      const overzicht = {};
      for (const [k, v] of Object.entries(d)) overzicht[k] = Array.isArray(v) ? `lijst (${v.length})` : v && typeof v === "object" ? `object (${Object.keys(v).length} sleutels)` : v;
      const full = JSON.stringify(d);
      if (full.length <= 20000) return full;
      return JSON.stringify({ secties: overzicht, tip: "Vraag een sectie op met de parameter 'sectie'." }, null, 1);
    },
  },
  {
    name: "bbt_planning",
    description: "Planning (afspraken) uit BBT ophalen. Optioneel enkel wijzigingen sinds een datum.",
    props: { ...dateChange, ...common }, required: [],
    run: (a) => { checkDate(a.date_change, "date_change"); return bbtPost("/planning/", { date_change: a.date_change }).then((d) => shape("planning", d, a)); },
  },
  {
    name: "bbt_planning_vrije_slots",
    description: "Beschikbare planningsslots voor een maand.",
    props: { month: { type: "integer", minimum: 1, maximum: 12, description: "Maand 1-12" }, year: { type: "integer", description: "Jaar, bv. 2026" }, ...common },
    required: ["month", "year"],
    run: (a) => bbtPost("/planning/availableSlots/", { month: String(a.month), year: String(a.year) }).then((d) => shape("planning_slots", d, a)),
  },
  {
    name: "bbt_facturen",
    description: "Facturen ophalen voor een periode (from/to). Vraag grote periodes per maand of kwartaal op.",
    props: { ...fromTo, ...common }, required: ["from", "to"],
    run: (a) => { checkDate(a.from, "from"); checkDate(a.to, "to"); return bbtPost("/invoices/", { from: a.from, to: a.to }).then((d) => shape("facturen", d, a)); },
  },
  {
    name: "bbt_factuur_pdf",
    description: "PDF van één factuur ophalen en opslaan in de exportmap/facturen. Geeft het bestandspad terug.",
    props: { invoiceNumber: { type: "string", description: "Factuurnummer" } }, required: ["invoiceNumber"],
    run: async (a) => {
      const r = await bbtPost("/invoices/pdf", { invoiceNumber: a.invoiceNumber }, { raw: true });
      const dir = path.join(EXPORT_DIR, "facturen");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `factuur_${String(a.invoiceNumber).replace(/[^A-Za-z0-9_.-]/g, "_")}.pdf`);
      let buf = null;
      if (r && typeof r.arrayBuffer === "function") {
        buf = Buffer.from(await r.arrayBuffer());
      } else {
        const t = (r.text || "").trim();
        if (t.startsWith("%PDF")) buf = Buffer.from(t, "binary");
        else {
          let b64 = null;
          try { const j = JSON.parse(t); b64 = j.pdf || j.data || j.file || j.content || (j.result && (j.result.pdf || j.result.data)); } catch (_) { if (/^[A-Za-z0-9+/=\s]+$/.test(t) && t.length > 100) b64 = t; }
          if (typeof b64 === "string") { b64 = b64.replace(/^data:application\/pdf;base64,/, ""); buf = Buffer.from(b64, "base64"); }
          else if (/^https?:\/\//.test(t)) return `BBT gaf een link naar de PDF terug: ${t}`;
          else return "Onverwacht antwoord van BBT (geen PDF): " + t.slice(0, 500);
        }
      }
      if (!buf || buf.slice(0, 4).toString() !== "%PDF") return "BBT gaf geen geldige PDF terug.";
      fs.writeFileSync(file, buf);
      return `Factuur ${a.invoiceNumber} opgeslagen: ${file}`;
    },
  },
  {
    name: "bbt_orders",
    description: "Orders ophalen voor een periode: werkorders, bestekken, leveringsbons, offertes, bestelbonnen, tickets. Optioneel filteren op type.",
    props: {
      ...fromTo,
      type: { type: "string", enum: Object.keys(ORDER_TYPES), description: "Optioneel: enkel dit ordertype." },
      ...common,
    },
    required: ["from", "to"],
    run: (a) => {
      checkDate(a.from, "from"); checkDate(a.to, "to");
      const want = a.type ? ORDER_TYPES[a.type] : null;
      const filter = want ? (it) => {
        if (!it || typeof it !== "object") return false;
        for (const [k, v] of Object.entries(it)) if (/^order_?type$/i.test(k)) return Number(v) === want;
        return true; // veld onbekend → niet wegfilteren
      } : null;
      return bbtPost("/orders/", { from: a.from, to: a.to }).then((d) => shape("orders" + (a.type ? "_" + a.type : ""), d, { ...a, __filter: filter }));
    },
  },
  {
    name: "bbt_bestelbonnen_stock",
    description: "Bestelbonnen van stockwagens voor een periode.",
    props: { ...fromTo, ...common }, required: ["from", "to"],
    run: (a) => { checkDate(a.from, "from"); checkDate(a.to, "to"); return bbtPost("/stock/getOrdernotes/", { from: a.from, to: a.to }).then((d) => shape("stock_bestelbonnen", d, a)); },
  },
  {
    name: "bbt_stockwagens",
    description: "Stockwagens (carpark) ophalen. Standaard alle; zet enkel_gepubliceerd=true voor enkel gepubliceerde wagens.",
    props: { enkel_gepubliceerd: { type: "boolean", description: "Enkel gepubliceerde wagens." }, ...common }, required: [],
    run: (a) => bbtPost("/carpark/getCars/", { publishedOnly: a.enkel_gepubliceerd ? 1 : 0 }).then((d) => shape("stockwagens", d, a)),
  },
  {
    name: "bbt_klantwagens",
    description: "Klantwagens (werkplaats) ophalen. Optioneel enkel gewijzigd sinds een datum.",
    props: { ...dateChange, ...common }, required: [],
    run: (a) => { checkDate(a.date_change, "date_change"); return bbtPost("/cars/", { date_change: a.date_change }).then((d) => shape("klantwagens", d, a)); },
  },
  {
    name: "bbt_zoeken",
    description: "Zoeken in BBT op wagen (nummerplaat, VIN, merk…) of klant.",
    props: { term: { type: "string", description: "Zoekterm" }, soort: { type: "string", enum: ["wagen", "klant"], description: "Standaard 'wagen'." }, ...common },
    required: ["term"],
    run: (a) => bbtPost("/search/", { term: a.term, type: a.soort === "klant" ? "client" : "" }).then((d) => shape("zoeken", d, a)),
  },
  {
    name: "bbt_klanten",
    description: "Klantenlijst ophalen. Optioneel enkel gewijzigd sinds een datum. Grote lijst: gebruik zoek/fields of save_to_file.",
    props: { ...dateChange, ...common }, required: [],
    run: (a) => { checkDate(a.date_change, "date_change"); return bbtPost("/clients/", { date_change: a.date_change }).then((d) => shape("klanten", d, a)); },
  },
  {
    name: "bbt_klant",
    description: "Eén klant opzoeken op klantnummer of naam.",
    props: { clientNumber: { type: "string", description: "Klantnummer" }, name: { type: "string", description: "Naam" } }, required: [],
    run: (a) => {
      if (!a.clientNumber && !a.name) throw new Error("Geef een klantnummer of een naam op.");
      return bbtPost("/clients/getClientByID/", { clientNumber: a.clientNumber, name: a.name }).then((d) => shape("klant", d, {}));
    },
  },
  {
    name: "bbt_klant_contacten",
    description: "Contactpersonen van een klant (of van alle klanten als clientID leeg is).",
    props: { clientID: { type: "string", description: "Klant-ID (optioneel)" }, ...common }, required: [],
    run: (a) => bbtPost("/clients/contacts/", { clientID: a.clientID }).then((d) => shape("klant_contacten", d, a)),
  },
  {
    name: "bbt_leveranciers",
    description: "Leverancierslijst ophalen.",
    props: { ...common }, required: [],
    run: (a) => bbtPost("/suppliers/").then((d) => shape("leveranciers", d, a)),
  },
  {
    name: "bbt_artikels",
    description: "Artikels (onderdelen, werkuren…) ophalen.",
    props: {
      ...dateChange,
      enkel_webshop: { type: "boolean", description: "Enkel webshop-artikels." },
      inclusief_inactief: { type: "boolean", description: "Ook inactieve artikels." },
      ...common,
    },
    required: [],
    run: (a) => { checkDate(a.date_change, "date_change"); return bbtPost("/stock/getArticles/", { date_change: a.date_change, webshop: a.enkel_webshop ? "1" : "0", includingInactive: a.inclusief_inactief ? "1" : "0" }).then((d) => shape("artikels", d, a)); },
  },
  {
    name: "bbt_artikel",
    description: "Eén artikel ophalen op artikelcode (SKU).",
    props: { sku: { type: "string", description: "Artikelcode" } }, required: ["sku"],
    run: (a) => bbtPost("/stock/getArticle/", { sku: a.sku }).then((d) => shape("artikel", d, {})),
  },
  {
    name: "bbt_stockaantal",
    description: "Stockaantal van een artikel op artikelcode (SKU).",
    props: { sku: { type: "string", description: "Artikelcode" } }, required: ["sku"],
    run: (a) => bbtPost("/stock/", { sku: a.sku }).then((d) => shape("stockaantal", d, {})),
  },
  {
    name: "bbt_uurregistratie",
    description: "Uurregistratie (hourlog) ophalen, gewijzigd sinds een datum.",
    props: { ...dateChange, ...common }, required: [],
    run: (a) => { checkDate(a.date_change, "date_change"); return bbtPost("/hourlog/", { date_change: a.date_change }).then((d) => shape("uurregistratie", d, a)); },
  },
  {
    name: "bbt_garanties",
    description: "Garanties voor een periode.",
    props: { ...fromTo, ...common }, required: ["from", "to"],
    run: (a) => { checkDate(a.from, "from"); checkDate(a.to, "to"); return bbtPost("/warranties/", { from: a.from, to: a.to }).then((d) => shape("garanties", d, a)); },
  },
];

TOOLS.push(...require("./stockwagen.js")({ bbtPost, getConfig, EXPORT_DIR, TEST_API_KEY, API_KEY, log }));
const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

function toolList() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description + (t.write ? "" : " (alleen lezen)"),
    inputSchema: { type: "object", properties: t.props, required: t.required, additionalProperties: false },
    annotations: t.write
      ? { title: t.title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
      : { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }));
}

// ---------------------------------------------------------------- JSON-RPC over stdio
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case "initialize": {
        const pv = (params && params.protocolVersion) || "2025-06-18";
        return reply(id, {
          protocolVersion: pv,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: "Leest gegevens uit BBT (DMS van VAG N.V.). Alle tools zijn alleen-lezen. Datums in JJJJ-MM-DD. Vraag grote periodes op in stukken (per maand) en gebruik 'fields', 'zoek' of save_to_file om antwoorden klein te houden.",
        });
      }
      case "ping": return isRequest && reply(id, {});
      case "tools/list": return reply(id, { tools: toolList() });
      case "tools/call": {
        const name = params && params.name;
        const tool = toolMap.get(name);
        if (!tool) return replyError(id, -32602, `Onbekende tool: ${name}`);
        try {
          const text = await tool.run((params && params.arguments) || {});
          return reply(id, { content: [{ type: "text", text: typeof text === "string" ? text : JSON.stringify(text) }] });
        } catch (e) {
          log("tool-fout", name, e && e.message);
          return reply(id, { content: [{ type: "text", text: "Fout: " + (e && e.message ? e.message : String(e)) }], isError: true });
        }
      }
      case "resources/list": return reply(id, { resources: [] });
      case "prompts/list": return reply(id, { prompts: [] });
      default:
        if (method && method.startsWith("notifications/")) return; // geen antwoord op notificaties
        if (isRequest) return replyError(id, -32601, `Methode niet ondersteund: ${method}`);
    }
  } catch (e) {
    if (isRequest) replyError(id, -32603, e && e.message ? e.message : String(e));
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    if (Array.isArray(msg)) msg.forEach((m) => handle(m)); else handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
log(`gestart (v${SERVER_VERSION}), API-key ${API_KEY ? "ingesteld" : "ONTBREEKT"}`);
