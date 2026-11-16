// VAG Stockviewer – front-end (geen externe bibliotheken)
"use strict";
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf = new Intl.NumberFormat("nl-BE", { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat("nl-BE", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const eur = (n) => "€ " + nf.format(Math.round(n));
  const eur2 = (n) => "€ " + nf2.format(n);
  const kmf = (n) => nf.format(n) + " km";
  const prijsTxt = (c) => (c.prijs ? eur(c.prijs) : "Prijs op aanvraag");
  const maand = (d) => (d ? d.slice(5, 7) + "/" + d.slice(0, 4) : "");
  const datum = (iso) => new Date(iso).toLocaleString("nl-BE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} } };
  const ICON = {
    star: '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9Z"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    mode: '<svg class="eye-closed" viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.5M6.2 7.3C4 9 3 12 3 12s4 6 9 6a8.8 8.8 0 0 0 4-1"/></svg><svg class="eye-open" viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg>',
  };

  // ---------------------------------------------------------------- state
  const S = {
    cars: [], byId: new Map(), bijgewerkt: null,
    intern: null,          // enkel gevuld in dealermodus
    dealer: false,
    q: "", filters: {}, filtersOpen: store.get("vs_filtersOpen", window.innerWidth > 700),
    favs: new Set(store.get("vs_favs", [])),
    leads: [],
  };
  const FILTERS = [
    ["modelgroep", "Model"], ["carrosserie", "Carrosserie"], ["brandstof", "Brandstof"],
    ["transmissie", "Transmissie"], ["kleurgroep", "Kleur"], ["prijsband", "Prijs"], ["kmband", "Km"],
  ];
  const PRIJS = [["< € 30.000", 0, 30000], ["€ 30–40.000", 30000, 40000], ["€ 40–50.000", 40000, 50000], ["€ 50–75.000", 50000, 75000], ["> € 75.000", 75000, Infinity], ["Op aanvraag", -1, -1]];
  const KM = [["< 10.000 km", 0, 10000], ["10–25.000 km", 10000, 25000], ["25–50.000 km", 25000, 50000], ["> 50.000 km", 50000, Infinity]];
  const band = (list, v) => { for (const [l, a, b] of list) if (a === -1 ? v == null : v != null && v >= a && v < b) return l; return ""; };

  // ---------------------------------------------------------------- API
  async function api(path, opts = {}) {
    const res = await fetch("api/" + path, {
      credentials: "same-origin", cache: "no-store", ...opts,
      headers: { "X-Stockviewer": "1", "ngrok-skip-browser-warning": "1", ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) },
    });
    let data = null; try { data = await res.json(); } catch (_) {}
    if (res.status === 401 && path !== "login") { showLogin(); throw new Error("login"); }
    if (!res.ok) throw new Error((data && data.fout) || "Fout " + res.status);
    return data;
  }

  async function load(refresh = false) {
    const btn = $("#btn-refresh"); btn.classList.add("spin");
    try {
      const d = await api("cars" + (refresh ? "?refresh=1" : ""));
      S.cars = d.wagens.map((c) => ({ ...c, prijsband: band(PRIJS, c.prijs), kmband: band(KM, c.km), _txt: norm([c.referentie, c.merk, c.model, c.uitvoering, ...c.opties].join(" | ")) }));
      S.byId = new Map(S.cars.map((c) => [c.id, c]));
      S.bijgewerkt = d.bijgewerkt;
      for (const id of [...S.favs]) if (!S.byId.has(id)) S.favs.delete(id);
      if (S.dealer) await loadIntern(refresh);
      render();
      if (refresh) toast("Stock vernieuwd · " + datum(d.bijgewerkt));
    } catch (e) { if (e.message !== "login") { $("#status").textContent = "Kon de stock niet laden: " + e.message; toast("Laden mislukt: " + e.message); } }
    finally { btn.classList.remove("spin"); }
  }
  async function loadIntern(refresh = false) {
    const d = await api("intern" + (refresh ? "?refresh=1" : ""));
    S.intern = d.intern;
    try { S.leads = (await api("leads")).leads; } catch (_) { S.leads = []; }
    $("#leads-count").textContent = S.leads.length || "";
  }

  // ---------------------------------------------------------------- modus
  let idleTimer = null;
  const IDLE_MS = 5 * 60 * 1000; // dealermodus valt na 5 min zonder aanraking terug naar klantmodus
  async function setDealer(on) {
    if (on) {
      try { await loadIntern(); } catch (e) { if (e.message !== "login") toast("Interne gegevens laden mislukt"); return; }
      S.dealer = true;
    } else {
      S.dealer = false; S.intern = null; S.leads = []; // interne data uit het geheugen
      if (!$("#view-leads").hidden) closeOverlay($("#view-leads"));
    }
    document.body.classList.toggle("dealer", S.dealer);
    $("#modebar").hidden = !S.dealer;
    $("#btn-leads").hidden = !S.dealer;
    document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(S.dealer)));
    $("#leads-count").textContent = S.dealer && S.leads.length ? S.leads.length : "";
    renderGrid();
    rerenderOpen();
    armIdle();
  }
  function armIdle() { clearTimeout(idleTimer); if (S.dealer) idleTimer = setTimeout(() => { setDealer(false); toast("Terug in klantmodus"); }, IDLE_MS); }
  ["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, () => S.dealer && armIdle(), { passive: true }));
  document.addEventListener("visibilitychange", () => { if (document.hidden && S.dealer) setDealer(false); }); // app naar achtergrond → klantmodus

  // ---------------------------------------------------------------- filteren
  function terms() { const out = []; S.q.replace(/"([^"]+)"|(\S+)/g, (_, a, b) => out.push(norm(a || b))); return out.filter(Boolean); }
  function matchQ(c, t) { return t.every((x) => c._txt.includes(x)); }
  function passFilters(c, skip) {
    for (const [k] of FILTERS) { if (k === skip) continue; const set = S.filters[k]; if (set && set.size && !set.has(c[k])) return false; }
    return true;
  }
  function visible() { const t = terms(); return S.cars.filter((c) => matchQ(c, t) && passFilters(c)); }

  // ---------------------------------------------------------------- render: lijst
  function render() { renderFilters(); renderGrid(); renderCompareBar(); }

  function renderFilters() {
    const el = $("#filters"); const t = terms();
    el.classList.toggle("closed", !S.filtersOpen);
    $("#btn-filters").textContent = S.filtersOpen ? "Filters verbergen" : "Filters";
    const order = { prijsband: PRIJS.map((x) => x[0]), kmband: KM.map((x) => x[0]) };
    el.innerHTML = FILTERS.map(([k, lab]) => {
      const counts = new Map();
      for (const c of S.cars) if (c[k]) counts.set(c[k], 0);
      for (const c of S.cars) if (c[k] && matchQ(c, t) && passFilters(c, k)) counts.set(c[k], counts.get(c[k]) + 1);
      let vals = [...counts.keys()];
      if (order[k]) vals = order[k].filter((v) => counts.has(v));
      else vals.sort((a, b) => (counts.get(b) - counts.get(a)) || a.localeCompare(b, "nl"));
      const sel = S.filters[k] || new Set();
      return `<div class="fgroup" data-k="${k}"><span class="fgroup-label">${lab}</span>${vals.map((v) =>
        `<button class="chip${sel.has(v) ? " on" : ""}${counts.get(v) ? "" : " zero"}" data-v="${esc(v)}" aria-pressed="${sel.has(v)}">${esc(v)} <small>${counts.get(v)}</small></button>`).join("")}</div>`;
    }).join("");
    const active = Object.values(S.filters).some((s) => s.size) || S.q;
    $("#btn-reset").hidden = !active;
  }

  function hitsFor(c, t) {
    if (!t.length) return [];
    return c.opties.filter((o) => { const n = norm(o); return t.some((x) => n.includes(x)); }).slice(0, 4);
  }
  function badgeHtml(c, inCard) {
    let b = "";
    if (c.direct_beschikbaar) b += '<span class="badge green">Direct beschikbaar</span>';
    if (c.gereserveerd) b += '<span class="badge res">Gereserveerd</span>';
    const i = S.dealer && S.intern && S.intern[c.id];
    if (i && inCard) for (const s of i.schade) b += `<span class="badge dmg">${esc(s)}</span>`;
    return b;
  }
  function dealerLine(c) {
    const i = S.dealer && S.intern && S.intern[c.id];
    if (!i) return "";
    return `<div class="dealerline"><span>${esc(i.locatie)}</span>${i.statussen.map((s) => `<span>${esc(s)}</span>`).join("")}${i.reservatie ? `<span>Res.: ${esc(i.reservatie)}</span>` : ""}</div>`;
  }
  function renderGrid() {
    const list = visible(); const t = terms();
    $("#count").textContent = list.length === S.cars.length ? `${S.cars.length} wagens in stock` : `${list.length} van ${S.cars.length} wagens`;
    $("#status").textContent = !S.cars.length ? "Stock laden…" : !list.length ? "Geen wagens gevonden met deze filters." : S.bijgewerkt ? "Bijgewerkt " + datum(S.bijgewerkt) : "";
    $("#grid").innerHTML = list.map((c) => {
      const f = c.fotos[0];
      const hits = hitsFor(c, t);
      return `<article class="card" data-id="${esc(c.id)}" role="button" tabindex="0">
        <div class="ph">${f ? `<img src="${esc(f.m)}" alt="" loading="lazy" decoding="async">` : '<div class="noimg">VAG</div>'}
          <div class="badges">${badgeHtml(c, true)}</div>
          <button class="fav${S.favs.has(c.id) ? " on" : ""}" data-fav="${esc(c.id)}" aria-label="Favoriet">${ICON.star}</button></div>
        <div class="body">
          <h3>${esc(c.model)}</h3>
          <div class="exec">${esc(c.uitvoering)}</div>
          <div class="ref">Ref. ${esc(c.referentie)}</div>
          <div class="meta"><span>${esc(c.bouwjaar)}</span><span>${kmf(c.km)}</span><span>${esc(c.brandstof)}</span></div>
          ${hits.length ? `<div class="hits">${hits.map((h) => `<span class="hit">✓ ${esc(h)}</span>`).join("")}</div>` : ""}
          <div class="price${c.prijs ? "" : " ask"}">${prijsTxt(c)}</div>
          ${dealerLine(c)}
        </div></article>`;
    }).join("");
  }
  function renderCompareBar() {
    const n = S.favs.size;
    $("#comparebar").hidden = n === 0;
    $("#fav-count").textContent = n === 1 ? "1 favoriet" : `${n} favorieten`;
    $("#btn-compare").disabled = n < 2;
  }
  function toggleFav(id) {
    if (S.favs.has(id)) S.favs.delete(id);
    else { if (S.favs.size >= 4) { toast("Max. 4 wagens vergelijken"); return; } S.favs.add(id); }
    store.set("vs_favs", [...S.favs]);
    document.querySelectorAll(`[data-fav="${CSS.escape(id)}"]`).forEach((b) => b.classList.toggle("on", S.favs.has(id)));
    renderCompareBar();
    if (!$("#view-compare").hidden) renderCompare();
  }

  // ---------------------------------------------------------------- overlays
  const stack = [];
  function openOverlay(el) { el.hidden = false; el.scrollTop = 0; if (!stack.includes(el)) stack.push(el); document.body.classList.add("locked"); }
  function closeOverlay(el) { el.hidden = true; el.innerHTML = ""; const i = stack.indexOf(el); if (i >= 0) stack.splice(i, 1); if (!stack.length) document.body.classList.remove("locked"); }
  let openDetailId = null;
  function rerenderOpen() {
    if (openDetailId && !$("#view-detail").hidden) renderDetail(openDetailId, true);
    if (!$("#view-compare").hidden) renderCompare();
  }

  // ---------------------------------------------------------------- fiche
  function gallery(c, cls = "") {
    if (!c.fotos.length) return '<div class="gallery"><div class="slide"><div class="noimg">Geen foto\'s</div></div></div>';
    return `<div class="gallery ${cls}"><div class="slides">${c.fotos.map((f, i) =>
      `<div class="slide"><img src="${esc(f.l)}" alt="" data-i="${i}" ${i > 1 ? 'loading="lazy"' : ""} decoding="async"></div>`).join("")}</div>
      <span class="gal-count">1 / ${c.fotos.length}</span>
      <button class="gal-nav prev" aria-label="Vorige">${ICON.prev}</button><button class="gal-nav next" aria-label="Volgende">${ICON.next}</button></div>
      <div class="thumbs">${c.fotos.map((f, i) => `<button data-t="${i}" class="${i ? "" : "on"}"><img src="${esc(f.t)}" alt="" loading="lazy"></button>`).join("")}</div>`;
  }
  function wireGallery(root, n, onIndex) {
    const slides = $(".slides", root); if (!slides) return;
    const count = $(".gal-count", root);
    const idx = () => Math.round(slides.scrollLeft / slides.clientWidth);
    const go = (i) => slides.scrollTo({ left: Math.max(0, Math.min(n - 1, i)) * slides.clientWidth, behavior: "smooth" });
    let raf = 0;
    slides.addEventListener("scroll", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => {
      const i = idx(); if (count) count.textContent = `${i + 1} / ${n}`;
      root.querySelectorAll(".thumbs button").forEach((b, j) => b.classList.toggle("on", j === i));
      const tb = root.querySelector(`.thumbs button[data-t="${i}"]`), th = tb && tb.parentElement;
      if (tb && (tb.offsetLeft < th.scrollLeft || tb.offsetLeft + tb.offsetWidth > th.scrollLeft + th.clientWidth)) th.scrollTo({ left: tb.offsetLeft - th.clientWidth / 2 + tb.offsetWidth / 2, behavior: "smooth" });
      onIndex && onIndex(i);
    }); }, { passive: true });
    const p = $(".gal-nav.prev", root), nx = $(".gal-nav.next", root);
    if (p) p.onclick = (e) => { e.stopPropagation(); go(idx() - 1); };
    if (nx) nx.onclick = (e) => { e.stopPropagation(); go(idx() + 1); };
    root.querySelectorAll(".thumbs button").forEach((b) => (b.onclick = () => go(+b.dataset.t)));
    return { go, idx };
  }

  function specRows(c) {
    const r = [
      ["Bouwjaar", c.bouwjaar], ["1e inschrijving", maand(c.inschrijving)], ["Kilometerstand", kmf(c.km)],
      ["Brandstof", c.brandstof], ["Transmissie", c.transmissie + (c.versnellingen ? ` (${c.versnellingen})` : "")],
      ["Vermogen", c.kw ? `${c.kw} kW / ${c.pk} pk` : ""], ["Cilinderinhoud", c.cilinderinhoud ? nf.format(+c.cilinderinhoud) + " cc" : ""],
      ["CO₂ (WLTP)", c.co2 ? c.co2 + " g/km" : ""], ["Euronorm", c.euronorm], ["Carrosserie", c.carrosserie],
      ["Kleur", c.kleur], ["Interieur", c.interieur], ["Deuren", c.deuren],
    ];
    return r.filter((x) => x[1]).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
  }
  function internPanel(c) {
    const i = S.dealer && S.intern && S.intern[c.id];
    if (!i) return "";
    const rows = [
      ["Locatie", i.locatie], ["Aankoopprijs", eur2(i.aankoopprijs)],
      ["Netto marge", `<span class="${i.marge >= 0 ? "pos" : "neg"}">${esc(eur2(i.marge))}</span>`, true],
      ["Nieuwprijs", i.nieuwprijs ? eur(i.nieuwprijs) : ""], ["Schade", i.schade.length ? i.schade.join(", ") : "Geen open schade"],
      ["Schadebedrag", i.schadebedrag ? eur2(i.schadebedrag) : ""], ["Leverancier", i.leverancier],
      ["Status", i.statussen.join(", ")], ["Reservatie", i.reservatie], ["VIN", i.vin], ["Nummerplaat", i.nummerplaat], ["Aankoopdatum", i.aankoopdatum],
    ].filter((x) => x[1]);
    return `<div class="panel intern"><h3>Intern (dealermodus)</h3><dl class="specs">${rows.map(([k, v, raw]) => `<div><dt>${k}</dt><dd>${raw ? v : esc(v)}</dd></div>`).join("")}</dl>
      ${i.schade_details ? `<p class="note"><b>Schadedetails:</b> ${esc(i.schade_details)}</p>` : ""}
      ${i.memo ? `<p class="note"><b>Memo:</b> ${esc(i.memo)}</p>` : ""}
      ${i.notitie ? `<p class="note"><b>Notitie:</b> ${esc(i.notitie)}</p>` : ""}</div>`;
  }
  function highlight(text, t) {
    if (!t.length) return esc(text);
    const n = norm(text); const marks = new Array(text.length).fill(false);
    for (const x of t) { let i = n.indexOf(x); while (x && i >= 0) { for (let j = i; j < i + x.length; j++) marks[j] = true; i = n.indexOf(x, i + x.length); } }
    let out = "", on = false;
    for (let i = 0; i < text.length; i++) { if (marks[i] !== on) { out += marks[i] ? "<mark>" : "</mark>"; on = marks[i]; } out += esc(text[i]); }
    return out + (on ? "</mark>" : "");
  }
  function renderOptions(c, root, q) {
    const t = []; String(q || "").replace(/"([^"]+)"|(\S+)/g, (_, a, b) => t.push(norm(a || b)));
    const ul = $(".opts", root); const info = $(".opt-info", root);
    let n = 0;
    const items = c.opties.map((o) => { const m = t.length && t.some((x) => norm(o).includes(x)); if (m) n++; return { o, m }; });
    items.sort((a, b) => (b.m - a.m)); // gevonden opties bovenaan
    ul.innerHTML = items.map(({ o, m }) => `<li class="${m ? "match" : t.length ? "dim" : ""}">${highlight(o, m ? t : [])}</li>`).join("");
    info.textContent = t.length ? (n ? `${n} van ${c.opties.length} opties gevonden` : "Geen opties gevonden") : `${c.opties.length} opties`;
  }
  function renderDetail(id, keepScroll) {
    const c = S.byId.get(id); if (!c) return;
    openDetailId = id;
    const el = $("#view-detail");
    const sc = el.scrollTop; const prevQ = keepScroll ? ($(".opt-search input", el) || {}).value : null;
    el.innerHTML = `<div class="ov-head"><button class="icon-btn" data-close aria-label="Terug">${ICON.back}</button><h2>${esc(c.merk)} ${esc(c.model)}</h2>
        <button class="fav${S.favs.has(c.id) ? " on" : ""}" data-fav="${esc(c.id)}" aria-label="Favoriet">${ICON.star}</button><button class="icon-btn mode-btn" data-mode aria-label="Wissel klant/dealer">${ICON.mode}</button></div>
      <div class="ov-body"><div class="detail-grid">
        <div>${gallery(c)}
          <h1 class="d-title">${esc(c.model)}</h1><p class="d-exec">${esc(c.uitvoering)}</p><p class="d-ref">Referentie ${esc(c.referentie)}</p>
          <div class="d-badges">${badgeHtml(c, false)}</div>
          <div class="panel"><h3>Specificaties</h3><dl class="specs">${specRows(c)}</dl></div>
          <div class="panel"><h3>Opties</h3>
            <div class="opt-search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input type="search" placeholder="Zoek in de opties van deze wagen" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></div>
            <p class="opt-info"></p><ul class="opts"></ul></div>
        </div>
        <div class="detail-side">
          <div class="panel"><div class="d-price${c.prijs ? "" : " ask"}">${prijsTxt(c)}</div>
            <div class="actions">
              <button class="btn yellow" data-lead>Lead aanmaken</button>
              ${c.carpass ? `<a class="btn ghost" href="${esc(c.carpass)}" target="_blank" rel="noopener noreferrer">Car-Pass bekijken</a>` : ""}
              <button class="btn ghost" data-fav="${esc(c.id)}">${S.favs.has(c.id) ? "Uit favorieten" : "Bij favorieten (vergelijken)"}</button>
            </div></div>
          ${internPanel(c)}
        </div></div></div>`;
    if (!keepScroll) openOverlay(el); else el.scrollTop = sc;
    const n = c.fotos.length;
    wireGallery(el, n);
    el.querySelectorAll(".slides img").forEach((img) => (img.onclick = () => openLightbox(c, +img.dataset.i)));
    const inp = $(".opt-search input", el);
    inp.value = prevQ != null ? prevQ : S.q;
    renderOptions(c, el, inp.value);
    inp.oninput = () => renderOptions(c, el, inp.value);
    $("[data-lead]", el).onclick = () => openLeadForm(c);
  }

  function openLightbox(c, start) {
    const lb = $("#lightbox");
    lb.innerHTML = `<button class="lb-close" aria-label="Sluiten">${ICON.close}</button><div class="slides">${c.fotos.map((f) => `<div class="slide"><img src="${esc(f.l)}" alt="" decoding="async"></div>`).join("")}</div><span class="gal-count">${start + 1} / ${c.fotos.length}</span>`;
    lb.hidden = false;
    const slides = $(".slides", lb);
    requestAnimationFrame(() => { slides.scrollLeft = start * slides.clientWidth; });
    wireGallery(lb, c.fotos.length);
    $(".lb-close", lb).onclick = () => { lb.hidden = true; lb.innerHTML = ""; };
  }

  // ---------------------------------------------------------------- lead
  function openLeadForm(c) {
    const w = $("#sheet");
    w.innerHTML = `<form class="sheet" novalidate><h3>Lead aanmaken</h3><p class="sub">${esc(c.model)} ${esc(c.uitvoering)} · ${prijsTxt(c)}</p>
      <label for="l-naam">Naam *</label><input id="l-naam" name="naam" autocomplete="off" required>
      <label for="l-tel">Telefoon</label><input id="l-tel" name="telefoon" type="tel" inputmode="tel" autocomplete="off">
      <label for="l-mail">E-mail</label><input id="l-mail" name="email" type="email" inputmode="email" autocomplete="off" autocapitalize="off">
      <label for="l-opm">Opmerking</label><textarea id="l-opm" name="opmerking" placeholder="bv. wil proefrit, inruil GLA 2019"></textarea>
      <p class="err" hidden></p>
      <div class="row"><button type="button" class="btn ghost" data-cancel>Annuleren</button><button type="submit" class="btn blue">Bewaren</button></div></form>`;
    w.hidden = false;
    const f = $("form", w), err = $(".err", w);
    const close = () => { w.hidden = true; w.innerHTML = ""; };
    $("[data-cancel]", w).onclick = close;
    w.onclick = (e) => { if (e.target === w) close(); };
    setTimeout(() => $("#l-naam").focus(), 50);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      if (!d.naam.trim()) return showErr("Naam is verplicht.");
      if (!d.telefoon.trim() && !d.email.trim()) return showErr("Geef een telefoonnummer of e-mailadres.");
      const btn = $("button[type=submit]", f); btn.disabled = true;
      try {
        await api("leads", { method: "POST", body: JSON.stringify({ ...d, wagen_id: c.id }) });
        close(); toast("Lead bewaard ✓");
        if (S.dealer) { try { S.leads = (await api("leads")).leads; $("#leads-count").textContent = S.leads.length || ""; } catch (_) {} }
      } catch (ex) { btn.disabled = false; if (ex.message !== "login") showErr(ex.message); }
    };
    function showErr(m) { err.textContent = m; err.hidden = false; }
  }

  function renderLeads() {
    const el = $("#view-leads");
    el.innerHTML = `<div class="ov-head"><button class="icon-btn" data-close aria-label="Terug">${ICON.back}</button><h2>Leads (${S.leads.length})</h2><button class="icon-btn mode-btn" data-mode aria-label="Wissel klant/dealer">${ICON.mode}</button></div>
      <div class="ov-body">${S.leads.length ? S.leads.map((l) => `<div class="lead"><h4>${esc(l.naam)}</h4>
        <div class="sub">${datum(l.aangemaakt)} · ${esc(l.wagen.model)} · ref ${esc(l.wagen.referentie)}${l.wagen.prijs ? " · " + eur(l.wagen.prijs) : ""}</div>
        <div>${l.telefoon ? `<a href="tel:${esc(l.telefoon.replace(/[^\d+]/g, ""))}">${esc(l.telefoon)}</a>` : ""}${l.telefoon && l.email ? " · " : ""}${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : ""}</div>
        ${l.opmerking ? `<p>${esc(l.opmerking)}</p>` : ""}</div>`).join("") : '<p class="status">Nog geen leads.</p>'}</div>`;
    openOverlay(el);
  }

  // ---------------------------------------------------------------- vergelijken
  function renderCompare() {
    const el = $("#view-compare");
    const cars = [...S.favs].map((id) => S.byId.get(id)).filter(Boolean);
    if (cars.length < 1) { closeOverlay(el); return; }
    const row = (lab, f, cls = "") => `<tr class="${cls}"><td>${lab}</td>${cars.map((c) => `<td>${f(c)}</td>`).join("")}</tr>`;
    const all = new Set(); cars.forEach((c) => c.opties.forEach((o) => all.add(o)));
    const diff = [...all].filter((o) => !cars.every((c) => c.opties.includes(o))).sort((a, b) => a.localeCompare(b, "nl"));
    const intern = S.dealer && S.intern;
    el.innerHTML = `<div class="ov-head"><button class="icon-btn" data-close aria-label="Terug">${ICON.back}</button><h2>Vergelijken (${cars.length})</h2><button class="icon-btn mode-btn" data-mode aria-label="Wissel klant/dealer">${ICON.mode}</button></div>
      <div class="ov-body"><div class="cmp-wrap"><table class="cmp"><tbody>
        ${row("", (c) => `${c.fotos[0] ? `<img src="${esc(c.fotos[0].m)}" alt="">` : ""}<button class="link-btn rm" data-fav="${esc(c.id)}">Verwijderen</button>`)}
        ${row("Model", (c) => `<b>${esc(c.model)}</b><br><span class="muted">${esc(c.uitvoering)}</span>`)}
        ${row("Referentie", (c) => esc(c.referentie))}
        ${row("Prijs", (c) => `<span class="p">${prijsTxt(c)}</span>`)}
        ${row("Beschikbaar", (c) => [c.direct_beschikbaar ? '<span class="badge green">Direct beschikbaar</span>' : "", c.gereserveerd ? '<span class="badge res">Gereserveerd</span>' : ""].join(" ") || "–")}
        ${row("Bouwjaar", (c) => esc(c.bouwjaar) + (c.inschrijving ? ` (${maand(c.inschrijving)})` : ""))}
        ${row("Km", (c) => kmf(c.km))}
        ${row("Brandstof", (c) => esc(c.brandstof))}
        ${row("Transmissie", (c) => esc(c.transmissie))}
        ${row("Vermogen", (c) => (c.kw ? `${c.kw} kW / ${c.pk} pk` : "–"))}
        ${row("CO₂", (c) => (c.co2 ? esc(c.co2) + " g/km" : "–"))}
        ${row("Kleur", (c) => esc(c.kleur))}
        ${row("Interieur", (c) => esc(c.interieur))}
        ${row("Carrosserie", (c) => esc(c.carrosserie))}
        ${row("Opties", (c) => c.opties.length + " opties")}
        ${intern ? row("Intern", (c) => { const i = S.intern[c.id]; return i ? `${esc(i.locatie)}${i.schade.length ? "<br><b>" + esc(i.schade.join(", ")) + "</b>" : ""}${i.reservatie ? "<br>Res.: " + esc(i.reservatie) : ""}` : ""; }, "intern-row") : ""}
        ${cars.length > 1 && diff.length ? `<tr class="sect"><td colspan="${cars.length + 1}">Verschillen in opties (${diff.length})</td></tr>` + diff.map((o) => `<tr><td class="optname">${esc(o)}</td>${cars.map((c) => c.opties.includes(o) ? '<td class="yes">✓</td>' : '<td class="no">–</td>').join("")}</tr>`).join("") : ""}
      </tbody></table></div></div>`;
    if (el.hidden) openOverlay(el);
  }

  // ---------------------------------------------------------------- login
  function showLogin() { $("#login").hidden = false; setTimeout(() => $("#login-code").focus(), 50); }
  $("#login-form").onsubmit = async (e) => {
    e.preventDefault();
    const err = $("#login-err"); err.hidden = true;
    try {
      await api("login", { method: "POST", body: JSON.stringify({ code: $("#login-code").value }) });
      $("#login-code").value = ""; $("#login").hidden = true; load();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };

  // ---------------------------------------------------------------- toast
  let toastT = 0;
  function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600); }

  // ---------------------------------------------------------------- events
  let qT = 0;
  $("#q").addEventListener("input", (e) => { $("#q-clear").hidden = !e.target.value; clearTimeout(qT); qT = setTimeout(() => { S.q = e.target.value.trim(); renderFilters(); renderGrid(); }, 120); });
  $("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
  $("#q-clear").onclick = () => { $("#q").value = ""; S.q = ""; $("#q-clear").hidden = true; renderFilters(); renderGrid(); };
  $("#btn-filters").onclick = () => { S.filtersOpen = !S.filtersOpen; store.set("vs_filtersOpen", S.filtersOpen); renderFilters(); };
  $("#btn-reset").onclick = () => { S.filters = {}; $("#q").value = ""; S.q = ""; $("#q-clear").hidden = true; render(); };
  $("#filters").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip"); if (!chip) return;
    const k = chip.closest(".fgroup").dataset.k, v = chip.dataset.v;
    const set = S.filters[k] || (S.filters[k] = new Set());
    set.has(v) ? set.delete(v) : set.add(v);
    const sx = chip.closest(".fgroup").scrollLeft;
    renderFilters(); renderGrid();
    const g = $(`.fgroup[data-k="${k}"]`); if (g) g.scrollLeft = sx;
  });
  document.addEventListener("click", (e) => {
    const fav = e.target.closest("[data-fav]");
    if (fav) { e.stopPropagation(); toggleFav(fav.dataset.fav); if (openDetailId && !$("#view-detail").hidden) renderDetail(openDetailId, true); return; }
    if (e.target.closest("[data-mode]")) { setDealer(!S.dealer); return; }
    const close = e.target.closest("[data-close]");
    if (close) { const ov = close.closest(".overlay"); if (ov === $("#view-detail")) openDetailId = null; closeOverlay(ov); return; }
    const card = e.target.closest(".card");
    if (card) renderDetail(card.dataset.id);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.classList && e.target.classList.contains("card")) renderDetail(e.target.dataset.id);
    if (e.key === "Escape") { if (!$("#lightbox").hidden) { $("#lightbox").hidden = true; return; } const top = stack[stack.length - 1]; if (top) { if (top === $("#view-detail")) openDetailId = null; closeOverlay(top); } }
  });
  $("#btn-refresh").onclick = () => load(true);
  $("#btn-leads").onclick = async () => { try { S.leads = (await api("leads")).leads; } catch (_) {} renderLeads(); };
  $("#btn-compare").onclick = () => renderCompare();
  $("#btn-fav-clear").onclick = () => { S.favs.clear(); store.set("vs_favs", []); renderGrid(); renderCompareBar(); };

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => {});
  load();
})();
