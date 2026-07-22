# Privacy Policy — Poke Hunt

_Last updated: 2026-07-22_

**Poke Hunt** is a browser extension that shows the best hunting routes for the
game **Poke Idle World** (`poke.idleworld.online`). This policy explains exactly
what the extension does with data.

## Summary

**Poke Hunt does not collect, store, transmit, sell, or share any personal data.**
Everything it does happens locally in your browser. There are no servers, no
analytics, no tracking, and no third parties.

## What the extension accesses (locally only)

To calculate accurate routes, the extension reads, **inside your own browser and
only on `poke.idleworld.online`**:

- The page's DOM (your currently selected Pokémon's name and level).
- Your game session token, read from the page's `sessionStorage`, used solely to
  make the game's **own** API calls listed below (it is never logged, stored, or
  sent anywhere else).
- Your game account details from the game's own endpoint `/api/characters/me`
  (VIP status, clan, level) to apply the correct XP/loot bonuses.
- Game data from the game's own endpoints (`/game/creatures.json`,
  `/game/items.json`, `/api/game/map-markers`) and messages on the game's
  WebSocket, to read your Pokémon and hunt information.

All of this data stays on your device and is used only to render the route panel.
It is discarded when the page is closed.

## What the extension sends

- It makes requests only to the game's own domain (`poke.idleworld.online`), which
  is the same server the game itself already talks to. No data is sent to the
  developer or any third party.
- The optional "support me" button opens the game's built-in diamond-transfer
  screen with a recipient pre-filled; you decide whether to send anything. The
  extension performs no transaction itself.

## Data storage

The extension stores no personal data. Creature/hunt data and Pokémon sprites are
bundled inside the extension, so it makes no external (non-game) network requests.

## Permissions

The extension runs only on `https://poke.idleworld.online/*`. It requests no
broad browsing, history, or cross-site permissions.

## Changes

Any changes to this policy will be reflected in the "Last updated" date above.

## Contact

Questions: [@maldbx0 on X](https://x.com/maldbx0).
