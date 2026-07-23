/*
 * content.js — ISOLATED world coordinator.
 * - loads bundled data + builds the route engine
 * - reads the active Pokemon from the party HUD (DOM)
 * - enriches it with live stats from the WebSocket bridge (inject.js)
 * - injects the dock button + renders the route modal (Shadow DOM)
 * - teleports via the game's own enter-hunt command over the live socket
 */
(function () {
  "use strict";

  var engine = null;
  var wsPokes = new Map();     // normName+"@"+level -> ws poke (for stat enrichment)
  var socketReady = false;
  var pending = new Map();     // requestId -> resolve
  var account = { vip: false, clan: null, clanRank: 0, detected: false, profession: null, professionRank: 0, trainerLevel: 0 };
  var vipOverride = null;      // user toggle: null = auto, true/false = forced
  var dataVersion = "";        // bundled data version (from data/meta.json)
  var activeBoosts = {};       // boost key -> until (ms epoch)
  var collapsed = { plan: true, higher: true, capHard: true };  // collapse state per section
  var ownedPokes = [];         // full owned-Pokemon list from the WS (for Capture)
  var ownedSig = "";           // signature of ownedPokes to detect real changes
  var captureTarget = null;    // selected capture target (pokeId) or null

  var norm = function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); };

  // the game auths API calls with a Bearer token kept in web storage (not cookies)
  function accessToken() {
    var keys = ["pokeweb:tokens", "tokens", "auth"];
    var stores = [];
    try { stores.push(window.sessionStorage); } catch (e) {}
    try { stores.push(window.localStorage); } catch (e) {}
    for (var s = 0; s < stores.length; s++) {
      for (var k = 0; k < keys.length; k++) {
        var raw;
        try { raw = stores[s].getItem(keys[k]); } catch (e) { continue; }
        if (!raw) continue;
        try { var t = JSON.parse(raw); var tok = t.accessToken || t.access || (t.tokens && t.tokens.accessToken);
          if (tok) return tok; } catch (e) {}
      }
    }
    return null;
  }
  function authHeaders() {
    var tok = accessToken();
    return tok ? { Authorization: "Bearer " + tok } : {};
  }

  // ---------- data + engine ----------
  // true while our extension context is still valid; goes false after the
  // extension is reloaded/updated while this old content script keeps running
  function contextAlive() { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } }
  function url(p) { return chrome.runtime.getURL(p); }
  async function loadData() {
    var files = ["data/creatures.json", "data/hunts.json", "data/speeds.json", "data/typechart.json", "data/clans.json", "data/items.json", "data/meta.json"];
    var [creatures, hunts, speeds, typechart, clans, items, meta] = await Promise.all(
      files.map(function (f) { return fetch(url(f)).then(function (r) { return r.json(); }).catch(function () { return null; }); })
    );
    dataVersion = (meta && meta.version) || "";
    engine = window.PokeRouteEngine.createEngine({ creatures: creatures, hunts: hunts, speeds: speeds, typechart: typechart, clans: clans, items: items });
  }

  // auto-detect VIP + clan from the player's own character (read-only GET)
  async function loadAccount() {
    try {
      var r = await fetch("/api/characters/me", { credentials: "include", headers: authHeaders() });
      if (!r.ok) { console.warn("[Poke Hunt] /characters/me", r.status); return; }
      var j = await r.json();
      var c = j.character || j;
      // isVip is a boolean; vipUntil is an ISO date string (parse defensively)
      var vipFuture = c.vipUntil != null && Date.parse(c.vipUntil) > Date.now();
      var vip = c.isVip === true || vipFuture;
      var clanRaw = c.clan;
      var clanId = null, clanRank = 0;
      if (clanRaw && typeof clanRaw === "object") { clanId = clanRaw.key || clanRaw.id || clanRaw.name || null; clanRank = clanRaw.rank || 0; }
      else if (typeof clanRaw === "string" && clanRaw) { clanId = clanRaw; }
      if (c.clanRank != null) clanRank = c.clanRank;
      account = {
        vip: vip, clan: clanId, clanRank: clanRank, detected: true,
        profession: c.profession || null,          // "prestige" enables the Trainer Bonus
        professionRank: c.professionRank || 0,      // 0=E … 5=S
        trainerLevel: c.level || 0                  // trainer/account level
      };
    } catch (e) { /* stays default; user can toggle manually */ }
  }

  function cacheBoosts(list) {
    var now = Date.now();
    var next = {};
    (list || []).forEach(function (b) {
      if (!b || !b.key) return;
      var until = typeof b.until === "number" ? b.until : Date.parse(b.until);
      if (until && until > now) next[b.key] = until;
    });
    var changed = Object.keys(next).sort().join(",") !== Object.keys(activeBoosts).sort().join(",");
    activeBoosts = next;
    if (changed && isOpen()) render();   // only when the active-boost set changes
  }
  function boostActive(key) {
    var until = activeBoosts[key];
    return !!until && until > Date.now();
  }

  function activeMods() {
    return {
      vip: vipOverride == null ? account.vip : vipOverride,
      clan: account.clan,
      clanRank: account.clanRank,
      xpBoost: boostActive("pokexp"),     // +50% Pokemon XP
      lootBoost: boostActive("loot"),     // +50% loot value
      profession: account.profession,     // "prestige" -> Trainer Bonus
      professionRank: account.professionRank,
      trainerLevel: account.trainerLevel
    };
  }

  // ---------- WS bridge ----------
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__pokeRoute !== true || d.dir !== "p2c") return;
    if (d.kind === "socket") { socketReady = true; }
    else if (d.kind === "pokes") { cacheWsPokes(d.list); }
    else if (d.kind === "boosts") { cacheBoosts(d.boosts); }
    else if (d.kind === "send-result") {
      var r = pending.get(d.requestId);
      if (r) { pending.delete(d.requestId); r(d); }
    }
  });

  function pickStats(p) {
    // tolerant extraction of {atk,spAtk,def,spDef,hp,speed} from a WS poke
    var src = p && (p.stats || p.st || p);
    if (!src || typeof src !== "object") return null;
    var atk = src.atk, spAtk = src.spAtk != null ? src.spAtk : src.spatk;
    if (atk == null || spAtk == null) return null;
    return {
      hp: +src.hp || 0, atk: +atk, def: +src.def || 0,
      spAtk: +spAtk, spDef: +(src.spDef != null ? src.spDef : src.spdef) || 0,
      speed: +src.speed || 0
    };
  }

  function cacheWsPokes(list) {
    var owned = [];
    list.forEach(function (p) {
      var name = p.name || p.pokemon || "";
      if (!name || p.level == null) return;
      var species = p.pokeId != null ? p.pokeId : p.speciesId;   // WS uses speciesId
      wsPokes.set(norm(name) + "@" + p.level, { pokeId: species, stats: pickStats(p) });
      owned.push({
        id: p.id != null ? p.id : p._id, pokeId: species, name: name, level: p.level,
        stats: pickStats(p), team: !!p.team, leader: !!p.leader
      });
    });
    if (owned.length) {
      var sig = owned.map(function (p) { return p.id + ":" + p.level; }).join(",");
      var changed = sig !== ownedSig;
      ownedSig = sig;
      ownedPokes = owned;
      // refresh the Capture ranking only when the owned list genuinely changed
      if (changed && isOpen() && currentTab === "capture" && captureTarget != null) render();
    }
    maybeRender();            // route tabs: only if the active poke changed
  }

  // one round-trip to the page bridge; resolves with the page's send-result
  function bridge(fields) {
    var id = "br-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    var done = new Promise(function (res) { pending.set(id, res); });
    window.postMessage(Object.assign({ __pokeRoute: true, dir: "c2p", requestId: id }, fields), window.location.origin);
    // guard against a page that never answers
    setTimeout(function () { if (pending.has(id)) { pending.delete(id); } }, 4000);
    return done;
  }

  function waitFor(fn, timeoutMs) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function tick() {
        var v = fn();
        if (v) return resolve(v);
        if (Date.now() - t0 > timeoutMs) return resolve(null);
        setTimeout(tick, 80);
      })();
    });
  }

  // find the game's map marker for a hunt (title is a translated string
  // containing the hunt name, e.g. "Travel to Pidgeot" / "Viajar para Pidgeot")
  function findMarker(name) {
    var nn = norm(name);
    var btns = document.querySelectorAll(".hunt-marker");
    for (var i = 0; i < btns.length; i++) {
      var title = btns[i].getAttribute("title") || "";
      if (norm(title).indexOf(nn) !== -1) return btns[i];
    }
    return null;
  }

  // select a map region tab (kanto/johto/outland/...) so its markers render
  function selectArea(area) {
    if (!area) return false;
    var na = norm(area);
    var btns = document.querySelectorAll(".map-area");
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (norm(b.textContent).indexOf(na) !== -1) {
        if (!b.classList.contains("on") && !b.classList.contains("locked")) b.click();
        return true;
      }
    }
    return false;
  }

  // Drive the game's own travel: open the Map, switch to the hunt's region, then
  // click the marker. Runs the game's real travel (player + enemies + combat + server).
  async function teleport(slug, name, area) {
    var mapBtn = document.querySelector('[data-guide="dock-map"]');
    if (!mapBtn) return { ok: false, error: "map-button-not-found" };
    if (!document.querySelector(".map-area")) mapBtn.click();   // open the map
    await waitFor(function () { return document.querySelector(".map-area"); }, 3500);
    selectArea(area);                                           // switch region (markers re-render)
    var marker = await waitFor(function () { return findMarker(name); }, 3500);
    if (!marker) return { ok: false, error: "marker-not-found" };
    marker.click();
    close();                                                    // hand focus back to the game
    return { ok: true };
  }

  // ---------- DOM: active poke ----------
  function readActivePoke() {
    var el = document.querySelector(".phud-mon.active") || document.querySelector(".phud-mon");
    if (!el) return null;
    var name = (el.querySelector(".phud-name") || {}).textContent || "";
    var lvTxt = (el.querySelector(".phud-lv") || {}).textContent || "";
    var level = parseInt((lvTxt.match(/\d+/) || [])[0], 10);
    var type = (el.querySelector(".pk-ts-type") || {}).getAttribute ?
      el.querySelector(".pk-ts-type").getAttribute("alt") : null;
    if (!name || !level) return null;
    var poke = { name: name.trim(), level: level, type: type };
    var ws = wsPokes.get(norm(poke.name) + "@" + level);
    if (ws) { poke.pokeId = ws.pokeId; poke.stats = ws.stats; poke.live = !!ws.stats; }
    return poke;
  }

  // ---------- UI ----------
  var FALLBACK_CSS =
    ":host{all:initial}*{box-sizing:border-box;font-family:system-ui,sans-serif}" +
    ".pr-backdrop{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center}" +
    ".pr-modal{width:min(600px,95vw);max-height:88vh;overflow:hidden;display:flex;flex-direction:column;background:#000;color:#fff;border:1px solid #2a2140;border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.7)}" +
    ".pr-head{position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;padding:16px 16px 12px;border-bottom:1px solid #7b3ff233}" +
    ".pr-logo{height:46px;width:auto;max-width:82%;object-fit:contain;display:block}.pr-close{position:absolute;top:10px;right:12px;cursor:pointer;background:none;border:none;color:#b9a7e6;font-size:15px}" +
    ".pr-hero{display:flex;align-items:center;gap:12px;margin:12px 12px 4px;padding:10px 12px;border-radius:12px;background:#100c1c;border:1px solid #241d38}.pr-hero:empty{display:none}" +
    ".pr-hero-ico{flex:0 0 auto;width:52px;height:52px;display:flex;align-items:center;justify-content:center;background:#000;border-radius:10px;border:1px solid #241d38}.pr-hero-ico .pr-ico{width:46px;height:46px}" +
    ".pr-hero-body{flex:1;min-width:0}.pr-hero-top{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.pr-hero-name{font-weight:800;font-size:16px;color:#fff}.pr-hero-lv{font-weight:700;font-size:12px;color:#b98cff}" +
    ".pr-hero-types{display:flex;gap:6px;margin-top:5px}.pr-type{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 8px;border-radius:6px;color:#cfc6e6;background:#ffffff0f;border:1px solid #ffffff14}" +
    ".pr-type-normal{color:#d7dbe0;background:#9099a133;border-color:#9099a1aa}.pr-type-fire{color:#ffc39a;background:#ff9d5526;border-color:#ff9d55aa}.pr-type-water{color:#9fc4ef;background:#4d90d526;border-color:#4d90d5aa}.pr-type-electric{color:#f6e28a;background:#f4d23c26;border-color:#f4d23caa}.pr-type-grass{color:#a3e39c;background:#63bc5a26;border-color:#63bc5aaa}.pr-type-ice{color:#b6ece4;background:#73cec026;border-color:#73cec0aa}.pr-type-fighting{color:#ef9aad;background:#ce406926;border-color:#ce4069aa}.pr-type-poison{color:#d8b0ec;background:#ab6ac826;border-color:#ab6ac8aa}.pr-type-ground{color:#f0b48f;background:#d9784526;border-color:#d97845aa}.pr-type-flying{color:#c3d2f2;background:#8fa9de26;border-color:#8fa9deaa}.pr-type-psychic{color:#ffb0b3;background:#f9717626;border-color:#f97176aa}.pr-type-bug{color:#cbe388;background:#90c12c26;border-color:#90c12caa}.pr-type-rock{color:#ded1af;background:#c7b78b26;border-color:#c7b78baa}.pr-type-ghost{color:#a9b7ff;background:#5269ad33;border-color:#5269adcc}.pr-type-dragon{color:#86baef;background:#0b6dc326;border-color:#0b6dc3aa}.pr-type-dark{color:#b6b0c4;background:#59576133;border-color:#595761dd}.pr-type-steel{color:#a7cdda;background:#5a8ea126;border-color:#5a8ea1aa}.pr-type-fairy{color:#f6bdf1;background:#ec8fe626;border-color:#ec8fe6aa}" +
    ".pr-tabs{display:flex;gap:6px;padding:12px 12px 0;border-bottom:1px solid #2a2140}.pr-tab{position:relative;cursor:pointer;flex:1;text-align:center;padding:10px;font-size:13px;font-weight:700;color:#9a90b8;background:none;border:none;transition:color .18s ease}" +
    ".pr-tab::after{content:'';position:absolute;left:12px;right:12px;bottom:-1px;height:2px;background:#a35bff;border-radius:2px;transform:scaleX(0);transition:transform .22s cubic-bezier(.4,0,.2,1)}" +
    ".pr-tab-on{color:#fff}.pr-tab-on::after{transform:scaleX(1)}" +
    ".pr-live{color:#b98cff;font-weight:700}.pr-est{color:#9a90b8;font-weight:700}" +
    ".pr-badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}" +
    ".pr-flag{font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;color:#d7bcff;background:#7b3ff21f;border:1px solid #a35bff77}" +
    ".pr-flag-trainer{color:#ffe08a;background:#f0b71e1c;border-color:#f0b71e88}" +
    ".pr-collapse{cursor:pointer;display:flex;align-items:center;gap:8px;margin-top:4px;padding:9px 11px;border-radius:11px;font-size:12px;font-weight:800;color:#b98cff;border:1px solid #7b3ff233;background:#7b3ff20d}" +
    ".pr-collapse-arrow{font-size:10px;width:10px}.pr-collapse-n{margin-left:auto;font-size:11px;font-weight:700;color:#8a829f;background:#ffffff12;padding:1px 8px;border-radius:999px}" +
    ".pr-below{display:flex;flex-direction:column;gap:9px;margin-top:9px}.pr-below.pr-collapsed{display:none}" +
    ".pr-body{overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:9px;scrollbar-width:thin;scrollbar-color:#7b3ff2 transparent}" +
    ".pr-body::-webkit-scrollbar{width:12px}.pr-body::-webkit-scrollbar-thumb{background:#7b3ff2;border-radius:999px;border:3px solid #000;background-clip:padding-box}" +
    ".pr-empty{padding:30px;text-align:center;color:#9a90b8}" +
    ".pr-section{margin:12px 2px 2px;font-size:11px;font-weight:800;text-transform:uppercase;color:#b98cff}" +
    "@keyframes pr-fade-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}.pr-body > *{animation:pr-fade-in .2s ease both}" +
    ".pr-card{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:14px;background:#0b0b0d;border:1px solid #ffffff14}" +
    ".pr-card.pr-up{opacity:.72}.pr-here{background:#7b3ff21a;border-color:#a35bff}" +
    ".pr-badge{min-width:56px;text-align:center;font-weight:800;font-size:12px;color:#c9adff;white-space:nowrap}.pr-here .pr-badge{color:#d7bcff}.pr-badge.pr-lock{color:#7d7599}" +
    ".pr-ico-wrap{flex:0 0 auto;width:46px;height:46px;display:flex;align-items:center;justify-content:center;background:#000;border-radius:10px;border:1px solid #ffffff12}.pr-ico{width:42px;height:42px;object-fit:contain;display:block}.pr-ico-off{display:none}" +
    ".pr-card-body{flex:1;min-width:0}.pr-card-title{font-weight:800;font-size:14px;color:#fff}.pr-area{color:#7d7599;font-size:11px}.pr-clv{font-size:11px;font-weight:800;color:#b98cff}" +
    ".pr-card-metrics{display:flex;gap:12px;margin-top:3px}.pr-metric-main{font-weight:800;font-size:13px;color:#b98cff}.pr-metric-sub{color:#8a829f;font-size:12px}" +
    ".pr-tp{cursor:pointer;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:7px 12px;border-radius:8px;color:#c3b0e8;background:transparent;border:1px solid #4a3d6b}.pr-tp:hover{color:#fff;background:#7b3ff2;border-color:#7b3ff2}.pr-here .pr-tp{color:#fff;background:#7b3ff2;border-color:#7b3ff2}" +
    ".pr-tp.pr-fail{color:#e88;background:transparent;border-color:#7a3b3b}.pr-foot{display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 16px;font-size:10px;color:#7d7599;border-top:1px solid #ffffff10;text-align:center}" +
    ".pr-foot .pr-heart{color:#a35bff}.pr-foot .pr-link{color:#b98cff;font-weight:400;text-decoration:none}.pr-foot .pr-ver{font-size:9px;font-weight:600;color:#5b556f}.pr-contribute{color:#d7bcff;font-weight:800;cursor:pointer;text-decoration:underline}";

  var host, shadow, currentPoke, currentTab = "xp", lastPokeKey = null;
  function isOpen() { return host && host.style.display !== "none"; }
  function pokeKey(p) { return p ? (norm(p.name) + "@" + p.level) : ""; }
  // re-render only when the active Pokemon actually changed (avoids chat churn)
  function maybeRender() {
    if (!isOpen()) return;
    // the Capture tab never re-renders from DOM mutations (chat, etc.) — it only
    // refreshes when the owned-Pokemon list actually changes (see cacheWsPokes)
    if (currentTab === "capture") return;
    if (pokeKey(readActivePoke()) !== lastPokeKey) render();
  }

  function ensureModal() {
    if (host) return;
    host = document.createElement("div");
    host.id = "poke-route-host";
    host.style.display = "none";
    shadow = host.attachShadow({ mode: "open" });
    var st = document.createElement("style");
    st.textContent = FALLBACK_CSS;          // inline baseline so the modal is usable immediately
    shadow.appendChild(st);
    fetch(url("ui/modal.css")).then(function (r) { return r.text(); }).then(function (css) {
      st.textContent = css;                 // upgrade to full stylesheet when available
    }).catch(function () { /* keep fallback */ });
    var wrap = document.createElement("div");
    wrap.className = "pr-backdrop";
    wrap.innerHTML =
      '<div class="pr-modal" role="dialog" aria-label="Poke Hunt">' +
        '<header class="pr-head">' +
          '<img class="pr-logo" src="' + url("assets/pokehunt-logo.png") + '" alt="Poke Hunt">' +
          '<button class="pr-close" title="Close">✕</button></header>' +
        '<div class="pr-hero"></div>' +
        '<div class="pr-tabs">' +
          '<button class="pr-tab" data-tab="xp">XP farm</button>' +
          '<button class="pr-tab" data-tab="loot">Loot farm</button>' +
          '<button class="pr-tab" data-tab="capture">Capture</button>' +
        '</div>' +
        '<div class="pr-body"></div>' +
        '<footer class="pr-foot">' +
          '<span class="pr-credit">created with <span class="pr-heart">♥︎</span> by ' +
            '<a class="pr-link" href="https://x.com/maldbx0" target="_blank" rel="noopener noreferrer">bx0</a>' +
            ' · <span class="pr-contribute" role="button" tabindex="0">support me</span></span>' +
          '<span class="pr-ver"></span>' +
        '</footer>' +
        '<div class="pr-tip" hidden></div>' +
      '</div>';
    shadow.appendChild(wrap);
    wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });
    shadow.querySelector(".pr-close").addEventListener("click", close);
    shadow.querySelectorAll(".pr-tab").forEach(function (t) {
      t.addEventListener("click", function () { currentTab = t.getAttribute("data-tab"); render(); });
    });
    var contrib = shadow.querySelector(".pr-contribute");
    contrib.addEventListener("click", contribute);
    contrib.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); contribute(); } });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && isOpen()) close(); });
    document.body.appendChild(host);
  }

  // set a React-controlled input's value so the framework registers the change
  function setReactValue(el, value) {
    var desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // open the game's diamond-transfer form with the author's trainer prefilled
  async function contribute() {
    var storeBtn = document.querySelector('[data-guide="dock-store"]');
    if (!storeBtn) return;
    close();                       // hand focus to the game
    storeBtn.click();              // open the diamonds/store modal
    var xfer = await waitFor(function () { return document.querySelector(".ds-transfer-btn"); }, 3500);
    if (xfer) xfer.click();        // open the transfer form
    var input = await waitFor(function () {
      return document.querySelector('.ds-transfer-field input[type="text"], .ds-transfer input[maxlength="20"]');
    }, 3500);
    if (input) { setReactValue(input, "bx0"); input.focus(); }
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmt(n) {
    n = n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(n >= 1e4 ? 0 : 1) + "k";
    return String(Math.round(n));
  }

  // Creature icon: PokeAPI front sprite bundled locally in assets/sprites/.
  // Uses spritePokeId (base National-Dex form) so custom variants like
  // "Freezing Dewgong" fall back to their base sprite (Dewgong). Missing
  // sprites hide themselves via onerror.
  function iconHtml(s) {
    var id = s.spritePokeId || s.pokeId;
    if (id == null) return '<div class="pr-ico"></div>';
    return '<img class="pr-ico" src="' + url("assets/sprites/" + id + ".png") + '" alt="" loading="lazy" draggable="false">';
  }

  // one hunt card. `opts`: {band, current, minLevel}
  function card(s, o) {
    o = o || {};
    var loot = currentTab === "loot";
    var main = loot ? (fmt(s.moneyPerHour) + " $/h") : (fmt(s.xpPerHour) + " XP/h");
    var sub = loot ? (fmt(s.xpPerHour) + " XP/h") : (fmt(s.moneyPerHour) + " $/h");
    var badge = o.band != null
      ? '<span class="pr-badge">' + (o.current ? "▶ " : "") + o.band + '</span>'
      : '<span class="pr-badge pr-lock">Lv.' + o.minLevel + '</span>';
    return '<div class="pr-card' + (o.current ? " pr-here" : "") + (o.band == null ? " pr-up" : "") + '">' +
      badge +
      '<div class="pr-ico-wrap">' + iconHtml(s) + '</div>' +
      '<div class="pr-card-body">' +
        '<div class="pr-card-title">' + esc(s.name) +
          ' <span class="pr-clv">Lv.' + s.creatureLevel + '</span>' +
          (s.area ? ' <span class="pr-area">' + esc(s.area) + '</span>' : '') + '</div>' +
        '<div class="pr-card-metrics"><span class="pr-metric-main">' + main + '</span>' +
          '<span class="pr-metric-sub">' + sub + '</span>' +
          '<span class="pr-metric-sub">' + s.hitsToKill + ' hits</span></div>' +
      '</div>' +
      '<button class="pr-tp" data-slug="' + esc(s.slug) + '" data-name="' + esc(s.name) + '" data-area="' + esc(s.area || "") + '">Teleport</button>' +
    '</div>';
  }


  function render(opts) {
    opts = opts || {};
    ensureModal();
    var hero = shadow.querySelector(".pr-hero");
    var body = shadow.querySelector(".pr-body");

    // version label: extension version + bundled data version
    var extVer = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "";
    shadow.querySelector(".pr-ver").textContent = "v" + extVer + (dataVersion ? " · data " + dataVersion : "");

    // reflect active tab
    shadow.querySelectorAll(".pr-tab").forEach(function (t) {
      t.classList.toggle("pr-tab-on", t.getAttribute("data-tab") === currentTab);
    });

    // Capture tab has its own layout (search + target + owned-Pokemon ranking)
    if (currentTab === "capture") { hero.innerHTML = ""; renderCapture(body); return; }

    var poke = readActivePoke();
    currentPoke = poke;
    if (!poke) { hero.innerHTML = ""; body.innerHTML = '<div class="pr-empty">No active Pokemon found. Open the game with a party selected.</div>'; return; }

    var mods = activeMods();
    mods.metric = currentTab;
    var route = engine.computeRoute(poke, mods);

    // hero card: the currently selected Pokemon
    var p = route.player || {};
    var types = [p.type1, poke.type, p.type2].filter(Boolean);
    var seen = {};
    var typeChips = types.filter(function (t) { var k = t.toUpperCase(); if (seen[k]) return false; seen[k] = 1; return true; })
      .map(function (t) { return '<span class="pr-type pr-type-' + esc(t.toLowerCase()) + '">' + esc(t) + '</span>'; }).join("");
    var flags = [];
    if (mods.vip) flags.push('<span class="pr-flag pr-flag-vip">VIP +50% XP</span>');
    if (currentTab === "xp" && route.xpBoost) flags.push('<span class="pr-flag pr-flag-boost">Boosted XP +50%</span>');
    if (currentTab === "loot" && route.lootBoost) flags.push('<span class="pr-flag pr-flag-boost">Loot boost +50%</span>');
    if (mods.clan && route.clanMult > 1) flags.push('<span class="pr-flag pr-flag-clan">' + esc(mods.clan) +
      ' R' + mods.clanRank + ' +' + Math.round((route.clanMult - 1) * 100) + '%</span>');
    if (currentTab === "xp" && route.trainerBonusPct > 0) flags.push('<span class="pr-flag pr-flag-trainer">Trainer +' +
      route.trainerBonusPct + '% XP</span>');
    hero.innerHTML =
      '<div class="pr-hero-ico">' + iconHtml({ spritePokeId: p.spritePokeId, pokeId: p.pokeId }) + '</div>' +
      '<div class="pr-hero-body">' +
        '<div class="pr-hero-top"><span class="pr-hero-name">' + esc(poke.name) + '</span>' +
          '<span class="pr-hero-lv">Lv.' + poke.level + '</span></div>' +
        '<div class="pr-hero-types">' + typeChips + '</div>' +
        (flags.length ? '<div class="pr-badges">' + flags.join("") + '</div>' : '') +
      '</div>';

    if (route.error) { body.innerHTML = '<div class="pr-empty">Could not match "' + esc(poke.name) + '" to a creature.</div>'; lastPokeKey = pokeKey(poke); return; }

    var bandOf = function (s) { return s.fromLevel + (s.toLevel ? "–" + s.toLevel : "+"); };
    var section = function (label) { return '<div class="pr-section">' + label + '</div>'; };

    var current = route.steps.filter(function (s) { return s.current; });

    var html = "";

    // the best hunt at your current level (metrics at your current level)
    html += section("Best match");
    html += current.length
      ? current.map(function (s) { return card(s, { band: bandOf(s), current: true }); }).join("")
      : '<div class="pr-empty">No suitable hunt at this level.</div>';

    // a click-to-expand section (collapsed state persisted in `collapsed[key]`)
    function collapsible(key, label, cards) {
      if (!cards.length) return "";
      var open = !collapsed[key];
      return '<button class="pr-collapse" type="button" data-key="' + key + '" aria-expanded="' + open + '">' +
        '<span class="pr-collapse-arrow">' + (open ? "▾" : "▸") + '</span> ' + label +
        '<span class="pr-collapse-n">' + cards.length + '</span></button>' +
        '<div class="pr-below' + (open ? "" : " pr-collapsed") + '" data-key="' + key + '">' + cards.join("") + '</div>';
    }

    // leveling plan: best hunt for each band from the current level up to 150+
    // (skips bands already passed; each band shown at its own level)
    var planBands = route.steps.filter(function (s) { return s.current || s.fromLevel > poke.level; });
    html += collapsible("plan", "Leveling plan",
      planBands.map(function (s) { return card(s, { band: bandOf(s), current: s.current }); }));

    // higher-level hunts that unlock above the current level (not on the optimal path)
    html += collapsible("higher", "Higher-level hunts",
      (route.upcoming || []).map(function (s) { return card(s, { minLevel: s.minLevel }); }));

    body.innerHTML = html;

    // wire the collapse toggles (in place, so scroll position is kept)
    body.querySelectorAll(".pr-collapse").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-key");
        collapsed[key] = !collapsed[key];
        var open = !collapsed[key];
        body.querySelector('.pr-below[data-key="' + key + '"]').classList.toggle("pr-collapsed", !open);
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        btn.querySelector(".pr-collapse-arrow").textContent = open ? "▾" : "▸";
      });
    });

    var pokeChanged = pokeKey(poke) !== lastPokeKey;
    lastPokeKey = pokeKey(poke);

    // on open / poke change, bring the "Best match" section into view starting
    // at its header (so the header isn't scrolled off); on a plain re-render
    // (tab switch, boost update) reset to the top
    if (opts.center || pokeChanged) {
      var here = body.querySelector(".pr-here");
      var anchor = here;
      while (anchor && !anchor.classList.contains("pr-section")) anchor = anchor.previousElementSibling;
      if (anchor) {
        // rect-relative: element.offsetTop would be measured against the fixed
        // backdrop (nearest positioned ancestor), not the scroll container
        var delta = anchor.getBoundingClientRect().top - body.getBoundingClientRect().top;
        body.scrollTop = Math.max(0, body.scrollTop + delta - 8);
      } else {
        body.scrollTop = 0;
      }
    } else {
      body.scrollTop = 0;
    }

    // hide sprites PokeAPI doesn't have (custom variants outside the dex)
    body.querySelectorAll("img.pr-ico").forEach(function (img) {
      img.addEventListener("error", function () { img.classList.add("pr-ico-off"); });
    });

    body.querySelectorAll(".pr-tp").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var slug = btn.getAttribute("data-slug");
        var name = btn.getAttribute("data-name");
        var area = btn.getAttribute("data-area");
        btn.disabled = true; btn.textContent = "…";
        teleport(slug, name, area).then(function (res) {
          if (res && res.ok) return;             // modal closed on success
          btn.textContent = "Failed"; btn.classList.add("pr-fail");
          console.warn("[Poke Hunt] teleport", res && res.error);
          setTimeout(function () { btn.disabled = false; btn.textContent = "Teleport"; btn.classList.remove("pr-fail"); }, 1800);
        });
      });
    });
  }

  // ---------- Capture tab ----------
  var typeChip = function (t) { return t ? '<span class="pr-type pr-type-' + esc(t.toLowerCase()) + '">' + esc(t) + '</span>' : ""; };

  // Quality-on-capture odds by tier (game thresholds; bands sum to exactly 100%).
  var QUALITY_TIERS = [
    { name: "Legendary", range: "1.7–1.8", chance: "0.96%", color: "#ff8c3c" },
    { name: "Epic", range: "1.5–1.7", chance: "5%", color: "#f0c040" },
    { name: "Rare", range: "1.3–1.5", chance: "20%", color: "#b06cff" },
    { name: "Uncommon", range: "1.1–1.3", chance: "30%", color: "#7fd4ff" },
    { name: "Common", range: "1.0–1.1", chance: "34.04%", color: "#63d873" },
    { name: "Weak", range: "0.8–1.0", chance: "10%", color: "#9aa6b3" }
  ];
  function qualityTipHtml() {
    var rows = QUALITY_TIERS.map(function (q) {
      return '<tr><td><span class="pr-q-dot" style="background:' + q.color + '"></span>' + q.name + '</td>' +
        '<td class="pr-q-range">' + q.range + '</td><td class="pr-q-pct">' + q.chance + '</td></tr>';
    }).join("");
    return '<div class="pr-tip-title">Quality on capture</div>' +
      '<table class="pr-q-table">' + rows + '</table>' +
      '<div class="pr-tip-note">Same odds for every capture. Perfect (1.800): 0.29%.</div>';
  }

  // shared hover tooltip, positioned near the trigger (lives outside .pr-body so
  // it isn't clipped by the scroll container)
  function showTip(trigger, html) {
    var tip = shadow.querySelector(".pr-tip");
    tip.innerHTML = html; tip.hidden = false;
    var tr = trigger.getBoundingClientRect(), mr = shadow.querySelector(".pr-modal").getBoundingClientRect();
    var top = tr.bottom - mr.top + 6, left = tr.left - mr.left;
    var maxLeft = mr.width - tip.offsetWidth - 10;
    tip.style.top = top + "px";
    tip.style.left = Math.max(10, Math.min(left, maxLeft)) + "px";
  }
  function hideTip() { var tip = shadow && shadow.querySelector(".pr-tip"); if (tip) tip.hidden = true; }
  function wireTip(trigger, html) {
    trigger.addEventListener("mouseenter", function () { showTip(trigger, html); });
    trigger.addEventListener("mouseleave", hideTip);
    trigger.addEventListener("focus", function () { showTip(trigger, html); });
    trigger.addEventListener("blur", hideTip);
  }

  function switchAndGo(instanceId, slug, name, area, btn) {
    // set that Pokemon active (poke-summon uses the instance id), then teleport
    if (instanceId != null) bridge({ cmd: "send", payload: { type: "poke-summon", pokeId: instanceId } });
    return teleport(slug, name, area);
  }

  // a capture-suggestion card, styled like the hunt cards but without the wide
  // level-band badge (icon sits flush-left); the best pick gets a ★ in the title.
  function captureCard(p, best, targetHunt) {
    var effCls = p.eff >= 2 ? "super" : p.eff === 1 ? "neutral" : p.eff > 0 ? "resist" : "none";
    var effTxt = p.eff >= 2 ? "super-effective" : p.eff === 1 ? "neutral" : p.eff > 0 ? "resisted" : "no effect";
    var hitsTxt = p.hits == null ? "can't damage" : p.hits + " hits";
    return '<div class="pr-card' + (best ? " pr-here" : "") + (p.canReach ? "" : " pr-up") + '">' +
      '<div class="pr-ico-wrap">' + iconHtml(p) + '</div>' +
      '<div class="pr-card-body">' +
        '<div class="pr-card-title">' + (best ? '<span class="pr-cap-star">★</span> ' : "") + esc(p.name) +
          ' <span class="pr-clv">Lv.' + p.level + '</span>' +
          (p.canReach ? "" : ' <span class="pr-area pr-cap-under">underleveled</span>') + '</div>' +
        '<div class="pr-card-metrics"><span class="pr-metric-main">' + hitsTxt + '</span>' +
          typeChip(p.moveType) +
          '<span class="pr-eff pr-eff-' + effCls + '">' + effTxt + '</span></div>' +
      '</div>' +
      '<button class="pr-tp" data-id="' + esc(String(p.id)) + '" data-slug="' + esc(targetHunt.slug || "") +
        '" data-name="' + esc(targetHunt.name) + '" data-area="' + esc(targetHunt.area || "") + '">Switch &amp; Go</button>' +
    '</div>';
  }

  function renderCapture(body) {
    // no target chosen yet -> search box + type-to-search tip
    if (captureTarget == null) {
      body.innerHTML =
        '<div class="pr-cap-search">' +
          '<input class="pr-cap-input" type="text" placeholder="Search a Pokémon to capture…" autocomplete="off" spellcheck="false">' +
          '<div class="pr-cap-results"></div>' +
        '</div>';
      var input = body.querySelector(".pr-cap-input");
      var results = body.querySelector(".pr-cap-results");
      // keep keystrokes (WASD movement, etc.) from reaching the game while typing
      ["keydown", "keyup", "keypress"].forEach(function (ev) {
        input.addEventListener(ev, function (e) { e.stopPropagation(); });
      });
      var renderResults = function () {
        var q = input.value.trim();
        if (!q) { results.innerHTML = '<div class="pr-cap-hint">Start typing a Pokémon name to search.</div>'; return; }
        var items = engine.searchTargets(q, 30);
        results.innerHTML = items.map(function (t) {
          return '<button class="pr-cap-opt" data-id="' + t.pokeId + '">' +
            '<span class="pr-cap-opt-ico">' + iconHtml(t) + '</span>' +
            '<span class="pr-cap-opt-name">' + esc(t.name) + '</span>' +
            '<span class="pr-cap-opt-lv">Lv.' + t.huntLevel + '</span>' +
            '<span class="pr-cap-opt-types">' + typeChip(t.type1) + typeChip(t.type2) + '</span>' +
          '</button>';
        }).join("") || '<div class="pr-cap-none">No match</div>';
        results.querySelectorAll(".pr-cap-opt").forEach(function (opt) {
          opt.addEventListener("click", function () { captureTarget = +opt.getAttribute("data-id"); render(); });
        });
      };
      input.addEventListener("input", renderResults);
      renderResults();
      setTimeout(function () { input.focus(); }, 30);
      return;
    }

    // target chosen -> target card + ranked owned Pokemon (same card style as tabs)
    var r = engine.captureRanking(captureTarget, ownedPokes);
    if (!r.target) { captureTarget = null; renderCapture(body); return; }
    var t = r.target;

    var targetCard = '<div class="pr-cap-target">' +
      '<div class="pr-cap-target-ico">' + iconHtml(t) + '</div>' +
      '<div class="pr-cap-target-body">' +
        '<div class="pr-cap-target-top"><span class="pr-cap-target-name">' + esc(t.name) + '</span>' +
          '<span class="pr-hero-lv">Lv.' + t.huntLevel + '</span>' +
          '<span class="pr-info" tabindex="0" role="button" aria-label="Quality odds">Quality ⓘ</span></div>' +
        '<div class="pr-hero-types">' + typeChip(t.type1) + typeChip(t.type2) + '</div>' +
      '</div>' +
      '<button class="pr-cap-change" type="button">Change</button>' +
    '</div>';

    var listHtml;
    if (!ownedPokes.length) {
      listHtml = '<div class="pr-empty">Your Pokémon list hasn\'t loaded yet — open your team once in-game.</div>';
    } else if (!r.list.length) {
      listHtml = '<div class="pr-empty">None of your Pokémon can damage this target.</div>';
    } else {
      // split: good picks (<=10 hits) shown; the rest tucked into a collapsed section
      var easy = r.list.filter(function (p) { return p.hits != null && p.hits <= 10; });
      var hard = r.list.filter(function (p) { return !(p.hits != null && p.hits <= 10); });
      if (!easy.length) { easy = hard.slice(0, 1); hard = hard.slice(1); }  // always show at least the top pick
      listHtml = '<div class="pr-section">Fastest catch</div>' +
        easy.map(function (p, i) { return captureCard(p, i === 0, t); }).join("");
      if (hard.length) {
        var open = !collapsed.capHard;
        listHtml += '<button class="pr-collapse" type="button" data-key="capHard" aria-expanded="' + open + '">' +
          '<span class="pr-collapse-arrow">' + (open ? "▾" : "▸") + '</span> Takes too long (10+ hits)' +
          '<span class="pr-collapse-n">' + hard.length + '</span></button>' +
          '<div class="pr-below' + (open ? "" : " pr-collapsed") + '" data-key="capHard">' +
            hard.map(function (p) { return captureCard(p, false, t); }).join("") + '</div>';
      }
    }

    body.innerHTML = targetCard + listHtml;

    body.querySelector(".pr-cap-change").addEventListener("click", function () { captureTarget = null; render(); });
    var info = body.querySelector(".pr-info");
    if (info) wireTip(info, qualityTipHtml());
    var capCol = body.querySelector('.pr-collapse[data-key="capHard"]');
    if (capCol) capCol.addEventListener("click", function () {
      collapsed.capHard = !collapsed.capHard;
      var open = !collapsed.capHard;
      body.querySelector('.pr-below[data-key="capHard"]').classList.toggle("pr-collapsed", !open);
      capCol.setAttribute("aria-expanded", open ? "true" : "false");
      capCol.querySelector(".pr-collapse-arrow").textContent = open ? "▾" : "▸";
    });
    body.querySelectorAll("img.pr-ico").forEach(function (img) {
      img.addEventListener("error", function () { img.classList.add("pr-ico-off"); });
    });
    body.querySelectorAll(".pr-tp").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id"), slug = btn.getAttribute("data-slug");
        var name = btn.getAttribute("data-name"), area = btn.getAttribute("data-area");
        if (!slug) { btn.textContent = "No hunt"; return; }
        btn.disabled = true; btn.textContent = "…";
        switchAndGo(id, slug, name, area, btn).then(function (res) {
          if (res && res.ok) return;   // modal closed on success
          btn.textContent = "Failed"; btn.classList.add("pr-fail");
          setTimeout(function () { btn.disabled = false; btn.innerHTML = "Switch &amp; Go"; btn.classList.remove("pr-fail"); }, 1800);
        });
      });
    });
  }

  function open() { ensureModal(); host.style.display = "block"; render({ center: true }); }
  function close() { hideTip(); if (host) host.style.display = "none"; }
  function toggle() { isOpen() ? close() : open(); }

  // ---------- dock button ----------
  function injectButton() {
    var dock = document.querySelector('nav.game-dock, [data-guide="dock"]');
    if (!dock || dock.querySelector('[data-guide="dock-poke-route"]')) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dock-btn";
    btn.setAttribute("data-guide", "dock-poke-route");
    btn.title = "Poke Hunt";
    var img = document.createElement("img");
    img.alt = "Poke Hunt";
    img.src = url("assets/gengar.png");
    btn.appendChild(img);
    btn.addEventListener("click", toggle);
    var anchor = dock.querySelector('[data-guide="dock-analyzer"]');
    if (anchor && anchor.nextSibling) dock.insertBefore(btn, anchor.nextSibling);
    else dock.appendChild(btn);
  }

  // ask the game to (re)send current boosts + pokes so we have fresh state
  function requestState() {
    if (!contextAlive()) return;
    bridge({ cmd: "send", payload: { type: "boosts-refresh" } });
    bridge({ cmd: "send", payload: { type: "pokes-get" } });
  }

  // ---------- boot ----------
  Promise.all([loadData(), loadAccount()]).then(function () {
    injectButton();
    setTimeout(requestState, 800);
    setTimeout(requestState, 2500);
    var mo = new MutationObserver(function () {
      // after the extension is reloaded, this stale script's chrome.* APIs die;
      // stop observing so we don't spam "Extension context invalidated"
      if (!contextAlive()) { mo.disconnect(); return; }
      injectButton();
      maybeRender();           // only re-render if the active poke changed
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }).catch(function (e) { console.error("[Poke Hunt] init failed", e); });
})();
