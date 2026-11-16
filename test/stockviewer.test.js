#!/usr/bin/env node
// Lektest Stockviewer: start de webserver met een testbestand en controleert dat
// /stock/api/cars (klantdata) GEEN interne gegevens bevat, en dat alles achter de login zit.
//   node test/stockviewer.test.js                      → met test/fixtures/stock-sample.json
//   STOCK_FIXTURE=pad\naar\stock.json node test/...    → met een eigen (echte) momentopname
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");

const ROOT = path.join(__dirname, "..");
const FIXTURE = path.resolve(process.env.STOCK_FIXTURE || path.join(__dirname, "fixtures", "stock-sample.json"));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const CODE = "testcode-" + Math.random().toString(36).slice(2);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "stocktest-"));
const raw = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const locCfg = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "stock-locaties.json"), "utf8"));

let failures = 0;
async function t(name, fn) { try { await fn(); console.log("  ok  " + name); } catch (e) { failures++; console.log("  FOUT " + name + "\n       " + e.message); } }
const H = { "X-Stockviewer": "1", "Content-Type": "application/json" };

(async () => {
  const srv = spawn(process.execPath, [path.join(ROOT, "server", "http.js")], {
    env: { ...process.env, PUBLIC_URL: "https://test.example", ADMIN_PASSWORD: "x".repeat(16), STOCK_PASSWORD: CODE, STOCK_FIXTURE: FIXTURE, DATA_DIR: DATA, PORT: String(PORT), BBT_API_KEY: "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = ""; srv.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + "/"); break; } catch (_) { await new Promise((r) => setTimeout(r, 100)); } }

  let cookie = "";
  console.log(`Stockviewer-lektest met ${raw.length} wagens uit ${path.basename(FIXTURE)}`);

  await t("zonder login: alle API's geven 401", async () => {
    for (const p of ["cars", "intern", "leads"]) assert.equal((await fetch(`${BASE}/stock/api/${p}`)).status, 401, p);
    assert.equal((await fetch(`${BASE}/stock/api/leads`, { method: "POST", headers: H, body: "{}" })).status, 401);
  });
  await t("valse cookie geeft 401", async () => {
    assert.equal((await fetch(`${BASE}/stock/api/cars`, { headers: { cookie: "vag_stock=verzonnen" } })).status, 401);
  });
  await t("foute code geeft 401, login zonder app-header geweigerd", async () => {
    assert.equal((await fetch(`${BASE}/stock/api/login`, { method: "POST", headers: H, body: JSON.stringify({ code: "fout" }) })).status, 401);
    assert.equal((await fetch(`${BASE}/stock/api/login`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "code=" + CODE })).status, 400);
  });
  await t("juiste code geeft sessiecookie (HttpOnly, Secure, SameSite=Strict)", async () => {
    const r = await fetch(`${BASE}/stock/api/login`, { method: "POST", headers: H, body: JSON.stringify({ code: CODE }) });
    assert.equal(r.status, 200);
    const sc = r.headers.get("set-cookie") || "";
    assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Strict/);
    cookie = sc.split(";")[0];
  });

  const resp = await fetch(`${BASE}/stock/api/cars`, { headers: { cookie } });
  const body = await resp.text();
  const data = JSON.parse(body);
  const pub = new Map(data.wagens.map((w) => [w.id, w]));

  await t("gearchiveerde, gefactureerde en verkochte (bestelbon) wagens weggelaten", async () => {
    for (const c of raw) {
      const weg = Number(c.archived) || Number(c.invoiced) || Number(c.sold_by) || Number(c.ordered);
      assert.equal(pub.has(String(c.id)), !weg, `wagen ${c.id}`);
    }
  });

  await t("klant-endpoint: geen verboden veldnamen", async () => {
    const forbidden = /^(purchase|net_margin|marge|aankoop|damage|schade|location|locatie|supplier|leverancier|memo|other|notitie|status|reservation|reservatie|chassis|vin|license|nummerplaat|account|owner)/i;
    const allowed = new Set(["direct_beschikbaar", "gereserveerd"]);
    (function walk(o, p) {
      if (Array.isArray(o)) return o.forEach((v, i) => walk(v, p + "[" + i + "]"));
      if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { if (!allowed.has(k)) assert.ok(!forbidden.test(k), `verboden veld ${p}.${k}`); walk(v, p + "." + k); }
    })(data, "");
  });

  await t("klant-endpoint: geen marge, aankoopprijs, schade, locatie, reservatie, notities, of VIN (op waarde); referentie wel aanwezig", async () => {
    const strip = (s) => String(s || "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    const locNames = Object.values(locCfg.locaties || {});
    let checked = 0;
    for (const c of raw) {
      const w = pub.get(String(c.id)); if (!w) continue;
      const { fotos, ...rest } = w;                 // foto-URL's apart (BBT-bestandsnamen bevatten soms de VIN)
      const txt = JSON.stringify(rest);
      const leafs = []; (function walk(o) { if (o && typeof o === "object") Object.values(o).forEach(walk); else leafs.push(o); })(rest);
      const nums = new Set(leafs.filter((x) => typeof x === "number"));
      for (const [veld, v] of [["purchase_price", c.purchase_price], ["net_margin", c.net_margin], ["anticipated_damage_amount", c.anticipated_damage_amount]]) {
        const n = parseFloat(v); if (!n) continue;
        assert.ok(!nums.has(n) && !nums.has(Math.round(n)) || n === w.prijs || n === w.km, `wagen ${c.id}: ${veld}=${n} gevonden`);
        assert.ok(!txt.includes(String(v)) || String(v).length < 4, `wagen ${c.id}: ${veld} als tekst gevonden`);
        checked++;
      }
      assert.equal(w.referentie, String(c.reference), `wagen ${c.id}: referentie ontbreekt`);
      for (const [veld, v] of [["chassis_number", c.chassis_number], ["license_plate", c.license_plate], ["memo", strip(c.memo)], ["other", strip(c.other)], ["damage_details", strip(c.damage_details)], ["reservation", strip(c.reservation)]]) {
        const s = String(v || "").trim(); if (s.length < 4) continue;
        assert.ok(!txt.includes(s), `wagen ${c.id}: ${veld} gevonden ("${s.slice(0, 30)}")`);
        // ook stukjes van notities/schadeteksten (bv. "overname 38500")
        if (/memo|other|damage|reservation/.test(veld)) for (const part of s.split(/[\n>]/).map((x) => x.trim()).filter((x) => x.length >= 8)) assert.ok(!txt.includes(part), `wagen ${c.id}: deel van ${veld} gevonden ("${part.slice(0, 30)}")`);
        checked++;
      }
      for (const f of fotos) for (const u of Object.values(f)) { assert.ok(String(u).startsWith("https://bbt-storage.b-cdn.net/"), "foto van onbekende host"); }
      for (const name of locNames) assert.ok(!new RegExp("\\b" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(txt), `wagen ${c.id}: locatienaam "${name}" gevonden`);
      assert.equal(typeof w.direct_beschikbaar, "boolean");
      assert.equal(w.direct_beschikbaar, (locCfg.direct_beschikbaar || [1]).map(String).includes(String(c.location)), `wagen ${c.id}: badge direct beschikbaar`);
      assert.equal(w.gereserveerd, !!String(c.reservation || "").trim());
      assert.equal(w.prijs, parseFloat(c.desired_selling_price) > 0 ? Math.round(parseFloat(c.desired_selling_price)) : null, `wagen ${c.id}: prijs`);
    }
    assert.ok(checked > 0, "niets gecontroleerd");
  });

  await t("dealer-endpoint geeft interne gegevens (marge, locatienaam)", async () => {
    const d = await (await fetch(`${BASE}/stock/api/intern`, { headers: { cookie } })).json();
    const c = raw.find((x) => pub.has(String(x.id)));
    const i = d.intern[String(c.id)];
    assert.equal(i.marge, parseFloat(c.net_margin));
    const s77 = raw.find((x) => pub.has(String(x.id)) && /;77;/.test(x.status || ""));
    if (s77) assert.ok(d.intern[String(s77.id)].schade.includes("Schade niet hersteld"), "status 77 moet schade geven");
    const zonder = raw.find((x) => pub.has(String(x.id)) && !/;77;/.test(x.status || "") && Number(x.damage));
    if (zonder) assert.equal(d.intern[String(zonder.id)].schade.length, 0, "veld damage mag niet meer tellen");
    const s184 = raw.find((x) => pub.has(String(x.id)) && /;184;/.test(x.status || ""));
    if (s184) assert.ok(d.intern[String(s184.id)].schade.includes("Hagelschade"), "184 = hagelschade");
    const s454 = raw.find((x) => pub.has(String(x.id)) && /;454;/.test(x.status || ""));
    if (s454) assert.ok(d.intern[String(s454.id)].statussen.includes("Geadverteerd op AutoScout24"));
    if (locCfg.locaties[String(c.location)]) assert.equal(i.locatie, locCfg.locaties[String(c.location)]);
  });

  await t("lead: bewaren, referentie+model server-side gekoppeld, niets naar BBT", async () => {
    const c = data.wagens[0];
    const bad = await fetch(`${BASE}/stock/api/leads`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ naam: "x", telefoon: "1", wagen_id: c.id }) });
    assert.equal(bad.status, 400, "zonder app-header moet geweigerd worden");
    const noContact = await fetch(`${BASE}/stock/api/leads`, { method: "POST", headers: { ...H, cookie }, body: JSON.stringify({ naam: "Test", wagen_id: c.id }) });
    assert.equal(noContact.status, 400);
    const r = await fetch(`${BASE}/stock/api/leads`, { method: "POST", headers: { ...H, cookie }, body: JSON.stringify({ naam: "Test Klant", telefoon: "0470 12 34 56", email: "test@example.com", opmerking: "proefrit", wagen_id: c.id }) });
    assert.equal(r.status, 201);
    const rb = await r.text(); const src = raw.find((x) => String(x.id) === c.id);
    assert.ok(!rb.includes(String(src.reference)), "referentie in antwoord");
    const saved = JSON.parse(fs.readFileSync(path.join(DATA, "stock-leads.json"), "utf8"));
    assert.equal(saved.length, 1); assert.equal(saved[0].wagen.referentie, String(src.reference)); assert.match(saved[0].wagen.model, new RegExp(c.model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  await t("statische bestanden + beveiligingsheaders", async () => {
    const r = await fetch(`${BASE}/stock/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-security-policy") || "", /default-src 'self'/);
    assert.equal((await fetch(`${BASE}/stock/../server/http.js`)).status, 404);
    assert.equal((await fetch(`${BASE}/stock/stock-locaties.json`)).status, 404);
  });

  await t("uitloggen maakt sessie ongeldig", async () => {
    await fetch(`${BASE}/stock/api/logout`, { method: "POST", headers: { ...H, cookie } });
    assert.equal((await fetch(`${BASE}/stock/api/cars`, { headers: { cookie } })).status, 401);
  });

  await t("5 foute codes → tijdelijk geblokkeerd", async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await fetch(`${BASE}/stock/api/login`, { method: "POST", headers: H, body: JSON.stringify({ code: "fout" + i }) })).status;
    assert.equal(last, 429);
  });

  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failures ? `\n${failures} test(s) MISLUKT` : "\nAlle tests geslaagd.");
  if (failures) console.log(log.slice(-2000));
  process.exit(failures ? 1 : 0);
})();
