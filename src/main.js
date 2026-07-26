// Fracture — canvas renderer + input layer. Thin shell over src/core.js;
// contains no gameplay rules of its own (those all live in core.js so they
// stay unit-testable headlessly). Uses Pointer Events so mouse (desktop) and
// touch (mobile/tablet browsers) share one code path instead of two.

import { createGame, placePiece, canPlaceAt, mulberry32, QUEUE_CAP, TRAY_BASE_SIZE } from './core.js';
import { BOARD_SIZE, COLORS } from './pieces.js';
import { ATLAS_TILE, ATLAS_VARIANTS, ATLAS_PATH } from './spriteAtlasConfig.js';
import { playLineClear, playShardScatter, playGameOver, unlockAudio } from './audio.js';
import { fetchTopScores, submitScore } from './leaderboard.js';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const scoreVal = document.getElementById('scoreVal');
const bestVal = document.getElementById('bestVal');
const logEl = document.getElementById('log');
const overlay = document.getElementById('overlay');
const finalScoreEl = document.getElementById('finalScore');
const bestDeltaEl = document.getElementById('bestDelta');
const newGameBtn = document.getElementById('newGameBtn');
const quitBtn = document.getElementById('quitBtn');
const restartBtn = document.getElementById('restartBtn');
const nameInput = document.getElementById('nameInput');
const submitScoreBtn = document.getElementById('submitScoreBtn');
const submitStatusEl = document.getElementById('submitStatus');
const leaderboardListEl = document.getElementById('leaderboardList');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const LS_KEY_PLAYER_NAME = 'fracture.playerName';

// ---- light/dark theme -------------------------------------------------
// index.html defines the actual colors as CSS custom properties (light
// block under @media prefers-color-scheme, both explicit under
// [data-theme="light"|"dark"]); this just decides which one wins and
// persists an explicit user choice. The canvas renderer isn't CSS, so
// theme() below re-reads the resolved custom properties every draw() call
// instead of hardcoding hex values that would go stale on toggle.
const LS_KEY_THEME = 'fracture.theme';

function effectiveTheme() {
  const stored = (() => { try { return localStorage.getItem(LS_KEY_THEME); } catch { return null; } })();
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggleBtn.textContent = theme === 'light' ? '☀️' : '🌙';
}

applyTheme(effectiveTheme());
themeToggleBtn.addEventListener('click', () => {
  const next = effectiveTheme() === 'light' ? 'dark' : 'light';
  try { localStorage.setItem(LS_KEY_THEME, next); } catch { /* ignore (private mode, etc.) */ }
  applyTheme(next);
  draw();
});

function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    muted: v('--muted'), fg: v('--fg'), border: v('--border'), borderDim: v('--border-dim'),
    emptyCell: v('--empty-cell'), gridLine: v('--grid-line'), accent: v('--accent'),
    calloutBg: v('--callout-bg'), calloutText: v('--callout-text'),
  };
}

// ---- dev-only debug log panel ----------------------------------------------
// The raw engine event log (state.log) is a debugging aid, not a shipped
// player-facing feature -- gated behind an explicit ?debug=1 query flag so
// playtesters never see it by default, but it stays reachable for real
// debugging without a code change (just add the query param).
const DEBUG_LOG_PANEL = new URLSearchParams(location.search).has('debug');
if (DEBUG_LOG_PANEL && logEl) logEl.classList.add('show');

// ---- Section 5b: persisted onboarding flags --------------------------------
// core.js is DOM-free and can't read/write localStorage itself, so main.js
// owns persistence: read on load, pass in as createGame opts, write back
// whenever core.js reports a change (see persistOnboardingFlags below).
const LS_KEY_EXPOSURE = 'fracture.firstExposureComplete';
const LS_KEY_SHARD_CALLOUT = 'fracture.firstShardCalloutShown';
const LS_KEY_BEST_SCORE = 'fracture.bestScore';

function readBoolFlag(key) {
  try { return localStorage.getItem(key) === 'true'; } catch { return false; }
}
function writeBoolFlag(key, value) {
  try { localStorage.setItem(key, value ? 'true' : 'false'); } catch { /* ignore (private mode, etc.) */ }
}

function readBestScore() {
  try {
    const raw = localStorage.getItem(LS_KEY_BEST_SCORE);
    const n = raw == null ? 0 : parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}
function writeBestScore(v) {
  try { localStorage.setItem(LS_KEY_BEST_SCORE, String(v)); } catch { /* ignore (private mode, etc.) */ }
}

function readPlayerName() {
  try { return localStorage.getItem(LS_KEY_PLAYER_NAME) || ''; } catch { return ''; }
}
function writePlayerName(name) {
  try { localStorage.setItem(LS_KEY_PLAYER_NAME, name); } catch { /* ignore (private mode, etc.) */ }
}

let bestScore = readBestScore();
// True only for the single game in which the best score was actually beaten
// -- drives the game-over overlay's "New Best!" vs "X short of best" text
// (task 5), reset every newGame().
let beatBestThisGame = false;

function newGameState() {
  return createGame(undefined, {
    firstExposureComplete: readBoolFlag(LS_KEY_EXPOSURE),
    firstShardCalloutShown: readBoolFlag(LS_KEY_SHARD_CALLOUT),
  });
}

function persistOnboardingFlags(s) {
  writeBoolFlag(LS_KEY_EXPOSURE, s.firstExposureComplete);
  writeBoolFlag(LS_KEY_SHARD_CALLOUT, s.onboarding.firstShardCalloutFired);
}

// ---- resume-on-reload: persist the in-progress run so closing the tab/
// browser mid-game doesn't lose it -----------------------------------------
// Only the JSON-serializable fields are saved -- state.rng is a mulberry32
// closure over internal state that isn't exposed for serialization, so a
// resumed game gets a freshly seeded rng rather than continuing the exact
// same random sequence. That only affects which piece/shard shows up next,
// never anything already on the board, and is not worth core.js exposing
// its PRNG internals for.
const LS_KEY_GAME_STATE = 'fracture.gameState';

function saveGameState(s) {
  try {
    const { board, tray, shardQueue, score, gameOver, log, turn, firstExposureComplete, pendingCallouts, onboarding } = s;
    localStorage.setItem(LS_KEY_GAME_STATE, JSON.stringify({
      board, tray, shardQueue, score, gameOver, log, turn, firstExposureComplete, pendingCallouts, onboarding,
    }));
  } catch { /* ignore (private mode, etc.) */ }
}

function clearSavedGameState() {
  try { localStorage.removeItem(LS_KEY_GAME_STATE); } catch { /* ignore */ }
}

function tryLoadGameState() {
  try {
    const raw = localStorage.getItem(LS_KEY_GAME_STATE);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return null;
    if (!Array.isArray(saved.board) || !Array.isArray(saved.tray) || !Array.isArray(saved.shardQueue)) return null;
    if (typeof saved.score !== 'number' || typeof saved.gameOver !== 'boolean') return null;
    if (saved.gameOver) return null; // a finished run isn't resumable
    saved.rng = mulberry32(Date.now());
    return saved;
  } catch {
    return null;
  }
}

let state = tryLoadGameState() ?? newGameState();
saveGameState(state);
let lastLogLen = 0;

// ---- Section 5b: non-blocking pulse callouts --------------------------------
// Drawn directly on canvas (no new DOM/CSS chrome) so they stay inert to
// pointer input by construction and anchor exactly to the layout-computed
// coordinates of the existing shard-queue row / overflow tray slot.
const CALLOUT_DURATION_MS = 3200;
let activeCallouts = []; // { type, text, expiresAt }
let calloutTickerRunning = false;

function ingestPendingCallouts(s) {
  if (!s.pendingCallouts.length) return;
  const now = performance.now();
  for (const c of s.pendingCallouts) activeCallouts.push({ ...c, expiresAt: now + CALLOUT_DURATION_MS });
  s.pendingCallouts.length = 0;
  startCalloutTicker();
}

function startCalloutTicker() {
  if (calloutTickerRunning) return;
  calloutTickerRunning = true;
  const tick = () => {
    const before = activeCallouts.length;
    activeCallouts = activeCallouts.filter((c) => c.expiresAt > performance.now());
    if (before !== activeCallouts.length || activeCallouts.length > 0) draw();
    if (activeCallouts.length > 0) {
      requestAnimationFrame(tick);
    } else {
      calloutTickerRunning = false;
    }
  };
  requestAnimationFrame(tick);
}

// ---- clear-moment juice (flash/pulse + screen shake) -----------------------
// Pure canvas-transform code, no asset pipeline: ctx.translate jitter for
// shake, globalCompositeOperation:'lighter' for flash/pulse. Flash tint
// reuses the existing colorblind-audited COLORS palette (pieces.js) rather
// than raw white/yellow.
const FLASH_DURATION_MS = 320;
const LAND_FLASH_DURATION_MS = 180;
const SHAKE_DURATION_MS = 260;
let boardFlashes = []; // { r, c, color, expiresAt, startedAt, kind: 'clear'|'land' }
let shake = null; // { startedAt, duration, magnitude }
let effectsTickerRunning = false;

function startEffectsTicker() {
  if (effectsTickerRunning) return;
  effectsTickerRunning = true;
  const tick = () => {
    const now = performance.now();
    boardFlashes = boardFlashes.filter((f) => f.expiresAt > now);
    if (shake && now > shake.startedAt + shake.duration) shake = null;
    draw();
    if (boardFlashes.length > 0 || shake) {
      requestAnimationFrame(tick);
    } else {
      effectsTickerRunning = false;
    }
  };
  requestAnimationFrame(tick);
}

function triggerClearFlash(rows, cols, color) {
  const now = performance.now();
  const expiresAt = now + FLASH_DURATION_MS;
  for (const r of rows) for (let c = 0; c < BOARD_SIZE; c++) boardFlashes.push({ r, c, color, expiresAt, startedAt: now, kind: 'clear' });
  for (const c of cols) for (let r = 0; r < BOARD_SIZE; r++) boardFlashes.push({ r, c, color, expiresAt, startedAt: now, kind: 'clear' });
  startEffectsTicker();
}

function triggerLandFlash(cells, r0, c0, color) {
  const now = performance.now();
  const expiresAt = now + LAND_FLASH_DURATION_MS;
  for (const [dr, dc] of cells) boardFlashes.push({ r: r0 + dr, c: c0 + dc, color, expiresAt, startedAt: now, kind: 'land' });
  startEffectsTicker();
}

function triggerShake(magnitude) {
  shake = { startedAt: performance.now(), duration: SHAKE_DURATION_MS, magnitude };
  startEffectsTicker();
}

function currentShakeOffset() {
  if (!shake) return { x: 0, y: 0 };
  const now = performance.now();
  const t = (now - shake.startedAt) / shake.duration;
  if (t >= 1) return { x: 0, y: 0 };
  const falloff = 1 - t; // linear decay to 0
  const angle = Math.random() * Math.PI * 2;
  const r = shake.magnitude * falloff;
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
}

function drawCallout(text, anchorX, anchorY, align = 'left') {
  ctx.save();
  ctx.font = '12px -apple-system, sans-serif';
  const paddingX = 8, paddingY = 6;
  const w = ctx.measureText(text).width + paddingX * 2;
  const h = 22;
  let x = anchorX;
  if (align === 'center') x = anchorX - w / 2;
  if (align === 'right') x = anchorX - w;
  x = Math.max(GAP, Math.min(x, layout.width - w - GAP));
  const y = anchorY;
  const t = theme();
  ctx.fillStyle = t.calloutBg;
  ctx.strokeStyle = t.accent;
  ctx.lineWidth = 1.5;
  roundRect(x, y, w, h, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = t.calloutText;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + paddingX, y + h / 2 + 1);
  ctx.restore();
}

// ---- layout ----
let cellSize = 40;
const GAP = 10;
const QUEUE_SLOT = 46;
const TRAY_SLOT_W = 96;
const TRAY_SLOT_H = 86;

let layout = null;

function computeLayout() {
  const maxW = Math.min(window.innerWidth - 24, 480);
  cellSize = Math.floor(Math.max(30, Math.min(48, maxW / BOARD_SIZE)));
  const gridW = cellSize * BOARD_SIZE;
  const gridH = cellSize * BOARD_SIZE;

  const queueRowH = QUEUE_SLOT + 18;
  const trayRowH = TRAY_SLOT_H + 18;
  const trayCount = Math.max(TRAY_BASE_SIZE, state.tray.length);
  const trayRowW = trayCount * TRAY_SLOT_W + (trayCount - 1) * 8;

  const width = Math.max(gridW, QUEUE_CAP * (QUEUE_SLOT + 8), trayRowW) + GAP * 2;
  const queueY = GAP + 14;
  const gridX = (width - gridW) / 2;
  const gridY = queueY + QUEUE_SLOT + 16;
  const trayY = gridY + gridH + 16 + 14;
  const height = trayY + TRAY_SLOT_H + GAP;

  layout = { width, height, gridX, gridY, gridW, gridH, queueY, trayY, trayCount, trayRowW };

  // devicePixelRatio-aware backing store (see Style C comment above for why
  // this codebase needed it added now, not before): CSS/layout size stays
  // in logical pixels (canvas.style.width/height, and every draw() call
  // below), but the actual pixel buffer is sized up by dpr and the context
  // transform compensates, so raster sprites (and everything else) render
  // at native device resolution instead of being upscaled blurry.
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  // Setting canvas.width/height resets all context state (transform,
  // smoothing, etc.), so both must be reapplied every time this runs.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

// ---- drag state ----
let drag = null; // { trayIndex, piece, x, y }

function shapeExtent(cells) {
  let maxR = 0, maxC = 0;
  for (const [r, c] of cells) { maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); }
  return { rows: maxR + 1, cols: maxC + 1 };
}

// ---- Style C: rendered mineral-chip sprites (supersedes Style A) -----------
// docs/art-direction.md: Style C is greenlit, superseding Style A's
// runtime-procedural glass/crystal fill. Regular pieces are UNCHANGED (still
// solid inset rounded-rect blocks via the plain-fill branch of
// drawPieceGrid below). Shard cells now blit a pre-baked raster sprite
// instead of drawing gradients/clip-paths live every frame.
//
// Production path actually used (stated plainly, per the brief): this
// environment has no Blender and no Meshy install (checked directly, not
// assumed), so sprites are NOT modeled/rendered in a 3D tool. Instead they
// are procedurally-rendered-then-rasterized: tools/sprite-bake/renderChip.mjs
// draws a richer, more expensive version of a "mineral chip" (per-facet
// gradients, a blurred ambient-occlusion edge, mineral-grain texture, a
// branching crack network -- all affordable offline since they're paid once,
// not per frame) into an offscreen canvas, run headlessly via
// tools/sprite-bake/bake.mjs (Playwright/Chromium, the exact same
// headless-canvas/screenshot technique already used to verify Style B and
// Style A), and packed into one small PNG atlas at
// assets/sprites/shard-atlas.png. Run `node tools/sprite-bake/bake.mjs` to
// regenerate it (requires a Playwright Chromium install reachable on
// NODE_PATH; see the build report for how this environment's install was
// located -- no network fetch is required, an existing local install was
// reused). This is a real, reproducible, commercially-clean production
// path (no third-party asset licensing at all, since every pixel is
// code-generated by this repo's own tool), not a placeholder.
//
// Layout/silhouette lineage: B's core idea -- an irregular angular polygon
// silhouette, not a rounded rect, so shard cells read as distinct fragments
// by OUTLINE alone -- carries forward, evolved (see renderChip.mjs) into a
// more organic 9-vertex jittered-angle-and-radius outline rather than B's
// clean 6-spoke hexagon. Each shard shape (mono/domino_h/domino_v) is still
// composed the same way it always has been: drawPieceGrid loops per CELL
// and blits one "chip" sprite per cell with a visible gap between adjacent
// cells (so a domino shard never reads as one solid block) -- Style C did
// not need to touch that composition logic, only what gets drawn per cell.
//
// Palette fidelity: each of the 7 colorblind-audited palette colors
// (pieces.js COLORS) is baked directly into its own atlas column at the
// exact hex value -- NOT approximated via a runtime multiply/tint blend --
// specifically so the audited pairwise contrast guarantees are not put at
// any risk of drifting under a lossy tint approximation. The only pixel
// transform applied after rendering is a color-depth quantization pass
// (bake.html) purely for PNG file size (DEFLATE compresses far fewer
// distinct byte values much better); it reduces each channel to 20 levels,
// which held up visually distinct-per-color and effectively
// bandingless at every real render size checked (see build report).
//
// Mobile bundle size (a real cost now, per the Capacitor packaging
// decision): the atlas is ATLAS_VARIANTS variants x 7 colors x ATLAS_TILE^2
// px, ~436KB total (measured directly) -- kept lean by capping tile
// resolution to what real on-screen chips actually need (see
// spriteAtlasConfig.js) rather than an arbitrary high-res export, capping
// variant count to what's ever simultaneously visible, and the
// quantization pass above.
//
// devicePixelRatio: this codebase had ZERO devicePixelRatio handling before
// this pass (checked directly -- canvas.width was always set equal to CSS
// layout pixels, so the backing store was upscaled by the browser
// compositor on any non-1x display). That was survivable for flat vector
// fills but would visibly blur raster sprites, so computeLayout() below now
// sizes the canvas backing store to `layout.width * devicePixelRatio` and
// applies a matching ctx.setTransform so every existing draw call (all
// written in CSS-pixel/logical coordinates) keeps working unchanged.
// pointFromEvent() was updated to scale by `layout.width / rect.width`
// instead of `canvas.width / rect.width`, since canvas.width is now a
// physical-pixel quantity that no longer matches the logical coordinate
// space the rest of the input/drag code operates in.

function strHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

const COLOR_INDEX = new Map(COLORS.map((c, i) => [c, i]));

const shardAtlas = new Image();
let shardAtlasReady = false;
shardAtlas.onload = () => { shardAtlasReady = true; draw(); };
shardAtlas.onerror = () => {
  // Missing/failed atlas load shouldn't hard-crash the game -- the
  // per-cell fallback in drawShardSprite below keeps shards visually
  // distinct (still not a rounded rect) even if the sprite never arrives.
  console.error('Fracture: shard sprite atlas failed to load:', ATLAS_PATH);
};
shardAtlas.src = ATLAS_PATH;

function drawShardSprite(cx, cy, size, color, seed) {
  const colorIdx = COLOR_INDEX.get(color) ?? 0;
  const variantIdx = ((seed % ATLAS_VARIANTS) + ATLAS_VARIANTS) % ATLAS_VARIANTS;
  if (shardAtlasReady) {
    const sx = colorIdx * ATLAS_TILE;
    const sy = variantIdx * ATLAS_TILE;
    ctx.drawImage(shardAtlas, sx, sy, ATLAS_TILE, ATLAS_TILE, cx - size / 2, cy - size / 2, size, size);
    return;
  }
  // Pre-load-frame fallback only (real load is near-instant off a bundled
  // local asset) -- a simple angular placeholder, still distinct in
  // silhouette from a regular piece's rounded rect, so nothing reads as
  // "broken" during the one or two frames before the atlas arrives.
  const r = size / 2;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy - r * 0.2);
  ctx.lineTo(cx + r * 0.6, cy + r);
  ctx.lineTo(cx - r * 0.6, cy + r);
  ctx.lineTo(cx - r, cy - r * 0.2);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function shadeColor(hex, amt) {
  // amt in [-1,1]; negative darkens toward black, positive lightens toward
  // white. Used for flat two-tone facets and a subtle top-edge highlight --
  // still flat colors, no gradients.
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  const mix = amt < 0 ? 0 : 255;
  const k = Math.abs(amt);
  r = Math.round(r + (mix - r) * k);
  g = Math.round(g + (mix - g) * k);
  b = Math.round(b + (mix - b) * k);
  return `rgb(${r},${g},${b})`;
}

function drawPieceGrid(cells, color, ox, oy, subcell, isShard, shapeId) {
  const shapeSeed = strHash(shapeId || '');
  for (const [r, c] of cells) {
    const x = ox + c * subcell;
    const y = oy + r * subcell;
    if (isShard) {
      // Gap between adjacent shard cells (even within one shard's own
      // footprint) so a domino shard never reads as a solid contiguous
      // block the way a regular domino piece does.
      const gap = Math.max(3, subcell * 0.22);
      const chipSize = Math.max(4, subcell - gap);
      const cellSeed = (shapeSeed + r * 131 + c * 977) | 0;
      drawShardSprite(x + subcell / 2, y + subcell / 2, chipSize, color, cellSeed);
    } else {
      ctx.fillStyle = color;
      roundRect(x + 1, y + 1, subcell - 2, subcell - 2, 4);
      ctx.fill();
      // Subtle flat top-edge highlight -- still a flat color (lighter shade
      // of the fill), not a gradient; a small refinement over the previous
      // plain single-tone fill.
      ctx.strokeStyle = shadeColor(color, 0.28);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 5, y + 1.5);
      ctx.lineTo(x + subcell - 5, y + 1.5);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      roundRect(x + 1, y + 1, subcell - 2, subcell - 2, 4);
      ctx.stroke();
    }
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function draw() {
  ctx.save();
  const t = theme();
  ctx.clearRect(0, 0, layout.width, layout.height);
  // Screen shake: jitter the whole draw via ctx.translate, applied only to
  // the board/piece drawing below (restored before UI chrome would matter --
  // in practice the whole draw() call is small enough that shaking
  // everything, including the queue/tray rows, reads fine and is simplest).
  const shakeOffset = currentShakeOffset();
  ctx.translate(shakeOffset.x, shakeOffset.y);

  // --- shard queue row ---
  ctx.fillStyle = t.muted;
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`Shard Queue (${state.shardQueue.length}/${QUEUE_CAP})`, GAP, layout.queueY - 4);
  for (let i = 0; i < QUEUE_CAP; i++) {
    const x = GAP + i * (QUEUE_SLOT + 8);
    const y = layout.queueY;
    ctx.strokeStyle = i < state.shardQueue.length ? t.border : t.borderDim;
    ctx.setLineDash(state.shardQueue[i] ? [] : [4, 3]);
    roundRect(x, y, QUEUE_SLOT, QUEUE_SLOT, 6);
    ctx.stroke();
    ctx.setLineDash([]);
    const shard = state.shardQueue[i];
    if (shard) {
      const ext = shapeExtent(shard.shape);
      const sub = Math.floor((QUEUE_SLOT - 10) / Math.max(ext.rows, ext.cols, 1));
      const ox = x + (QUEUE_SLOT - ext.cols * sub) / 2;
      const oy = y + (QUEUE_SLOT - ext.rows * sub) / 2;
      drawPieceGrid(shard.shape, shard.color, ox, oy, sub, true, shard.shapeId);
    }
  }

  // --- grid ---
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const x = layout.gridX + c * cellSize;
      const y = layout.gridY + r * cellSize;
      const cell = state.board[r][c];
      ctx.fillStyle = cell ? cell.color : t.emptyCell;
      ctx.strokeStyle = t.gridLine;
      ctx.lineWidth = 2;
      ctx.fillRect(x, y, cellSize, cellSize);
      ctx.strokeRect(x, y, cellSize, cellSize);
    }
  }

  // --- clear-moment juice: flash/pulse on cleared row/column and shard
  // landing cells (task 4). 'lighter' composite blends an additive glow of
  // the palette-tinted color on top, fading out over the flash's lifetime --
  // never a raw white/yellow, always the COLORS-palette hue passed in.
  if (boardFlashes.length > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const now = performance.now();
    for (const f of boardFlashes) {
      const life = (f.expiresAt - now) / (f.expiresAt - f.startedAt);
      if (life <= 0) continue;
      const x = layout.gridX + f.c * cellSize;
      const y = layout.gridY + f.r * cellSize;
      ctx.globalAlpha = Math.max(0, Math.min(1, life)) * (f.kind === 'clear' ? 0.75 : 0.55);
      ctx.fillStyle = f.color;
      ctx.fillRect(x, y, cellSize, cellSize);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // --- drop preview ---
  if (drag) {
    const { rows, cols } = shapeExtent(drag.piece.shape);
    const target = dragTargetCell();
    if (target) {
      const ok = canPlaceAt(state.board, drag.piece.shape, target.r, target.c);
      ctx.fillStyle = ok ? 'rgba(46,204,113,0.35)' : 'rgba(231,76,60,0.35)';
      ctx.strokeStyle = ok ? '#2ecc71' : '#e74c3c';
      ctx.lineWidth = 2;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let anyOnBoard = false;
      for (const [dr, dc] of drag.piece.shape) {
        const rr = target.r + dr, cc = target.c + dc;
        if (rr < 0 || rr >= BOARD_SIZE || cc < 0 || cc >= BOARD_SIZE) continue;
        const x = layout.gridX + cc * cellSize;
        const y = layout.gridY + rr * cellSize;
        ctx.fillRect(x, y, cellSize, cellSize);
        ctx.strokeRect(x, y, cellSize, cellSize);
        anyOnBoard = true;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + cellSize); maxY = Math.max(maxY, y + cellSize);
      }
      // Non-color valid/invalid cue, extending the SAME pattern already used
      // for the overflow tray slot (border color + a non-color glyph) rather
      // than inventing a new one -- a checkmark/X shape reads as valid vs
      // invalid regardless of whether the green/red border hues themselves
      // are distinguishable to the viewer.
      if (anyOnBoard) {
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        ctx.fillStyle = ok ? '#2ecc71' : '#e74c3c';
        ctx.font = `bold ${Math.round(Math.min(cellSize * 0.9, 28))}px -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ok ? '✓' : '✕', cx, cy + 1);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.font = '11px -apple-system, sans-serif';
      }
    }
  }

  // --- tray row ---
  ctx.fillStyle = t.muted;
  ctx.fillText('Tray', GAP, layout.trayY - 4);
  const trayStartX = (layout.width - layout.trayRowW) / 2;
  let overflowCalloutAnchor = null;
  for (let i = 0; i < state.tray.length; i++) {
    const x = trayStartX + i * (TRAY_SLOT_W + 8);
    const y = layout.trayY;
    const isDragged = drag && drag.trayIndex === i;
    const piece = state.tray[i];
    // Overflow slot highlighted: either a temporary extra slot beyond base
    // size 3, or a regular slot currently holding a shard that force-landed
    // there via overflow escalation (the common case -- see core.js
    // insertShard's arrivedViaOverflow tag).
    const isOverflowSlot = i >= TRAY_BASE_SIZE || (piece && piece.arrivedViaOverflow);
    if (isOverflowSlot) overflowCalloutAnchor = { x, y };
    ctx.strokeStyle = isOverflowSlot ? t.accent : t.border;
    ctx.setLineDash(state.tray[i] ? [] : [4, 3]);
    roundRect(x, y, TRAY_SLOT_W, TRAY_SLOT_H, 8);
    ctx.stroke();
    ctx.setLineDash([]);
    if (isOverflowSlot) {
      // Non-color cue alongside the yellow border, for colorblind
      // accessibility (flagged as optional-but-cheap in the design doc).
      ctx.fillStyle = t.accent;
      ctx.font = '11px -apple-system, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText('⚠', x + TRAY_SLOT_W - 16, y + 3); // warning triangle glyph
    }
    if (piece && !isDragged) {
      const ext = shapeExtent(piece.shape);
      const sub = Math.floor((TRAY_SLOT_W - 16) / Math.max(ext.cols, 1));
      const subH = Math.floor((TRAY_SLOT_H - 16) / Math.max(ext.rows, 1));
      const s = Math.min(sub, subH, 18);
      const ox = x + (TRAY_SLOT_W - ext.cols * s) / 2;
      const oy = y + (TRAY_SLOT_H - ext.rows * s) / 2;
      // No text label here anymore -- the shard's chip silhouette (see
      // drawPieceGrid) is the actual legibility signal now, not a fallback
      // "shard" caption. Keeping the label would have masked whether the
      // silhouette alone actually reads as a fragment.
      drawPieceGrid(piece.shape, piece.color, ox, oy, s, piece.isShard, piece.shapeId);
    }
  }

  // --- dragged piece follows pointer, drawn on top ---
  if (drag) {
    const ext = shapeExtent(drag.piece.shape);
    const s = cellSize;
    const ox = drag.x - (ext.cols * s) / 2;
    const oy = drag.y - (ext.rows * s) / 2 - 40; // lifted above finger/cursor
    ctx.globalAlpha = 0.95;
    drawPieceGrid(drag.piece.shape, drag.piece.color, ox, oy, s, drag.piece.isShard, drag.piece.shapeId);
    ctx.globalAlpha = 1;
  }

  // --- Section 5b: non-blocking pulse callouts, drawn last (on top) -------
  // Never intercepts pointer input (pure canvas drawing, no hit-testing
  // added anywhere) and auto-dismisses after CALLOUT_DURATION_MS.
  for (const callout of activeCallouts) {
    if (callout.type === 'first-shard') {
      // Anchored to the existing shard-queue row.
      drawCallout(callout.text, GAP, layout.queueY + QUEUE_SLOT + 4);
    } else if (callout.type === 'first-overflow') {
      // Anchored to the existing yellow-highlighted overflow tray slot; if
      // that slot has already cycled out of the tray by render time, fall
      // back to the tray row itself so the callout never silently vanishes.
      const anchor = overflowCalloutAnchor || { x: trayStartX, y: layout.trayY };
      drawCallout(callout.text, anchor.x, anchor.y - 28);
    }
  }
  ctx.restore(); // pairs with the ctx.save()/translate(shake) at the top of draw()
}

function dragTargetCell() {
  if (!drag) return null;
  const ext = shapeExtent(drag.piece.shape);
  const s = cellSize;
  const ox = drag.x - (ext.cols * s) / 2;
  const oy = drag.y - (ext.rows * s) / 2 - 40;
  const c = Math.round((ox - layout.gridX) / s);
  const r = Math.round((oy - layout.gridY) / s);
  return { r, c };
}

function pointFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  // Scale by the LOGICAL layout size, not canvas.width/height -- those are
  // now physical-pixel (devicePixelRatio-scaled) quantities, while every
  // other coordinate in this file (layout.gridX, drag.x, etc.) is in the
  // same logical/CSS-pixel space as layout.width. Using canvas.width here
  // would silently multiply every pointer coordinate by dpr again.
  const scaleX = layout.width / rect.width;
  const scaleY = layout.height / rect.height;
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}

function trayIndexAt(x, y) {
  const trayStartX = (layout.width - layout.trayRowW) / 2;
  if (y < layout.trayY || y > layout.trayY + TRAY_SLOT_H) return -1;
  for (let i = 0; i < state.tray.length; i++) {
    const sx = trayStartX + i * (TRAY_SLOT_W + 8);
    if (x >= sx && x <= sx + TRAY_SLOT_W) return i;
  }
  return -1;
}

canvas.addEventListener('pointerdown', (e) => {
  unlockAudio(); // must run from a real user-gesture handler; safe to call every time
  if (state.gameOver) return;
  const p = pointFromEvent(e);
  const idx = trayIndexAt(p.x, p.y);
  if (idx >= 0 && state.tray[idx]) {
    drag = { trayIndex: idx, piece: state.tray[idx], x: p.x, y: p.y };
    canvas.setPointerCapture(e.pointerId);
    draw();
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = pointFromEvent(e);
  drag.x = p.x;
  drag.y = p.y;
  draw();
});

function endDrag(e) {
  if (!drag) return;
  // Re-sample the pointer position from the pointerup event itself rather
  // than trusting drag.x/y left over from the last pointermove. If a
  // resize/orientation-change fires between the last move and this release
  // with no intervening pointer movement, layout/rect/DPR may have changed
  // and the stale coordinates would compute a drop cell against the old
  // geometry. See issue #1.
  if (e && typeof e.clientX === 'number') {
    const p = pointFromEvent(e);
    drag.x = p.x;
    drag.y = p.y;
  }
  const target = dragTargetCell();
  const trayIndex = drag.trayIndex;
  const piece = drag.piece;
  drag = null;
  if (target) {
    const res = placePiece(state, trayIndex, target.r, target.c);
    if (res.ok) {
      // Landing flash for the piece that just landed on the board -- do this
      // BEFORE refreshChrome/clear-line flash so a placement that both lands
      // and immediately clears shows both effects, land first.
      triggerLandFlash(piece.shape, target.r, target.c, piece.color);
      if (res.lineCount > 0) {
        triggerClearFlash(res.rows, res.cols, piece.color);
        playLineClear(res.lineCount);
        if (res.shardCount > 0) playShardScatter(res.shardCount);
        if (res.lineCount >= 3) triggerShake(6);
      }
      refreshChrome();
    }
  }
  draw();
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', () => { drag = null; draw(); });

function refreshChrome() {
  scoreVal.textContent = state.score;
  // append only new log lines (only bother touching the DOM panel if it's
  // actually visible -- dev-only, see DEBUG_LOG_PANEL above)
  if (DEBUG_LOG_PANEL) {
    for (; lastLogLen < state.log.length; lastLogLen++) {
      const line = state.log[lastLogLen];
      const div = document.createElement('div');
      if (line.startsWith('OVERFLOW')) div.className = 'warn';
      if (line.startsWith('GAME OVER')) div.className = 'over';
      div.textContent = line;
      logEl.appendChild(div);
    }
    logEl.scrollTop = logEl.scrollHeight;
  } else {
    lastLogLen = state.log.length;
  }
  // Best-score persistence (task 3): update as soon as the running score
  // beats it, not only at game-over, so "Best: X" in the header stays live
  // during play too, matching how "Score: X" already updates live.
  if (state.score > bestScore) {
    bestScore = state.score;
    writeBestScore(bestScore);
    beatBestThisGame = true;
  }
  bestVal.textContent = bestScore;
  if (state.gameOver) {
    finalScoreEl.textContent = `Final score: ${state.score}`;
    if (beatBestThisGame) {
      bestDeltaEl.textContent = 'New Best!';
      bestDeltaEl.classList.add('new-best');
    } else {
      const short = bestScore - state.score;
      bestDeltaEl.textContent = short > 0 ? `${short} short of best (${bestScore})` : `Best: ${bestScore}`;
      bestDeltaEl.classList.remove('new-best');
    }
    overlay.classList.add('show');
    playGameOver();
  }
  ingestPendingCallouts(state);
  persistOnboardingFlags(state);
  // A finished run (game-over or an explicit quit, which sets the same
  // flag) is no longer resumable, so drop the save; otherwise keep it fresh
  // so closing the tab mid-game doesn't lose progress.
  if (state.gameOver) clearSavedGameState();
  else saveGameState(state);
  computeLayout(); // tray length can grow via overflow escalation
}

function quitGame() {
  if (state.gameOver) return;
  if (!confirm('Quit this game? Your current run will end and show the Game Over screen.')) return;
  state.gameOver = true;
  refreshChrome();
  draw();
}

function newGame() {
  state = newGameState();
  activeCallouts = [];
  boardFlashes = [];
  shake = null;
  beatBestThisGame = false;
  lastLogLen = 0;
  logEl.replaceChildren();
  overlay.classList.remove('show');
  bestDeltaEl.classList.remove('new-best');
  scoreVal.textContent = '0';
  bestVal.textContent = bestScore;
  submitStatusEl.textContent = '';
  submitScoreBtn.disabled = false;
  saveGameState(state);
  computeLayout();
  draw();
}

newGameBtn.addEventListener('click', newGame);
restartBtn.addEventListener('click', newGame);
quitBtn.addEventListener('click', quitGame);
window.addEventListener('resize', () => { computeLayout(); draw(); });

// ---- online leaderboard (Supabase) ------------------------------------
// leaderboard.js is DOM-free and network-agnostic; all UI/state wiring
// lives here, matching the persistence-ownership split main.js already
// uses for onboarding flags and bestScore.
nameInput.value = readPlayerName();

async function renderLeaderboard() {
  leaderboardListEl.replaceChildren();
  const rows = await fetchTopScores(10);
  if (!rows) {
    const li = document.createElement('li');
    li.textContent = 'Leaderboard unavailable';
    leaderboardListEl.appendChild(li);
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  rows.forEach((row, i) => {
    const li = document.createElement('li');
    if (i < 3) li.classList.add(`rank-${i + 1}`);
    const icon = document.createElement('span');
    icon.className = 'rank-icon';
    icon.textContent = i < 3 ? medals[i] : String(i + 1);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = row.name;
    const score = document.createElement('span');
    score.textContent = row.score;
    li.append(icon, name, score);
    leaderboardListEl.appendChild(li);
  });
}

renderLeaderboard(); // sidebar is always visible, so populate it on load

submitScoreBtn.addEventListener('click', async () => {
  const name = nameInput.value.trim();
  if (!name) {
    submitStatusEl.textContent = 'Enter a name first.';
    return;
  }
  writePlayerName(name);
  submitScoreBtn.disabled = true;
  submitStatusEl.textContent = 'Submitting…';
  const ok = await submitScore(name, state.score);
  submitStatusEl.textContent = ok ? 'Submitted!' : 'Could not submit score.';
  if (!ok) submitScoreBtn.disabled = false;
  else renderLeaderboard(); // reflect the new score immediately
});

// QA/automation hook only -- inert for normal play, lets an external test
// script (e.g. Playwright) reach past RNG to drive specific scenarios
// (shard queue fill, overflow escalation, game-over) through the exact same
// placePiece/refreshChrome/draw code path real play uses.
window.__fractureDebug = {
  getState: () => state,
  placePiece: (idx, r, c) => { const res = placePiece(state, idx, r, c); refreshChrome(); draw(); return res; },
  redraw: () => draw(),
  // exact canvas-space geometry, so an external test driver doesn't have to
  // guess proportional coordinates for real pointer-drag simulation.
  geometry: () => {
    const trayStartX = (layout.width - layout.trayRowW) / 2;
    return {
      canvasWidth: layout.width,
      canvasHeight: layout.height,
      traySlotCenter: (i) => ({ x: trayStartX + i * (TRAY_SLOT_W + 8) + TRAY_SLOT_W / 2, y: layout.trayY + TRAY_SLOT_H / 2 }),
      gridCellCenter: (r, c) => ({ x: layout.gridX + c * cellSize + cellSize / 2, y: layout.gridY + r * cellSize + cellSize / 2 }),
    };
  },
};

// Reflect a resumed in-progress run's score immediately (a fresh game is
// already 0, so this is a no-op in that case).
scoreVal.textContent = state.score;
bestVal.textContent = bestScore;
computeLayout();
draw();
