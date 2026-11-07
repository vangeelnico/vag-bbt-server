#!/usr/bin/env node
// BBT DMS – webversie (MCP "Streamable HTTP") met eigen OAuth 2.1-login.
// Bedoeld voor de vaste pc op de zaak, bereikbaar via ngrok.
// Geen externe afhankelijkheden. Start: node --env-file=.env server/http.js
"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { handle, SERVER_NAME, SERVER_VERSION, API_KEY, log } = require("./index.js");

// ---------------------------------------------------------------- instellingen
const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "127.0.0.1"; // enkel lokaal; ngrok praat met localhost
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
const ACCESS_TTL_S = 60 * 60;              // access token: 1 uur
const REFRESH_TTL_S = 60 * 24 * 60 * 60;   // refresh token: 60 dagen
const CODE_TTL_MS = 5 * 60 * 1000;         // autorisatiecode: 5 minuten
// Waar Claude na het inloggen naar terugkeert. Andere adressen worden geweigerd.
const ALLOWED_REDIRECT_HOSTS = (process.env.ALLOWED_REDIRECT_HOSTS || "claude.ai,claude.com,localhost,127.0.0.1")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

function fatal(msg) { log("START GEWEIGERD: " + msg); process.exit(1); }
if (!PUBLIC_URL || !/^https:\/\//.test(PUBLIC_URL)) fatal("PUBLIC_URL ontbreekt of is geen https-adres (bv. https://jouwnaam.ngrok-free.app).");
if (ADMIN_PASSWORD.length < 12) fatal("ADMIN_PASSWORD moet minstens 12 tekens lang zijn.");
if (!API_KEY) log("LET OP: BBT_API_KEY ontbreekt – enkel de testomgeving zal werken.");

const RESOURCE = PUBLIC_URL + "/mcp";

// ---------------------------------------------------------------- opslag (tokens enkel als hash)
fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_FILE = path.join(DATA_DIR, "oauth.json");
let store = { clients: {}, access: {}, refresh: {} };
try { store = { ...store, ...JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) }; } catch (_) {}
function saveStore() {
  const now = Date.now();
  for (const k of ["access", "refresh"]) for (const [h, t] of Object.entries(store[k])) if (t.exp < now) delete store[k][h];
  const tmp = STORE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
  fs.renameSync(tmp, STORE_FILE);
}
const codes = new Map(); // code-hash → { clientId, redirectUri, challenge, exp, resource }

const rnd = (n = 32) => crypto.randomBytes(n).toString("base64url");
const sha = (s) => crypto.createHash("sha256").update(s).digest("base64url");
function safeEqual(a, b) {
  const x = Buffer.from(sha(String(a))), y = Buffer.from(sha(String(b)));
  return crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- beveiliging login
const failures = new Map(); // ip → { n, until }
// ngrok voegt het echte IP-adres achteraan toe; de eerste waarden kan een aanvaller zelf invullen.
function clientIp(req) {
  const parts = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : req.socket.remoteAddress || "?";
}
// Extra rem over alle IP-adressen samen: max 20 foute pogingen per uur.
const globalFails = { n: 0, since: Date.now(), until: 0 };
function isLocked(ip) {
  if (globalFails.until > Date.now()) return true;
  const f = failures.get(ip); return !!(f && f.until > Date.now());
}
function registerFailure(ip) {
  if (Date.now() - globalFails.since > 60 * 60 * 1000) { globalFails.n = 0; globalFails.since = Date.now(); }
  if (++globalFails.n >= 20) { globalFails.until = Date.now() + 15 * 60 * 1000; globalFails.n = 0; log("ALLE logins 15 min geblokkeerd (te veel foute pogingen)"); }
  const f = failures.get(ip) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.n = 0; log(`login geblokkeerd voor ${ip} (15 min)`); }
  failures.set(ip, f);
}

function redirectAllowed(uri) {
  try {
    const u = new URL(uri);
    const host = u.hostname.toLowerCase();
    const local = host === "localhost" || host === "127.0.0.1";
    if (!local && u.protocol !== "https:") return false;
    return ALLOWED_REDIRECT_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch (_) { return false; }
}

// ---------------------------------------------------------------- hulpfuncties HTTP
const SEC_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === "object";
  res.writeHead(status, { ...SEC_HEADERS, "Content-Type": isObj ? "application/json" : "text/plain; charset=utf-8", ...headers });
  res.end(isObj ? JSON.stringify(body) : body || "");
}
function oauthError(res, status, error, description) { send(res, status, { error, error_description: description }); }
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("te groot")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function readParams(req) {
  const raw = await readBody(req, 64 * 1024);
  const ct = String(req.headers["content-type"] || "");
  if (ct.includes("application/json")) { try { return JSON.parse(raw || "{}"); } catch (_) { return {}; } }
  return Object.fromEntries(new URLSearchParams(raw));
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- OAuth-metadata
function protectedResourceMeta() {
  return { resource: RESOURCE, authorization_servers: [PUBLIC_URL], bearer_methods_supported: ["header"], resource_name: "VAG BBT-server" };
}
function authServerMeta() {
  return {
    issuer: PUBLIC_URL,
    authorization_endpoint: PUBLIC_URL + "/authorize",
    token_endpoint: PUBLIC_URL + "/token",
    registration_endpoint: PUBLIC_URL + "/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["bbt"],
  };
}

// ---------------------------------------------------------------- /register (dynamische registratie)
async function handleRegister(req, res) {
  const p = await readParams(req);
  const uris = Array.isArray(p.redirect_uris) ? p.redirect_uris.map(String) : [];
  if (!uris.length) return oauthError(res, 400, "invalid_redirect_uri", "redirect_uris ontbreekt");
  const bad = uris.find((u) => !redirectAllowed(u));
  if (bad) { log("registratie geweigerd, redirect niet toegelaten:", bad); return oauthError(res, 400, "invalid_redirect_uri", "Redirect-adres niet toegelaten: " + bad); }
  const clientId = "c_" + rnd(16);
  const authMethod = p.token_endpoint_auth_method || "none";
  const client = { redirect_uris: uris, name: String(p.client_name || "onbekend").slice(0, 100), auth: authMethod, created: new Date().toISOString() };
  const out = { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: authMethod, client_name: client.name };
  if (authMethod !== "none") { const secret = rnd(32); client.secret_hash = sha(secret); out.client_secret = secret; out.client_secret_expires_at = 0; }
  store.clients[clientId] = client; saveStore();
  log(`client geregistreerd: ${client.name} (${clientId})`);
  send(res, 201, out);
}

// ---------------------------------------------------------------- /authorize (loginpagina)
function loginPage(q, message = "") {
  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "response_type", "scope", "resource"]
    .map((k) => `<input type="hidden" name="${k}" value="${esc(q[k])}">`).join("");
  return `<!DOCTYPE html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VAG BBT-server – inloggen</title>
<style>body{font-family:system-ui,sans-serif;background:#f3f5f9;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#fff;padding:28px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.08);width:min(340px,90vw)}
h1{font-size:20px;margin:0 0 4px;color:#0b3d91}p{color:#555;font-size:14px;margin:0 0 18px}
input[type=password]{width:100%;box-sizing:border-box;padding:10px;font-size:16px;border:1px solid #ccc;border-radius:8px}
button{margin-top:14px;width:100%;padding:11px;font-size:16px;border:0;border-radius:8px;background:#0b3d91;color:#fff;cursor:pointer}
.err{color:#b00020;font-size:14px;margin-top:10px}</style></head><body>
<form method="post" action="/authorize">${hidden}
<h1>VAG BBT-server</h1><p>Claude vraagt toegang tot BBT. Geef het wachtwoord in om toe te staan.</p>
<input type="password" name="password" autofocus autocomplete="current-password" placeholder="Wachtwoord" required>
<button type="submit">Toegang geven</button>${message ? `<div class="err">${esc(message)}</div>` : ""}
</form></body></html>`;
}

function validateAuthorizeParams(q) {
  const client = store.clients[q.client_id];
  if (!client) return "Onbekende client. Verwijder de connector in Claude en voeg hem opnieuw toe.";
  if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) return "Redirect-adres komt niet overeen.";
  if (q.response_type !== "code") return "Enkel response_type=code wordt ondersteund.";
  if (!q.code_challenge || q.code_challenge_method !== "S256") return "PKCE (S256) is verplicht.";
  return null;
}

async function handleAuthorize(req, res, url) {
  const html = (status, body) => send(res, status, body, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:" });
  if (req.method === "GET") {
    const q = Object.fromEntries(url.searchParams);
    const err = validateAuthorizeParams(q);
    if (err) return html(400, `<p>${esc(err)}</p>`);
    return html(200, loginPage(q));
  }
  if (req.method !== "POST") return send(res, 405, "Method not allowed");
  const q = await readParams(req);
  const err = validateAuthorizeParams(q);
  if (err) return html(400, `<p>${esc(err)}</p>`);
  const ip = clientIp(req);
  if (isLocked(ip)) return html(429, loginPage(q, "Te veel foute pogingen. Probeer over 15 minuten opnieuw."));
  if (!safeEqual(q.password || "", ADMIN_PASSWORD)) {
    registerFailure(ip); log(`foute login vanaf ${ip}`);
    return html(401, loginPage(q, "Fout wachtwoord."));
  }
  failures.delete(ip);
  const code = rnd(32);
  codes.set(sha(code), { clientId: q.client_id, redirectUri: q.redirect_uri, challenge: q.code_challenge, exp: Date.now() + CODE_TTL_MS, resource: q.resource || RESOURCE });
  log(`login ok vanaf ${ip} voor ${store.clients[q.client_id].name}`);
  const back = new URL(q.redirect_uri);
  back.searchParams.set("code", code);
  if (q.state) back.searchParams.set("state", q.state);
  back.searchParams.set("iss", PUBLIC_URL);
  res.writeHead(302, { ...SEC_HEADERS, Location: back.toString() });
  res.end();
}

// ---------------------------------------------------------------- /token
function issueTokens(clientId) {
  const access = rnd(32), refresh = rnd(32), now = Date.now();
  store.access[sha(access)] = { clientId, exp: now + ACCESS_TTL_S * 1000 };
  store.refresh[sha(refresh)] = { clientId, exp: now + REFRESH_TTL_S * 1000 };
  saveStore();
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: "bbt" };
}

function authenticateClient(req, p) {
  let id = p.client_id, secret = p.client_secret;
  const h = String(req.headers.authorization || "");
  if (h.startsWith("Basic ")) {
    const [a, b] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
    id = decodeURIComponent(a || ""); secret = decodeURIComponent(b || "");
  }
  const client = store.clients[id];
  if (!client) return null;
  if (client.secret_hash && !(secret && safeEqual(sha(secret), client.secret_hash))) return null;
  return id;
}

async function handleToken(req, res) {
  if (req.method !== "POST") return send(res, 405, "Method not allowed");
  const p = await readParams(req);
  const clientId = authenticateClient(req, p);
  if (!clientId) return oauthError(res, 401, "invalid_client", "Onbekende of foute client");

  if (p.grant_type === "authorization_code") {
    const key = sha(p.code || "");
    const c = codes.get(key);
    codes.delete(key); // eenmalig bruikbaar
    if (!c || c.exp < Date.now() || c.clientId !== clientId) return oauthError(res, 400, "invalid_grant", "Code ongeldig of verlopen");
    if (p.redirect_uri && p.redirect_uri !== c.redirectUri) return oauthError(res, 400, "invalid_grant", "redirect_uri komt niet overeen");
    if (!p.code_verifier || sha(p.code_verifier) !== c.challenge) return oauthError(res, 400, "invalid_grant", "PKCE-controle mislukt");
    return send(res, 200, issueTokens(clientId));
  }
  if (p.grant_type === "refresh_token") {
    const key = sha(p.refresh_token || "");
    const t = store.refresh[key];
    if (!t || t.exp < Date.now() || t.clientId !== clientId) return oauthError(res, 400, "invalid_grant", "Refresh token ongeldig of verlopen");
    delete store.refresh[key]; // rotatie: oude refresh token vervalt
    return send(res, 200, issueTokens(clientId));
  }
  return oauthError(res, 400, "unsupported_grant_type", "Enkel authorization_code en refresh_token");
}

// ---------------------------------------------------------------- /mcp
function checkBearer(req) {
  const h = String(req.headers.authorization || "");
  if (!h.startsWith("Bearer ")) return false;
  const t = store.access[sha(h.slice(7).trim())];
  return !!(t && t.exp > Date.now() && store.clients[t.clientId]);
}

async function handleMcp(req, res) {
  if (!checkBearer(req)) {
    return send(res, 401, { error: "invalid_token", error_description: "Inloggen vereist" }, {
      "WWW-Authenticate": `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`,
    });
  }
  if (req.method === "GET") return send(res, 405, "Geen SSE-stream; gebruik POST", { Allow: "POST" });
  if (req.method === "DELETE") return send(res, 200, "");
  if (req.method !== "POST") return send(res, 405, "Method not allowed", { Allow: "POST" });

  let msg;
  try { msg = JSON.parse(await readBody(req)); }
  catch (_) { return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }

  const batch = Array.isArray(msg);
  const results = (await Promise.all((batch ? msg : [msg]).map((m) => handle(m)))).filter(Boolean);
  if (!results.length) return send(res, 202, "");
  send(res, 200, batch ? results : results[0]);
}

// ---------------------------------------------------------------- router
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  try {
    // DNS-rebinding: browserverzoeken van vreemde sites weigeren
    const origin = req.headers.origin;
    if (origin && p === "/mcp" && !/^https:\/\/(claude\.ai|claude\.com)$/.test(origin) && origin !== PUBLIC_URL) return send(res, 403, "Origin niet toegelaten");

    if (p === "/") return send(res, 200, `${SERVER_NAME} v${SERVER_VERSION} draait.`);
    if (p.startsWith("/.well-known/oauth-protected-resource")) return send(res, 200, protectedResourceMeta());
    if (p.startsWith("/.well-known/oauth-authorization-server") || p.startsWith("/.well-known/openid-configuration")) return send(res, 200, authServerMeta());
    if (p === "/register" && req.method === "POST") return await handleRegister(req, res);
    if (p === "/authorize") return await handleAuthorize(req, res, url);
    if (p === "/token") return await handleToken(req, res);
    if (p === "/mcp") return await handleMcp(req, res);
    send(res, 404, "Niet gevonden");
  } catch (e) {
    log("http-fout", p, e && e.message);
    if (!res.headersSent) send(res, 500, "Interne fout");
  }
});

// codes opruimen
setInterval(() => { const n = Date.now(); for (const [k, c] of codes) if (c.exp < n) codes.delete(k); }, 60 * 1000).unref();

server.listen(PORT, HOST, () => log(`webversie v${SERVER_VERSION} luistert op http://${HOST}:${PORT} – publiek: ${PUBLIC_URL}/mcp – API-key ${API_KEY ? "ingesteld" : "ONTBREEKT"}`));
