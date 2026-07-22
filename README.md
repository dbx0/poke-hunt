# Poke Hunt

A Chrome (MV3) extension for **Poke Idle World** (`poke.idleworld.online`). It adds
a button to the in-game dock that opens a modal showing the **optimized leveling
route** for your currently-active Pokemon: which hunt to farm now and where to
move at each level, ranked by XP/h. Each step has a one-click **Teleport**.

## What it does

- Reads your **active Pokemon** (name + level) from the party HUD, and enriches it
  with **live stats** from the game's WebSocket when available.
- Computes XP/h per hunt using formulas ported from the piwtools calculator:
  enemy stats at hunt level, type-effectiveness damage, hits-to-kill, and the
  per-creature productivity table. Fully offline — all data is bundled.
- Accounts for **VIP** (+50% XP), active **boosts** (pokexp / loot, from the WS),
  and your **clan** (type-matched combat bonus) — all auto-detected and shown as
  badges. Two tabs: **XP farm** and **Loot farm** ($/h from item sell prices).
- **Teleports** to a hunt by driving the game's own Map travel (region + marker),
  so player, enemies, combat, and server state are all set up correctly.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (`pokeidle/`).
4. Open `https://poke.idleworld.online/play`. A Gengar button appears in the dock,
   just after **Hunt Analyzer**. Click it.

## Layout

```
manifest.json     MV3 manifest (2 content scripts: MAIN-world WS hook + isolated UI)
inject.js         page-world WebSocket hook + teleport send-bridge
content.js        reads active poke, injects button, renders modal, teleports
engine.js         pure route engine (ported piwtools formulas)
ui/modal.css      modal styles (Shadow DOM, isolated from the game)
data/
  creatures.json  species stats, huntLevel, experience, loot, attacks
  hunts.json      hunt registry (slug, name, level, area)
  items.json      item sell prices (for loot $/h)
  speeds.json     per-creature kills/hour productivity table  [pokeId -> hit1..hit8]
  typechart.json  type-effectiveness matrix
  clans.json      clan roster (types + combat bonus by rank)
  meta.json       bundled-data version + date (shown in the modal header)
assets/
  gengar*.png     dock + toolbar icons
  sprites/*.png   bundled PokeAPI creature sprites (local, no external calls)
scripts/
  refresh-data.mjs   regenerate data/ from live sources + bump version
  bundle-sprites.mjs  download the sprites the current data needs
test/             node test suite for the engine
```

## Tests

```
npm test        # or: node test/engine.test.mjs
```

Covers the stat/HP formulas, type effectiveness, productivity interpolation,
route banding, VIP/boost multipliers, clan multipliers, current-level display,
and sprite/level fields.

## Updating the data (after a game patch)

All game data is bundled so the extension runs offline. When the game rebalances
XP, adds Pokemon, or moves hunts, refresh the snapshot:

```
npm run refresh
```

This pulls from the live sources, downloads any new sprites, and writes a new
`data/meta.json` version:

| file | source |
|------|--------|
| creatures.json | `GET /game/creatures.json` (game) |
| items.json | `GET /game/items.json` (game) |
| hunts.json | `GET /api/game/map-markers` (game) |
| speeds / typechart / clans | piwtools calculator bundle (auto-discovered) |
| sprites | PokeAPI (bundled once, cached in `assets/sprites/`) |

If `meta.json`'s version changes, bump `manifest.json`'s `version` and reload the
extension. The extraction from the piwtools bundle is content-anchored (not tied
to its minified variable names) so it survives their rebuilds; if a source moves,
`refresh-data.mjs` fails loudly rather than writing bad data.

## Teleport

The Teleport button drives the game's own travel: it opens the Map, switches to
the hunt's region (kanto/johto/outland/…), and clicks the hunt's marker — running
the game's real travel routine (player + enemies + combat + server state). It is
the only write action; everything else is read-only.

## Data provenance / IP note

Creature, item, and hunt data come from the game's own public endpoints;
`speeds`/`typechart`/`clans` from the public piwtools calculator; creature icons
are PokeAPI sprites. Pokemon is a Nintendo/Game Freak trademark — these assets are
used for a fan tool and are **not suitable for the public Chrome Web Store**;
distribute privately (sideload / self-host) or swap in original art.

## Scope / safety

Read-only except the Teleport button, which sends only the `enter-hunt` command
you could trigger by clicking in-game. The server remains authoritative and
validates every action. No economy writes, no automation loops.
