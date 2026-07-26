# Fracture — Progress

## Status
Deployed to Netlify (https://fracture-game.netlify.app) for friend playtesting, 0.1.0 cut, private repo. Core mechanic/onboarding/art (Style C) done and reviewed. Post-deploy polish pass (all 5 ranked tasks below) completed and verified 2026-07-26 by game-debugger.

## Post-deploy polish tasks — all done (2026-07-26)

1. **[x] Remove debug log panel + "gray-box prototype" labeling from shipped build.** `index.html` title/`<h1>` no longer say "gray-box prototype". `#log` is now `display:none` by default (CSS) and only populated/shown when the page is loaded with `?debug=1` (`DEBUG_LOG_PANEL` flag in `src/main.js`) — real debugging still reachable, never shown to playtesters by default.
2. **[x] Sound.** New `src/audio.js`: fully procedural Web Audio API synthesis (inharmonic-partial bell/FM tones + filtered-noise ticks), zero external assets. `playLineClear(lineCount)` (pitch rises with combo size, extra shimmer partial at 3+ lines), `playShardScatter(shardCount)` (staggered noise+bell ticks), `playGameOver()` (descending 3-note bell figure). `unlockAudio()` called from the existing `pointerdown` handler so audio unlocks on the first real user gesture per browser autoplay policy; AudioContext creation is fully guarded (`window.AudioContext` missing, or the whole call, never throws — verified no console errors in headless Chromium runs with and without a real gesture).
3. **[x] Persist high score.** `localStorage` key `fracture.bestScore`; `bestVal` DOM element added next to `scoreVal` in the header, updated live (not just at game-over) whenever the running score beats the stored best.
4. **[x] Clear-moment juice.** Pure canvas-transform, no new assets: `boardFlashes` array drawn with `globalCompositeOperation:'lighter'`, tinted with the placed piece's own palette color (`pieces.js COLORS`, colorblind-audited) — a longer/stronger flash on cleared row/column cells, a shorter/softer one on the piece's own landing cells. `ctx.translate` jitter screen-shake (linear-decay magnitude, random angle each frame) fires on 3+ line combos. Both driven by a shared rAF ticker (`startEffectsTicker`) that self-stops once nothing is animating.
5. **[x] Game-over overlay: delta vs. best.** New `#bestDelta` element in the overlay: "New Best!" (styled, `.new-best` class) if the just-ended game's score beat the previous best at any point this game, otherwise "`X short of best (bestScore)`".

`core.js placePiece()` return value was extended **additively only** (`lineCount`, `rows`, `cols`, `shardCount` fields added; `ok`/`reason` unchanged) so main.js can drive sound/juice off real resolved-clear data without re-parsing `state.log` strings. Existing unit tests only ever assert `.ok`, confirmed unaffected.

### Verification actually performed (not just traced)
- `npm test` (21/21 core unit tests) — still green after the `placePiece` return-value change and log-panel gating.
- `node tests/drag-resize.playwright.mjs` (existing regression test) — still green.
- Ad-hoc Playwright smoke runs (headless Chromium, real browser, not just logic tracing), scratch scripts since deleted after use:
  - Confirmed `#log` invisible by default, visible with `?debug=1`; title/h1 no longer prototype-labeled.
  - Ran real games to game-over via `window.__fractureDebug.placePiece` (exercises the actual `placePiece`→`refreshChrome`→sound/juice code path) — zero `pageerror`/`console.error` across full playthroughs, confirming the Web Audio calls never throw in a real browser context.
  - Drove one placement via an **actual simulated pointer drag** (`page.mouse.down/move/up` on the canvas, not the debug hook) and confirmed the piece really lands in `state.board` — the interactive path itself was verified, not just that something renders.
  - Verified best-score persistence across `localStorage` (survives reload) and across "New Game" (score resets to 0, best carries over).
  - Verified both game-over overlay branches: seeded a very high `localStorage` best before a losing game → "`X short of best (999999)`", `.new-best` class absent; and a fresh best-score game → "New Best!" with `.new-best` class present.

Explicitly out of scope (per game-engineer, unchanged): settings menu, pause, meta-progression, share/screenshot capture, splash screen, app icon polish, particle systems beyond #4.

## Carried-forward open items (pre-existing)
- iOS real-device QA — CI build green, real-hardware confirmation deferred per user direction.
- Real-hardware (non-emulator) confirmation of Android touch-drag/orientation-mid-drag — currently passing on healthy emulator only.
