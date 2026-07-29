/*
 * Poke Route engine — pure, dependency-free.
 * Ported from the piwtools calculator bundle (formulas verified against the
 * minified source). Works in Node (tests) and the browser (content script).
 *
 * Model summary:
 *   enemy stat  = round((base + 2*IV) * level/100 * quality^exp)
 *                 IV=18 (wild), quality=1, exp: hp=0.95 else 0.8
 *   enemy HP    = hpStat * 12 * 5           (totalHpMultiplier * huntHpMultiplier)
 *   damage/hit  = power * atkStat * eff * 2 / (60 * (1 + defStat/100))   (OC=60, TC=2)
 *   eff         = reinforce(product of type-chart multipliers)
 *   hits/kill   = enemyHP / bestMoveDamage
 *   kills/hour  = per-creature productivity table (speeds[pokeId][hitN]), interpolated
 *   xp/hour     = kills/hour * creature.experience
 */
(function (root) {
  "use strict";

  // --- constants (from piwtools bundle) ---
  var IV_WILD = 18;
  var QUALITY_ENEMY = 1;
  var QUALITY_PLAYER = 1.8;           // Bt.playerAssumedQuality
  var IV_PLAYER = [21, 18, 21, 18, 21, 18]; // hp,atk,def,spAtk,spDef,speed
  var EXP = [0.95, 0.8, 0.8, 0.8, 0.8, 0.8]; // qualityExponent per stat
  var IV_MULT = 2;
  var HP_TOTAL_MULT = 12;
  var HP_HUNT_MULT = 5;
  var OC = 60, TC = 2;                // damage denominator scale, multiplier
  var FIRST_HIT_MS = 500, ATTACK_INTERVAL_MS = 1600;

  function statAt(base, iv, level, quality, expIdx) {
    return Math.round((base + IV_MULT * iv) * (level / 100) * Math.pow(quality, EXP[expIdx]));
  }

  // enemy stats at its huntLevel (wild IV, quality 1)
  function enemyStats(c) {
    var bases = [c.baseHp, c.baseAtk, c.baseDef, c.baseSpAtk, c.baseSpDef, c.baseSpeed];
    var lvl = Math.max(1, c.huntLevel);
    var s = bases.map(function (b, i) { return statAt(b, IV_WILD, lvl, QUALITY_ENEMY, i); });
    return { hp: s[0], atk: s[1], def: s[2], spAtk: s[3], spDef: s[4], speed: s[5] };
  }

  function enemyTotalHp(c) {
    var hpStat = Math.max(1, enemyStats(c).hp);
    return Math.max(1, hpStat * HP_TOTAL_MULT * HP_HUNT_MULT);
  }

  // player offensive stats. Prefer live WS stats; otherwise derive from level.
  function playerStats(poke, playerCreature) {
    if (poke.stats && poke.stats.atk && poke.stats.spAtk) return poke.stats;
    var c = playerCreature;
    var bases = [c.baseHp, c.baseAtk, c.baseDef, c.baseSpAtk, c.baseSpDef, c.baseSpeed];
    var lvl = Math.max(1, poke.level);
    var s = bases.map(function (b, i) { return statAt(b, IV_PLAYER[i], lvl, QUALITY_PLAYER, i); });
    return { hp: s[0], atk: s[1], def: s[2], spAtk: s[3], spDef: s[4], speed: s[5] };
  }

  // clan combat multiplier: 1 + combatBonus[rank] when the poke's type is in the clan
  function clanMultiplier(clans, clanId, rank, playerCreature) {
    if (!clanId || clanId === "none" || !clans) return 1;
    var clan = clans.find(function (c) { return c.id === clanId || (c.name && c.name.toLowerCase() === String(clanId).toLowerCase()); });
    if (!clan || !clan.types || !clan.types.length) return 1;
    var ptypes = [playerCreature.type1, playerCreature.type2].filter(Boolean).map(function (t) { return String(t).toUpperCase(); });
    var applies = clan.types.some(function (t) { return ptypes.indexOf(String(t).toUpperCase()) !== -1; });
    if (!applies) return 1;
    var bonus = clan.combatBonus ? clan.combatBonus[String(Math.max(0, rank || 0))] : 0;
    return 1 + (bonus || 0);
  }

  // reinforced effectiveness (IC in bundle): amplifies advantage, softens resistance
  function reinforce(x) {
    if (x === 0 || x === 1) return x;
    return x > 1 ? x + (x - 1) * 0.5 : x / 1.5;
  }

  function effectiveness(typechart, moveType, defTypes) {
    if (!moveType) return 1;
    var row = typechart[String(moveType).toUpperCase()] || {};
    var mult = defTypes.reduce(function (acc, t) {
      if (!t) return acc;
      var m = row[String(t).toUpperCase()];
      return acc * (m === undefined ? 1 : m);
    }, 1);
    return reinforce(mult);
  }

  function isSpecial(move) {
    return String(move.category || "").trim().toUpperCase() === "SPECIAL";
  }

  // best (highest-damage) usable move of the player's species vs this enemy.
  // clanMult scales offensive stats when the poke's clan matches its type.
  function bestMoveDamage(playerCreature, pStats, enemy, eStats, playerLevel, typechart, clanMult) {
    var defTypes = [enemy.type1, enemy.type2];
    var cm = clanMult || 1;
    var best = 0;
    var attacks = playerCreature.attacks || [];
    for (var i = 0; i < attacks.length; i++) {
      var mv = attacks[i];
      if (!mv || !mv.power) continue;
      if (mv.learnLevel && mv.learnLevel > playerLevel) continue;
      var sp = isSpecial(mv);
      var atk = Math.max(1, Math.round((sp ? pStats.spAtk : pStats.atk) * cm));
      var def = Math.max(1, sp ? eStats.spDef : eStats.def);
      var eff = effectiveness(typechart, mv.type, defTypes);
      var dmg = Math.max(0, mv.power * atk * eff * TC / (OC * (1 + def / 100)));
      if (dmg > best) best = dmg;
    }
    return best;
  }

  // kills/hour from productivity table, interpolated by fractional hit count
  function killsPerHour(speeds, pokeId, hits) {
    var tbl = speeds[String(pokeId)];
    var h = Math.max(1, hits);
    if (!tbl) {
      // fallback: pure combat cadence when no productivity data exists
      var ms = FIRST_HIT_MS + Math.max(0, Math.ceil(h) - 1) * ATTACK_INTERVAL_MS;
      return 3600 / (ms / 1000);
    }
    // Beyond the measured table (max 8 hits), throughput falls FASTER than linear:
    // slow, tanky kills add fixed overhead (healing, retargeting) the table never saw.
    // A quadratic falloff matches measured reality (e.g. Hitmontop ~13 hits -> ~103 kph,
    // vs the old linear estimate of ~174). Continuous at h=8 (factor 1).
    if (h >= 8) return tbl.hit8 * Math.pow(8 / h, 2);
    var lo = Math.floor(h), hi = Math.ceil(h);
    var vlo = tbl["hit" + lo], vhi = tbl["hit" + hi];
    if (vlo === undefined) return tbl.hit8;
    if (lo === hi || vhi === undefined) return vlo;
    return vlo + (vhi - vlo) * (h - lo);
  }

  // expected gold value of one kill's loot (PIW: chance/1e5 * avgCount * npcPrice)
  function expectedLootValue(c, itemPrices) {
    return (c.loot || []).reduce(function (a, l) {
      var price = itemPrices[String(l.name || "").trim().toLowerCase()] || 0;
      var avg = ((l.minCount || 1) + (l.maxCount || 1)) / 2;
      return a + (l.chance || 0) / 100000 * avg * price;
    }, 0);
  }

  function normSlug(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  var HUNT_ALIAS = { nidoranfe: "nidoranfemale", nidoranma: "nidoranmale" };

  // Build hunt candidates: hunt.slug -> creature (offline slug match).
  // `speeds` is required so we can exclude creatures with no productivity data
  // (matching piwtools, which skips hunts without a map/kills-per-hour entry —
  // otherwise the combat-cadence fallback wildly overrates a one-shot low-level
  // hunt, e.g. Farfetch'D showing 16M XP/h for a Lv.350+ Pokemon).
  function buildHunts(hunts, creatures, speeds) {
    var byName = new Map();
    creatures.forEach(function (c) { byName.set(normSlug(c.name), c); });
    var out = [];
    hunts.forEach(function (h) {
      if (!h.slug) return;
      var key = normSlug(h.slug);
      var c = byName.get(key) || byName.get(HUNT_ALIAS[key] || "");
      if (!c) return;                              // towns / unmatched: skip
      if (!(c.attacks && c.attacks.length) || !(c.huntLevel > 0)) return; // not huntable
      if (speeds && !speeds[String(c.pokeId)]) return; // no productivity data -> skip
      out.push({ slug: h.slug, name: h.name || c.name, area: h.area, minLevel: h.level || c.huntLevel, creature: c });
    });
    return out;
  }

  var VIP_BONUS = 0.5;     // "VIP XP +50%"
  var BOOST_BONUS = 0.5;   // pokexp / loot boosts are each +50%

  // Prestige "Trainer Bonus" (Mentoria): when the trainer is >200 levels above the
  // battling Pokemon, +0.5% XP per level beyond the gap, capped by profession rank
  // (E=20% … A=100%, S keeps A's cap). Returned as a fraction (0..1).
  function trainerBonusFraction(mods, pokeLevel) {
    if (!mods || mods.profession !== "prestige") return 0;
    var beyond = Math.max(0, (mods.trainerLevel || 0) - pokeLevel - 200);
    if (beyond <= 0) return 0;
    var rank = Math.max(0, Math.min(5, mods.professionRank || 0)); // 0=E … 5=S
    var capPct = Math.min(100, (rank + 1) * 20);
    return Math.min(capPct, 0.5 * beyond) / 100;
  }

  // metrics for one hunt given the player's level/stats and account modifiers
  // incoming survivability: the enemy's best move vs the player's defenses (roles
  // swapped, wild enemy has no clan). Player total HP = hp stat * HP_TOTAL_MULT
  // (matches the game; enemies also get HP_HUNT_MULT). survivable = you outlast the
  // time it takes to kill one enemy. Split out so the hot path can defer it.
  function survivability(hunt, playerCreature, pStats, hits, typechart) {
    var c = hunt.creature;
    var eStats = hunt._eStats || enemyStats(c);
    var eDmg = bestMoveDamage(c, eStats, { type1: playerCreature.type1, type2: playerCreature.type2 },
                              pStats, c.huntLevel, typechart, 1);
    var playerHp = Math.max(1, pStats.hp * HP_TOTAL_MULT);
    var survivesHits = eDmg > 0 ? playerHp / eDmg : Infinity;
    return { survivesHits: survivesHits, survivable: survivesHits >= hits };
  }

  function huntMetrics(hunt, poke, playerCreature, data, mods, pStatsIn, skipSurvive) {
    mods = mods || {};
    var c = hunt.creature;
    var eStats = hunt._eStats || enemyStats(c);          // cached per creature
    var eTotalHp = hunt._eTotalHp || enemyTotalHp(c);
    var pStats = pStatsIn || playerStats(poke, playerCreature); // identical for all hunts at a level
    var dmg = bestMoveDamage(playerCreature, pStats, c, eStats, poke.level, data.typechart, mods.clanMult);
    if (dmg <= 0) return { xpPerHour: 0, moneyPerHour: 0, kph: 0, hits: Infinity, dmg: 0, survivesHits: 0, survivable: false, pStats: pStats };
    var hits = Math.max(1, eTotalHp / dmg);
    // survivability is the second-most expensive step; skip it on the hot bestAt scan
    // (computed there only for the running leader) but keep it for direct callers.
    var sv = skipSurvive ? { survivesHits: Infinity, survivable: true } : survivability(hunt, playerCreature, pStats, hits, data.typechart);
    var survivesHits = sv.survivesHits;
    var survivable = sv.survivable;
    var kph = killsPerHour(data.speeds, c.pokeId, hits);
    // XP bonuses stack ADDITIVELY (dev note: "soma… em vez de multiplicar por cima")
    var xpMult = 1 + (mods.vip ? VIP_BONUS : 0) + (mods.xpBoost ? BOOST_BONUS : 0) +
      trainerBonusFraction(mods, poke.level);
    var moneyMult = 1 + (mods.lootBoost ? BOOST_BONUS : 0);
    return {
      xpPerHour: kph * (c.experience || 0) * xpMult,
      moneyPerHour: kph * expectedLootValue(c, data.itemPrices || {}) * moneyMult,
      kph: kph,
      hits: hits,
      dmg: dmg,
      survivesHits: survivesHits,
      survivable: survivable,
      pStats: pStats
    };
  }

  function createEngine(data) {
    var creatures = data.creatures.creatures || data.creatures;
    var clans = data.clans || null;
    // item name (lowercased) -> npc sell price, for loot value
    data.itemPrices = {};
    var itemList = data.items && (data.items.items || data.items) || [];
    itemList.forEach(function (it) { if (it && it.name) data.itemPrices[String(it.name).trim().toLowerCase()] = it.npcPrice || 0; });
    var huntList = buildHunts(data.hunts, creatures, data.speeds);
    var huntBySlug = new Map();
    var huntByPokeId = new Map();          // pokeId -> easiest (lowest-level) hunt, for the Pokedex tab
    // enemy stats/HP depend only on the creature (not the player), so compute them
    // once here instead of on every huntMetrics call across the level simulation.
    huntList.forEach(function (h) {
      h._eStats = enemyStats(h.creature);
      h._eTotalHp = enemyTotalHp(h.creature);
      huntBySlug.set(h.slug, h);
      var pid = h.creature.pokeId;
      var ex = huntByPokeId.get(pid);
      if (!ex || h.minLevel < ex.minLevel) huntByPokeId.set(pid, h);
    });
    var pdexCache = { key: null, val: null };  // memoized pokedexPlan (see route cache)
    var byName = new Map();
    var byId = new Map();
    creatures.forEach(function (c) { byName.set(normSlug(c.name), c); byId.set(c.pokeId, c); });

    // looktype -> base National-Dex pokeId (custom variants like "Freezing Dewgong"
    // reuse their base form's looktype, so this maps them to the base sprite).
    var looktypeToBase = {};
    creatures.forEach(function (c) {
      if (c.pokeId <= 1025 && c.looktype != null) {
        if (looktypeToBase[c.looktype] == null || c.pokeId < looktypeToBase[c.looktype]) looktypeToBase[c.looktype] = c.pokeId;
      }
    });

    function resolvePlayerCreature(poke) {
      if (poke.pokeId && byId.has(poke.pokeId)) return byId.get(poke.pokeId);
      return byName.get(normSlug(poke.name)) || null;
    }

    // memoized routes: computeRoute is the hot path (full level simulation), and a
    // tab switch or re-render calls it again with identical inputs. Key on everything
    // that changes the result (poke identity/level/live stats + metric + account mods),
    // so switching tabs or toggling boosts recomputes only when something real changed.
    var routeCache = new Map();
    var ROUTE_CACHE_MAX = 24;
    function routeKey(poke, opts) {
      var s = poke.stats;
      var statsSig = (s && s.atk) ? [s.hp, s.atk, s.def, s.spAtk, s.spDef, s.speed].join(".") : "-";
      return [opts.metric || "xp", normSlug(poke.name), poke.pokeId || "", poke.level, statsSig,
        opts.fromLevel == null ? "" : opts.fromLevel,
        opts.vip ? 1 : 0, opts.xpBoost ? 1 : 0, opts.lootBoost ? 1 : 0,
        opts.clan || "", opts.clanRank || 0,
        opts.profession || "", opts.professionRank || 0, opts.trainerLevel || 0].join("|");
    }

    // resolve account modifiers (vip, clan, boosts, prestige trainer bonus) for a poke
    function resolveMods(opts, playerCreature) {
      return {
        vip: !!opts.vip,
        xpBoost: !!opts.xpBoost,
        lootBoost: !!opts.lootBoost,
        clanMult: clanMultiplier(clans, opts.clan, opts.clanRank, playerCreature),
        profession: opts.profession || null,
        professionRank: opts.professionRank || 0,
        trainerLevel: opts.trainerLevel || 0
      };
    }

    // How close (in XP/h or $/h) another hunt must be to the leader to be considered a
    // rival, and how much faster it must kill to be picked over the leader. The kph model
    // over-credits tanky, high-hit targets (e.g. "17 hits/kill @ 128 kph") that in practice
    // grind painfully slowly; when a rival is within HITS_BAND on the metric but needs far
    // fewer hits, it's the better real pick. The FASTER gate means we only trade metric for
    // a MEANINGFUL speed gain, so ordinary hunts (small hit differences) are untouched.
    var HITS_BAND = 0.12;    // rival must be within 12% of the leader's metric
    var HITS_FASTER = 0.6;   // ...and need <= 60% of the leader's hits (>= 40% fewer) to win

    // best hunt for a poke at a specific level (respecting unlock level), by metric
    function bestAt(poke, playerCreature, mods, metricKey) {
      var pStats = playerStats(poke, playerCreature);      // same for every hunt at this level
      var cands = [];
      for (var i = 0; i < huntList.length; i++) {
        var hunt = huntList[i];
        if (hunt.minLevel > poke.level) continue;          // not unlocked yet
        var m = huntMetrics(hunt, poke, playerCreature, data, mods, pStats, true); // defer survivability
        if (m[metricKey] <= 0) continue;
        cands.push({ hunt: hunt, m: m });
      }
      cands.sort(function (a, b) { return b.m[metricKey] - a.m[metricKey]; });
      // walk from the top; the first survivable hunt is the leader (the old behavior),
      // then look only within its band for a hunt that kills meaningfully faster.
      var leader = null, fastest = null;
      for (var j = 0; j < cands.length; j++) {
        var c = cands[j];
        if (leader && c.m[metricKey] < leader.m[metricKey] * (1 - HITS_BAND)) break;   // past the band
        var sv = survivability(c.hunt, playerCreature, pStats, c.m.hits, data.typechart);
        if (!sv.survivable) continue;                      // skip hunts you'd faint in
        c.m.survivesHits = sv.survivesHits; c.m.survivable = true;
        if (!leader) leader = c;                            // top survivable = default pick
        if (!fastest || c.m.hits < fastest.m.hits) fastest = c;
      }
      if (!leader) return null;
      var pick = (fastest && fastest.m.hits <= leader.m.hits * HITS_FASTER) ? fastest : leader;
      return { hunt: pick.hunt, metrics: pick.m };
    }

    function step(hunt, m) {
      var c = hunt.creature;
      return {
        slug: hunt.slug, name: hunt.name, area: hunt.area,
        pokeId: c.pokeId, looktype: c.looktype, creatureLevel: c.huntLevel,
        spritePokeId: (c.looktype != null && looktypeToBase[c.looktype]) || c.pokeId,
        xpPerHour: Math.round(m.xpPerHour),
        moneyPerHour: Math.round(m.moneyPerHour),
        killsPerHour: Math.round(m.kph),
        hitsToKill: +m.hits.toFixed(2),
        survivesHits: m.survivesHits === Infinity ? null : +m.survivesHits.toFixed(2),
        survivable: m.survivable
      };
    }

    // full leveling route: bands from current level upward.
    // opts.metric: "xp" (default) or "loot" — which metric to optimize/band by.
    function computeRoute(poke, opts) {
      opts = opts || {};
      var cacheKey = routeKey(poke, opts);
      if (routeCache.has(cacheKey)) return routeCache.get(cacheKey);
      var playerCreature = resolvePlayerCreature(poke);
      if (!playerCreature) return { error: "unknown-species", steps: [] };
      var mods = resolveMods(opts, playerCreature);
      var metricKey = opts.metric === "loot" ? "moneyPerHour" : "xpPerHour";

      var maxHuntLevel = huntList.reduce(function (m, h) { return Math.max(m, h.minLevel); }, 1);
      var cap = Math.max(poke.level, maxHuntLevel) + 1;
      var floor = opts.fromLevel != null ? Math.max(1, opts.fromLevel) : 1;
      var steps = [];
      var cur = null;
      for (var lvl = floor; lvl <= cap; lvl++) {
        var probe = { name: poke.name, level: lvl, pokeId: poke.pokeId, stats: lvl === poke.level ? poke.stats : null };
        var b = bestAt(probe, playerCreature, mods, metricKey);
        if (!b) continue;
        if (cur && cur.slug === b.hunt.slug) {
          cur.toLevel = lvl;                                // extend current band
        } else {
          if (cur) steps.push(cur);
          cur = step(b.hunt, b.metrics);
          cur.fromLevel = lvl; cur.toLevel = lvl;
        }
      }
      if (cur) steps.push(cur);
      // open-ended last band above the data range
      if (steps.length) steps[steps.length - 1].toLevel = null;

      // Each plan band keeps its own band-level metrics (a projection of "at these
      // levels, hunt X gives Y"). The CURRENT band is recomputed at the poke's actual
      // level with live stats, so "Best match" reflects your real current throughput.
      var curProbe = { name: poke.name, level: poke.level, pokeId: poke.pokeId, stats: poke.stats };
      steps.forEach(function (s) {
        s.current = poke.level >= s.fromLevel && (s.toLevel == null || poke.level <= s.toLevel);
        if (s.current) {
          var hunt = huntBySlug.get(s.slug);
          if (hunt) {
            var m = huntMetrics(hunt, curProbe, playerCreature, data, mods);
            s.xpPerHour = Math.round(m.xpPerHour);
            s.moneyPerHour = Math.round(m.moneyPerHour);
            s.killsPerHour = Math.round(m.kph);
            s.hitsToKill = +m.hits.toFixed(2);
          }
        }
      });

      // higher-level hunts that unlock above the current level (shown at their unlock level)
      var seen = {};
      steps.forEach(function (s) { seen[s.slug] = true; });
      var upcoming = huntList
        .filter(function (h) { return h.minLevel > poke.level && !seen[h.slug]; })
        .map(function (h) {
          var probe = { name: poke.name, level: h.minLevel, pokeId: poke.pokeId };
          var m = huntMetrics(h, probe, playerCreature, data, mods);
          var st = step(h, m); st.minLevel = h.minLevel; return st;
        })
        .filter(function (r) { return r[metricKey] > 0 && r.survivable; })
        .sort(function (a, b) { return a.minLevel - b.minLevel || b[metricKey] - a[metricKey]; });

      var result = { species: playerCreature.name, level: poke.level, metric: opts.metric === "loot" ? "loot" : "xp",
               player: { pokeId: playerCreature.pokeId, looktype: playerCreature.looktype,
                         spritePokeId: (playerCreature.looktype != null && looktypeToBase[playerCreature.looktype]) || playerCreature.pokeId,
                         type1: playerCreature.type1, type2: playerCreature.type2, rarity: playerCreature.rarity,
                         // the exact stats the estimate uses; hpTotal is the real HP number (stat x12).
                         stats: (function () { var s = playerStats(poke, playerCreature); return { hpTotal: s.hp * HP_TOTAL_MULT, atk: s.atk, def: s.def, spAtk: s.spAtk, spDef: s.spDef, speed: s.speed }; })(),
                         liveStats: !!(poke.stats && poke.stats.atk && poke.stats.spAtk) },
               vip: mods.vip, xpBoost: mods.xpBoost, lootBoost: mods.lootBoost,
               clanMult: mods.clanMult,
               trainerBonusPct: Math.round(trainerBonusFraction(mods, poke.level) * 100),
               steps: steps, upcoming: upcoming };
      routeCache.set(cacheKey, result);
      if (routeCache.size > ROUTE_CACHE_MAX) routeCache.delete(routeCache.keys().next().value); // evict oldest
      return result;
    }

    // flat ranking of all currently-available hunts (for "best now"), by metric
    function rankNow(poke, opts) {
      opts = opts || {};
      var playerCreature = resolvePlayerCreature(poke);
      if (!playerCreature) return [];
      var mods = resolveMods(opts, playerCreature);
      var metricKey = opts.metric === "loot" ? "moneyPerHour" : "xpPerHour";
      return huntList
        .filter(function (h) { return h.minLevel <= poke.level; })
        .map(function (h) {
          var m = huntMetrics(h, poke, playerCreature, data, mods);
          var st = step(h, m); st.minLevel = h.minLevel; return st;
        })
        .filter(function (r) { return r[metricKey] > 0 && r.survivable; })
        .sort(function (a, b) { return b[metricKey] - a[metricKey]; });
    }

    // ---------- Capture tab ----------
    // creatures you can go catch in the wild = those with a hunt (indexed by pokeId)
    var huntByCreatureId = new Map();
    huntList.forEach(function (h) { if (!huntByCreatureId.has(h.creature.pokeId)) huntByCreatureId.set(h.creature.pokeId, h); });

    function spriteIdOf(c) { return (c.looktype != null && looktypeToBase[c.looktype]) || c.pokeId; }

    // autocomplete over catchable targets; matches name substring, ranked by
    // best prefix match then hunt level. Returns lightweight display records.
    function searchTargets(query, limit) {
      var q = normSlug(query);
      var out = [];
      huntList.forEach(function (h) {
        var c = h.creature;
        var n = normSlug(c.name);
        var idx = q ? n.indexOf(q) : 0;
        if (q && idx < 0) return;
        out.push({ pokeId: c.pokeId, spritePokeId: spriteIdOf(c), name: c.name,
                   huntLevel: c.huntLevel, type1: c.type1, type2: c.type2,
                   slug: h.slug, area: h.area, minLevel: h.minLevel, _rank: q ? idx : 0 });
      });
      out.sort(function (a, b) { return a._rank - b._rank || a.huntLevel - b.huntLevel || a.name.localeCompare(b.name); });
      return out.slice(0, limit || 8);
    }

    // best (highest) type effectiveness of an owned creature's usable moves vs a target
    function bestEff(ownedCreature, ownedLevel, target) {
      var defTypes = [target.type1, target.type2];
      var best = 0, moveType = null;
      (ownedCreature.attacks || []).forEach(function (mv) {
        if (!mv || !mv.power) return;
        if (mv.learnLevel && mv.learnLevel > ownedLevel) return;
        var eff = effectiveness(data.typechart, mv.type, defTypes);
        if (eff > best) { best = eff; moveType = mv.type; }
      });
      return { eff: best, moveType: moveType };
    }

    // Rank the player's owned Pokemon by how easily they weaken a capture target.
    // Fewer hits-to-kill = fastest to bring HP down = easiest (this already folds in
    // type advantage + the owned Pokemon's level/stats). ownedPokes: [{id,pokeId,name,level,stats?}].
    function captureRanking(targetPokeId, ownedPokes, opts) {
      opts = opts || {};
      var target = byId.get(targetPokeId) || byName.get(normSlug(targetPokeId));
      if (!target) return { error: "unknown-target", target: null, list: [] };
      var eStats = enemyStats(target);
      var targetHp = enemyTotalHp(target);
      var hunt = huntByCreatureId.get(target.pokeId) || null;

      var list = (ownedPokes || []).map(function (op) {
        var oc = (op.pokeId != null && byId.get(op.pokeId)) || byName.get(normSlug(op.name));
        if (!oc) return null;
        var lvl = op.level || 1;
        var pStats = playerStats({ level: lvl, stats: op.stats }, oc);
        var dmg = bestMoveDamage(oc, pStats, target, eStats, lvl, data.typechart, 1);
        var be = bestEff(oc, lvl, target);
        var hits = dmg > 0 ? Math.max(1, targetHp / dmg) : Infinity;
        return {
          id: op.id, pokeId: oc.pokeId, spritePokeId: spriteIdOf(oc),
          name: op.name || oc.name, level: lvl,
          type1: oc.type1, type2: oc.type2,
          eff: +be.eff.toFixed(2), moveType: be.moveType,
          hits: isFinite(hits) ? +hits.toFixed(2) : null,
          canReach: hunt ? lvl >= hunt.minLevel : true
        };
      }).filter(Boolean);

      // easiest first: can-reach and effective (fewest hits) win; infeasible last
      list.sort(function (a, b) {
        if (a.hits == null && b.hits == null) return b.level - a.level;
        if (a.hits == null) return 1;
        if (b.hits == null) return -1;
        return a.hits - b.hits || b.eff - a.eff || b.level - a.level;
      });

      return {
        target: { pokeId: target.pokeId, spritePokeId: spriteIdOf(target), name: target.name,
                  huntLevel: target.huntLevel, type1: target.type1, type2: target.type2,
                  rarity: target.rarity, slug: hunt && hunt.slug, area: hunt && hunt.area,
                  minLevel: hunt && hunt.minLevel },
        list: list
      };
    }

    // display info for a hunt by slug (for saved/recent Places)
    function lookupHunt(slug) {
      var h = huntBySlug.get(slug);
      if (!h) return null;
      var c = h.creature;
      return { slug: h.slug, name: h.name, area: h.area, minLevel: h.minLevel,
               huntLevel: c.huntLevel, spritePokeId: spriteIdOf(c), type1: c.type1, type2: c.type2 };
    }

    // Pokedex to-do list, built from EVERY huntable creature (one that has a hunt to
    // teleport to), merged with the player's per-species status from /api/game/pokedex.
    // The API only returns species the player has already touched; every other huntable
    // creature counts as 0 kills / uncaught. Non-huntable creatures (obtained by evolving,
    // fishing, or events) are excluded — there is nowhere to teleport them. Species that
    // are fully complete (caught && kills>=unlockKills) are hidden. Sorted easiest first
    // (hunt level asc, then name). Memoized on the status signature so tab switches are instant.
    function pdexItem(h, kills, caught, unlockKills) {
      var c = h.creature;
      return { pokeId: c.pokeId, name: h.name || c.name, huntLevel: c.huntLevel,
               slug: h.slug, area: h.area, spritePokeId: spriteIdOf(c),
               kills: kills, caught: !!caught, unlockKills: unlockKills };
    }
    function pokedexPlan(dex) {
      dex = dex || {};
      var unlockKills = dex.unlockKills || 100;
      var species = dex.species || [];
      var sig = unlockKills + ";" + species.map(function (s) { return s.id + ":" + s.kills + ":" + (s.caught ? 1 : 0); }).join(",");
      if (pdexCache.key === sig) return pdexCache.val;
      var status = {};   // pokeId -> { kills, caught }, from the API (touched species only)
      species.forEach(function (s) { status[s.id] = { kills: s.kills || 0, caught: !!s.caught }; });
      var todo = [];
      huntByPokeId.forEach(function (h, pid) {
        var st = status[pid] || { kills: 0, caught: false };
        if (st.caught && st.kills >= unlockKills) return;   // fully complete -> hide
        todo.push(pdexItem(h, st.kills, st.caught, unlockKills));
      });
      var byLevel = function (a, b) { return a.huntLevel - b.huntLevel || a.name.localeCompare(b.name); };
      todo.sort(byLevel);
      var val = { todo: todo, total: huntByPokeId.size, unlockKills: unlockKills };
      pdexCache = { key: sig, val: val };
      return val;
    }

    return { computeRoute: computeRoute, rankNow: rankNow, huntCount: huntList.length,
             searchTargets: searchTargets, captureRanking: captureRanking, lookupHunt: lookupHunt,
             pokedexPlan: pokedexPlan,
             _internal: { statAt: statAt, enemyStats: enemyStats, enemyTotalHp: enemyTotalHp,
                          effectiveness: effectiveness, killsPerHour: killsPerHour, buildHunts: buildHunts } };
  }

  var api = { createEngine: createEngine };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PokeRouteEngine = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
