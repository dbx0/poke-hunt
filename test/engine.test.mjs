import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createEngine } = require(join(root, "engine.js"));

const load = (f) => JSON.parse(readFileSync(join(root, "data", f), "utf8"));
const data = {
  creatures: load("creatures.json"),
  hunts: load("hunts.json"),
  speeds: load("speeds.json"),
  typechart: load("typechart.json"),
  clans: load("clans.json"),
  items: load("items.json"),
};

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("FAIL  " + name + "\n      " + e.message); fail++; }
}

const engine = createEngine(data);
const creatures = data.creatures.creatures;
const byName = (n) => creatures.find((c) => c.name.toLowerCase() === n.toLowerCase());

test("engine builds a large hunt list from slug matches", () => {
  assert.ok(engine.huntCount >= 230, "huntCount=" + engine.huntCount);
});

test("stat formula matches piwtools: enemy stat = round((base+2*18)*lvl/100*1)", () => {
  const bulba = byName("Bulbasaur"); // huntLevel 20
  const es = engine._internal.enemyStats(bulba);
  const expHp = Math.round((bulba.baseHp + 36) * (20 / 100) * Math.pow(1, 0.95));
  assert.strictEqual(es.hp, expHp);
});

test("enemy total HP = hpStat * 60", () => {
  const bulba = byName("Bulbasaur");
  const hp = engine._internal.enemyTotalHp(bulba);
  assert.strictEqual(hp, engine._internal.enemyStats(bulba).hp * 60);
});

test("type effectiveness is reinforced (WATER->FIRE stronger than 2x)", () => {
  const eff = engine._internal.effectiveness(data.typechart, "WATER", ["FIRE"]);
  assert.ok(eff > 2, "expected >2, got " + eff); // reinforce(2)=2.5
  const immune = engine._internal.effectiveness(data.typechart, "NORMAL", ["GHOST"]);
  assert.strictEqual(immune, 0);
});

test("killsPerHour interpolates the productivity table", () => {
  const tbl = data.speeds["1"];
  const at2 = engine._internal.killsPerHour(data.speeds, 1, 2);
  assert.strictEqual(at2, tbl.hit2);
  const at2_5 = engine._internal.killsPerHour(data.speeds, 1, 2.5);
  assert.ok(at2_5 < tbl.hit2 && at2_5 > tbl.hit3, "interp between hit2/hit3");
});

test("Haunter Lv.88 produces a leveling route with ascending bands", () => {
  const route = engine.computeRoute({ name: "Haunter", level: 88 });
  assert.ok(!route.error, "error: " + route.error);
  assert.ok(route.steps.length >= 1, "no steps");
  // bands are contiguous and non-overlapping
  for (let i = 1; i < route.steps.length; i++) {
    assert.ok(route.steps[i].fromLevel > route.steps[i - 1].fromLevel, "bands must ascend");
  }
  // last band is open-ended
  assert.strictEqual(route.steps[route.steps.length - 1].toLevel, null);
  console.log("      Haunter route:", route.steps.map(s =>
    `${s.fromLevel}-${s.toLevel ?? "+"}:${s.name}(${s.xpPerHour}xp/h)`).join("  "));
});

test("rankNow returns hunts ordered by xp/h", () => {
  const rank = engine.rankNow({ name: "Charizard", level: 204 });
  assert.ok(rank.length > 5);
  for (let i = 1; i < rank.length; i++) {
    assert.ok(rank[i - 1].xpPerHour >= rank[i].xpPerHour, "must be sorted desc");
  }
  console.log("      Charizard top3:", rank.slice(0, 3).map(r =>
    `${r.name}(${r.xpPerHour}xp/h)`).join("  "));
});

test("route spans levels below and above, with exactly one current band", () => {
  const route = engine.computeRoute({ name: "Haunter", level: 88 });
  assert.strictEqual(route.steps[0].fromLevel, 1, "route starts at level 1");
  const currents = route.steps.filter((s) => s.current);
  assert.strictEqual(currents.length, 1, "exactly one current band");
  const cur = currents[0];
  assert.ok(88 >= cur.fromLevel && (cur.toLevel == null || 88 <= cur.toLevel), "current band contains Lv.88");
  assert.ok(route.steps.some((s) => s.fromLevel < 88), "has bands below current");
});

test("live WS stats override the level-derived estimate on the current band", () => {
  const curOf = (r) => r.steps.find((s) => s.current);
  const base = curOf(engine.computeRoute({ name: "Haunter", level: 88 }));
  const buffed = curOf(engine.computeRoute({ name: "Haunter", level: 88,
    stats: { hp: 9999, atk: 9999, def: 9999, spAtk: 9999, spDef: 9999, speed: 9999 } }));
  // huge stats -> fewer hits -> higher xp/h on the current band
  assert.ok(buffed.xpPerHour >= base.xpPerHour);
});

test("VIP adds exactly +50% XP/h", () => {
  const base = engine.rankNow({ name: "Haunter", level: 88 });
  const vip = engine.rankNow({ name: "Haunter", level: 88 }, { vip: true });
  const b = base.find((r) => r.slug === vip[0].slug);
  const v = vip.find((r) => r.slug === vip[0].slug);
  assert.ok(Math.abs(v.xpPerHour - b.xpPerHour * 1.5) <= b.xpPerHour * 0.02,
    `vip ${v.xpPerHour} vs base*1.5 ${b.xpPerHour * 1.5}`);
});

test("matching clan raises XP/h; non-matching clan does not", () => {
  // Haunter is GHOST/POISON -> Malefic clan matches; Seavell (WATER/ICE) does not.
  const none = engine.rankNow({ name: "Haunter", level: 88 })[0];
  const malefic = engine.rankNow({ name: "Haunter", level: 88 }, { clan: "malefic", clanRank: 5 })
    .find((r) => r.slug === none.slug);
  const seavell = engine.rankNow({ name: "Haunter", level: 88 }, { clan: "seavell", clanRank: 5 })
    .find((r) => r.slug === none.slug);
  assert.ok(malefic.xpPerHour >= none.xpPerHour, "matching clan should not reduce xp/h");
  assert.strictEqual(seavell.xpPerHour, none.xpPerHour, "non-matching clan must not change xp/h");
  assert.ok(malefic.hitsToKill <= none.hitsToKill, "clan buff should not increase hits");
});

test("real account: volcanic rank 3 (+18%) applies to FIRE Charizard, not Haunter", () => {
  const r = engine.computeRoute({ name: "Charizard", level: 212 }, { clan: "volcanic", clanRank: 3 });
  assert.ok(Math.abs(r.clanMult - 1.18) < 1e-9, "expected 1.18, got " + r.clanMult);
  const h = engine.computeRoute({ name: "Haunter", level: 88 }, { clan: "volcanic", clanRank: 3 });
  assert.strictEqual(h.clanMult, 1, "volcanic must not buff a GHOST/POISON poke");
});

test("computeRoute reports the resolved modifiers", () => {
  const r = engine.computeRoute({ name: "Haunter", level: 88 }, { vip: true, clan: "malefic", clanRank: 3 });
  assert.strictEqual(r.vip, true);
  assert.ok(r.clanMult > 1, "malefic rank3 -> >1 multiplier, got " + r.clanMult);
});

test("loot metric ranks by money/h and differs from XP ordering", () => {
  const xp = engine.rankNow({ name: "Charizard", level: 212 });
  const loot = engine.rankNow({ name: "Charizard", level: 212 }, { metric: "loot" });
  assert.ok(loot.length > 3);
  for (let i = 1; i < loot.length; i++) assert.ok(loot[i - 1].moneyPerHour >= loot[i].moneyPerHour, "sorted by money/h");
  assert.ok(loot[0].moneyPerHour > 0, "top loot hunt has gold value");
  // steps carry both metrics
  assert.ok(xp[0].xpPerHour > 0 && xp[0].moneyPerHour >= 0);
});

test("loot route bands by money/h and marks the current band", () => {
  const r = engine.computeRoute({ name: "Charizard", level: 212 }, { metric: "loot" });
  assert.strictEqual(r.metric, "loot");
  assert.strictEqual(r.steps.filter((s) => s.current).length, 1);
  assert.ok(r.steps.every((s) => s.moneyPerHour >= 0));
});

test("pokexp boost adds +50% XP and stacks with VIP (x2.25)", () => {
  const base = engine.rankNow({ name: "Haunter", level: 88 })[0];
  const boosted = engine.rankNow({ name: "Haunter", level: 88 }, { xpBoost: true }).find((r) => r.slug === base.slug);
  assert.ok(Math.abs(boosted.xpPerHour - base.xpPerHour * 1.5) <= base.xpPerHour * 0.02, "boost = x1.5");
  const both = engine.rankNow({ name: "Haunter", level: 88 }, { vip: true, xpBoost: true }).find((r) => r.slug === base.slug);
  assert.ok(Math.abs(both.xpPerHour - base.xpPerHour * 2.25) <= base.xpPerHour * 0.03, "vip+boost = x2.25");
});

test("loot boost adds +50% money and does not touch XP", () => {
  const base = engine.rankNow({ name: "Charizard", level: 212 }, { metric: "loot" })[0];
  const boosted = engine.rankNow({ name: "Charizard", level: 212 }, { metric: "loot", lootBoost: true }).find((r) => r.slug === base.slug);
  assert.ok(Math.abs(boosted.moneyPerHour - base.moneyPerHour * 1.5) <= base.moneyPerHour * 0.02, "loot = x1.5");
  assert.strictEqual(boosted.xpPerHour, base.xpPerHour, "XP unaffected by loot boost");
});

test("route step carries icon + farmed-creature level fields", () => {
  const r = engine.computeRoute({ name: "Haunter", level: 88 });
  const s = r.steps.find((x) => x.current);
  assert.ok(s.pokeId > 0 && s.looktype != null && s.creatureLevel > 0, JSON.stringify(s));
});

test("current band ('Best match') reflects the poke's actual current level", () => {
  const poke = { name: "Haunter", level: 90 };
  const route = engine.computeRoute(poke, { metric: "xp" });
  const cur = route.steps.find((s) => s.current);
  assert.ok(cur, "has a current band");
  // recompute the same hunt directly at level 90 -> must match the current band
  const direct = engine.rankNow(poke, { metric: "xp" }).find((r) => r.slug === cur.slug);
  assert.strictEqual(cur.hitsToKill, direct.hitsToKill, "current band uses current-level metrics");
  assert.strictEqual(cur.xpPerHour, direct.xpPerHour);
});

test("unknown species returns a clean error", () => {
  const route = engine.computeRoute({ name: "NotAPokemon", level: 5 });
  assert.strictEqual(route.error, "unknown-species");
});

test("searchTargets autocompletes catchable creatures by name", () => {
  const res = engine.searchTargets("chari", 8);
  assert.ok(res.length >= 1);
  assert.ok(res.every((r) => /chari/i.test(r.name)));
  assert.ok(res[0].type1 && res[0].huntLevel > 0 && res[0].spritePokeId > 0);
});

test("captureRanking orders owned Pokemon by fewest hits (type advantage wins)", () => {
  const id = (n) => byName(n).pokeId;
  const owned = [
    { id: "a", pokeId: id("Blastoise"), name: "Blastoise", level: 100 },
    { id: "b", pokeId: id("Golem"), name: "Golem", level: 100 },
    { id: "c", pokeId: id("Venusaur"), name: "Venusaur", level: 100 },
  ];
  const r = engine.captureRanking(id("Charizard"), owned);
  assert.ok(r.target && r.target.slug, "target resolves to a hunt");
  assert.strictEqual(r.list.length, 3);
  // sorted ascending by hits; Rock (Golem) super-effective vs Fire/Flying -> fewest
  for (let i = 1; i < r.list.length; i++) assert.ok(r.list[i - 1].hits <= r.list[i].hits);
  assert.strictEqual(r.list[0].name, "Golem");
});

test("captureRanking on unknown target returns clean error", () => {
  const r = engine.captureRanking(999999, []);
  assert.strictEqual(r.error, "unknown-target");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
