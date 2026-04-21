# PokeBattle

A browser-based AR visualizer for in-person Pokemon TCG battles between friends. An iPad on the table displays a shared stadium battlefield; each player uses their iPhone to photograph their active Pokemon card (or type the name as a fallback), and the matched sprite is rendered on the iPad with a pokeball entrance animation.

## Current state

- Single-file prototype at [index.html](index.html): phone camera → Tesseract.js OCR → PokeAPI sprite rendered over the detected card in a live video feed.
- Working but finicky (live video pipeline) and single-device.

## Target architecture

- **Battlefield view** (iPad, landscape) — renders [battlefield.png](battlefield.png) as backdrop with two sprite slots on the battle platform, shows a QR code until both players join, plays entrance animations.
- **Capture view** (phone) — one-shot photo capture with OCR + confirmation, plus a "type the name" fallback with autocomplete.
- **Realtime transport** — Supabase Realtime channel per room: presence for player join tracking, broadcast for capture events. No database tables needed for v1.
- **Hosting** — Vercel (static site, no build step).

## Tech constraints

- Pure static site: no bundler, no build step, no backend code. Dependencies via CDN.
- Reuse OCR + matching + sprite-fetch utilities from the existing [index.html](index.html) — they are self-contained and portable (see the detailed plan at `~/.claude/plans/don-t-write-any-code-lively-token.md`).
- Sprites: prefer PokeAPI animated Showdown sprites, fall back to `front_default`. Pokeball sprite: `https://pokeapi.co/api/v2/item/poke-ball` → `sprites.default`.

## Out of scope (future work)

Battle mechanics (HP, attacks, damage, turn tracking), KO animations, spectator mode, alternate Pokemon forms, sound effects. Do not add any of these unless explicitly requested.

## Workflow rule — stop between phases

**After completing each development phase below, STOP. Do not continue to the next phase until I have reviewed the current phase and explicitly told you to proceed.** Show me what you built, flag anything unexpected, and wait for a go-ahead.

Phases:

1. **Scaffolding** — split `index.html` into `index.html` (battlefield stub) + `capture.html` (capture stub) + `shared.js`. Both pages load without errors.
2. **Realtime sync** — Supabase project set up, channel join + presence + slot assignment working. iPad shows QR, phones scan and are assigned to Player 1 or 2. No sprites yet.
3. **Battlefield rendering** — stadium background, sprite slot positioning, landscape lock, QR placement finalized. Use hard-coded sprites to dial in positions.
4. **Capture + send** — one-shot OCR flow with confirmation, typing fallback with autocomplete, capture broadcasts → iPad renders the sprite (static, no animations yet).
5. **Animations** — pokeball entrance sequence (drop, bounce, flash, reveal), swap fade-out, sprite idle bob.
6. **Deploy + end-to-end test** — push to Vercel, test on real iPad + two real iPhones.

At the end of each phase, explicitly say "Phase N complete — ready for your review" and wait.
