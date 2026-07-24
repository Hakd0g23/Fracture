// Fracture — canvas renderer + input layer. Thin shell over src/core.js;
// contains no gameplay rules of its own (those all live in core.js so they
// stay unit-testable headlessly). Uses Pointer Events so mouse (desktop) and
// touch (mobile/tablet browsers) share one code path instead of two.

import { createGame, placePiece, canPlaceAt, QUEUE_CAP, TRAY_BASE_SIZE } from './core.js';
import { BOARD_SIZE } from './pieces.js';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const scoreVal = document.getElementById('scoreVal');
const logEl = document.getElementById('log');
const overlay = document.getElementById('overlay');
const finalScoreEl = document.getElementById('finalScore');
const newGameBtn = document.getElementById('newGameBtn');
const restartBtn = document.getElementById('restartBtn');

// ---- Section 5b: persisted onboarding flags --------------------------------
// core.js is DOM-free and can't read/write localStorage itself, so main.js
// owns persistence: read on load, pass in as createGame opts, write back
// whenever core.js reports a change (see persistOnboardingFlags below).
const LS_KEY_EXPOSURE = 'fracture.firstExposureComplete';
const LS_KEY_SHARD_CALLOUT = 'fracture.firstShardCalloutShown';

function readBoolFlag(key) {
  try { return localStorage.getItem(key) === 'true'; } catch { return false; }
}
function writeBoolFlag(key, value) {
  try { localStorage.setItem(key, value ? 'true' : 'false'); } catch { /* ignore (private mode, etc.) */ }
}

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

let state = newGameState();
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
  ctx.fillStyle = 'rgba(30,32,40,0.95)';
  ctx.strokeStyle = '#f1c40f';
  ctx.lineWidth = 1.5;
  roundRect(x, y, w, h, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#e8e8ec';
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
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
}

// ---- drag state ----
let drag = null; // { trayIndex, piece, x, y }

function shapeExtent(cells) {
  let maxR = 0, maxC = 0;
  for (const [r, c] of cells) { maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); }
  return { rows: maxR + 1, cols: maxC + 1 };
}

// ---- Style B: flat geometric shard rendering -------------------------------
// The legibility test from docs/art-direction.md: a shard and a same-shaped
// regular piece must read as visually distinct BEFORE any further style
// polish, not just via the "shard" text label (a functional fallback, not a
// design solution -- removed below now that the silhouette itself carries
// the signal). Regular pieces stay solid inset rounded-rect blocks that tile
// edge-to-edge. Shard cells render instead as small, irregular, angular
// "chip" facets with a visible gap between adjacent cells (even for a
// 2-cell domino shard, so it never reads as one contiguous block) and a
// two-tone flat facet split -- angular + gapped + two-tone -- with no
// gradients, so it stays "flat geometric" (the gradient/glass faceted look
// is reserved for style A). Verified by construction: a 1x1 shard_mono and a
// 1x1 mono piece pass the same cells/size into drawPieceGrid and produce
// deliberately different silhouettes, not just a color/label difference.

function strHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

function hash2(a, b) {
  // Deterministic small-int hash -> [0,1). Pure function of (a,b), so a
  // shard's jagged outline is stable across redraws instead of jittering
  // every frame.
  let h = (a * 374761393 + b * 668265263) ^ (a << 13);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = (h ^ (h >>> 13)) >>> 0;
  return h / 4294967295;
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

function drawShardChip(cx, cy, size, color, seed) {
  // Irregular angular polygon (jittered hexagon spokes) inscribed in radius
  // ~size/2 -- deliberately NOT a rounded rect, so the outline alone already
  // differs from a regular piece cell at any size.
  const spokes = 6;
  const baseR = size / 2;
  const pts = [];
  for (let i = 0; i < spokes; i++) {
    const angle = (Math.PI * 2 * i) / spokes - Math.PI / 2;
    const jitter = 0.6 + hash2(seed, i) * 0.55; // 0.6..1.15 of baseR
    pts.push([cx + Math.cos(angle) * baseR * jitter, cy + Math.sin(angle) * baseR * jitter]);
  }
  const tracePath = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  };

  // Two-tone flat facet split (no gradient): a darker half and a lighter
  // half of the same base color, clipped to the jagged outline so the split
  // never bleeds outside the chip.
  ctx.save();
  tracePath();
  ctx.clip();
  ctx.fillStyle = shadeColor(color, -0.22);
  ctx.fillRect(cx - baseR, cy - baseR, baseR * 2, baseR * 2);
  ctx.fillStyle = shadeColor(color, 0.22);
  const splitAngle = hash2(seed, 99) * Math.PI * 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(splitAngle) * baseR * 1.6, cy + Math.sin(splitAngle) * baseR * 1.6);
  ctx.lineTo(cx + Math.cos(splitAngle + Math.PI * 0.9) * baseR * 1.6, cy + Math.sin(splitAngle + Math.PI * 0.9) * baseR * 1.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  tracePath();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();
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
      drawShardChip(x + subcell / 2, y + subcell / 2, chipSize, color, cellSeed);
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
  ctx.clearRect(0, 0, layout.width, layout.height);

  // --- shard queue row ---
  ctx.fillStyle = '#7a7e8c';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`Shard Queue (${state.shardQueue.length}/${QUEUE_CAP})`, GAP, layout.queueY - 4);
  for (let i = 0; i < QUEUE_CAP; i++) {
    const x = GAP + i * (QUEUE_SLOT + 8);
    const y = layout.queueY;
    ctx.strokeStyle = i < state.shardQueue.length ? '#454a58' : '#33363f';
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
      ctx.fillStyle = cell ? cell.color : '#2a2d36';
      ctx.strokeStyle = '#1b1d23';
      ctx.lineWidth = 2;
      ctx.fillRect(x, y, cellSize, cellSize);
      ctx.strokeRect(x, y, cellSize, cellSize);
    }
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
      }
    }
  }

  // --- tray row ---
  ctx.fillStyle = '#7a7e8c';
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
    ctx.strokeStyle = isOverflowSlot ? '#f1c40f' : '#454a58';
    ctx.setLineDash(state.tray[i] ? [] : [4, 3]);
    roundRect(x, y, TRAY_SLOT_W, TRAY_SLOT_H, 8);
    ctx.stroke();
    ctx.setLineDash([]);
    if (isOverflowSlot) {
      // Non-color cue alongside the yellow border, for colorblind
      // accessibility (flagged as optional-but-cheap in the design doc).
      ctx.fillStyle = '#f1c40f';
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
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
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
  const target = dragTargetCell();
  const trayIndex = drag.trayIndex;
  drag = null;
  if (target) {
    const res = placePiece(state, trayIndex, target.r, target.c);
    if (res.ok) refreshChrome();
  }
  draw();
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', () => { drag = null; draw(); });

function refreshChrome() {
  scoreVal.textContent = state.score;
  // append only new log lines
  for (; lastLogLen < state.log.length; lastLogLen++) {
    const line = state.log[lastLogLen];
    const div = document.createElement('div');
    if (line.startsWith('OVERFLOW')) div.className = 'warn';
    if (line.startsWith('GAME OVER')) div.className = 'over';
    div.textContent = line;
    logEl.appendChild(div);
  }
  logEl.scrollTop = logEl.scrollHeight;
  if (state.gameOver) {
    finalScoreEl.textContent = `Final score: ${state.score}`;
    overlay.classList.add('show');
  }
  ingestPendingCallouts(state);
  persistOnboardingFlags(state);
  computeLayout(); // tray length can grow via overflow escalation
}

function newGame() {
  state = newGameState();
  activeCallouts = [];
  lastLogLen = 0;
  logEl.replaceChildren();
  overlay.classList.remove('show');
  scoreVal.textContent = '0';
  computeLayout();
  draw();
}

newGameBtn.addEventListener('click', newGame);
restartBtn.addEventListener('click', newGame);
window.addEventListener('resize', () => { computeLayout(); draw(); });

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

computeLayout();
draw();
