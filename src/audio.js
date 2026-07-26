// Fracture — procedural sound effects via the Web Audio API.
//
// No third-party asset licensing (same "no external asset pipeline" pattern
// as the Style C sprite bake in main.js): every sound here is synthesized at
// runtime from oscillators/noise, nothing is loaded from a file.
//
// Palette brief (game-asset-director): glassy/crystalline -- bright,
// short-decay, slightly inharmonic bell/FM tones matching the shard/fracture
// visual theme. Explicitly NOT wood/thud. Achieved by:
//   - inharmonic partials (frequency ratios that are NOT small integers, e.g.
//     1x/2.4x/3.8x instead of a harmonic 1x/2x/3x stack) -- this is what
//     makes FM/additive bells sound metallic/glassy rather than
//     woodwind/string-like.
//   - fast exponential decay envelopes (short sustain, no long resonant
//     tail) for the "short-decay" brief.
//   - triangle/sine oscillators (no sawtooth/square, which read as
//     buzzy/electronic rather than bell-like).
//
// Autoplay-policy aware: browsers block AudioContext until a user gesture.
// This module lazily creates/resumes the context on first call from an
// input handler (pointerdown already exists in main.js), never at module
// load time.

let ctx = null;

function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null; // unsupported browser -- fail silent, never crash the game over audio
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

let muted = false;
export function setMuted(v) { muted = v; }
export function isMuted() { return muted; }

// One inharmonic bell/FM "chip" voice: a carrier tone plus a couple of
// non-integer-ratio partials, each with its own fast decay, mixed to a
// shared gain node with a short master envelope. `baseFreq` in Hz,
// `duration` in seconds, `gain` peak linear gain (kept low -- several of
// these can stack in a fast combo).
function playBell(baseFreq, duration, gain, when = 0) {
  const ac = getCtx();
  if (!ac || muted) return;
  const t0 = ac.currentTime + when;
  const master = ac.createGain();
  master.gain.setValueAtTime(0, t0);
  master.gain.linearRampToValueAtTime(gain, t0 + 0.006);
  master.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  master.connect(ac.destination);

  // Inharmonic partial ratios -- deliberately not 1/2/3 (that would sound
  // like a harmonic/organ tone) so this reads as glass/metal, not wood/string.
  const partials = [
    { ratio: 1.0, mix: 1.0 },
    { ratio: 2.41, mix: 0.5 },
    { ratio: 3.83, mix: 0.28 },
  ];
  for (const p of partials) {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseFreq * p.ratio, t0);
    const partialGain = ac.createGain();
    partialGain.gain.setValueAtTime(p.mix, t0);
    // Each partial decays slightly faster than the last (higher partials die
    // first) -- a classic bell-synthesis trick, gives the short-decay,
    // "chime" character instead of one flat mono-decay tone.
    partialGain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration * (1 - p.ratio * 0.08));
    osc.connect(partialGain);
    partialGain.connect(master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  }
}

// Short filtered-noise "scatter" tick -- a burst of white noise through a
// bandpass filter reads as a glassy/granular tick rather than a thud (which
// would instead use a lowpass-swept noise burst with a much longer tail).
function playNoiseTick(freq, duration, gain, when = 0) {
  const ac = getCtx();
  if (!ac || muted) return;
  const t0 = ac.currentTime + when;
  const bufSize = Math.ceil(ac.sampleRate * duration);
  const buf = ac.createBuffer(1, bufSize, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(freq, t0);
  filter.Q.value = 6;
  const g = ac.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  src.connect(filter);
  filter.connect(g);
  g.connect(ac.destination);
  src.start(t0);
  src.stop(t0 + duration + 0.02);
}

// ---- public effect API ------------------------------------------------------

// Line clear: pitch rises with combo size (1..4+ lines) so bigger clears
// read as more rewarding, capped so it never scrapes crazy-high with
// extreme combos. `lineCount` from placePiece's additive return field.
export function playLineClear(lineCount) {
  const n = Math.max(1, Math.min(lineCount, 4));
  const baseFreq = 660 * Math.pow(1.19, n - 1); // ~major-third-ish step per extra line
  playBell(baseFreq, 0.55, 0.22);
  if (n >= 3) {
    // Extra shimmering high partial stacked on top for 3+ line combos --
    // the "juice" cue for a big clear, still bell-timbred (not a separate
    // sound family).
    playBell(baseFreq * 2.0, 0.4, 0.12, 0.05);
  }
}

// Shard scatter: one bright noise tick per shard cell landing, staggered a
// few ms apart so multiple shards read as a granular "scatter" rather than
// one simultaneous blob.
export function playShardScatter(shardCount) {
  const count = Math.max(1, shardCount);
  for (let i = 0; i < count; i++) {
    playNoiseTick(2400 + i * 260, 0.12, 0.16, i * 0.045);
    playBell(1400 + i * 180, 0.18, 0.08, i * 0.045);
  }
}

// Game-over stinger: a short descending inharmonic bell figure -- still
// glassy (never a low wood/thud "game over" cliche).
export function playGameOver() {
  playBell(520, 0.5, 0.22, 0);
  playBell(390, 0.6, 0.2, 0.14);
  playBell(260, 0.9, 0.22, 0.3);
}

// Called once from a real user-gesture handler (pointerdown) to unlock audio
// on browsers that block AudioContext until a gesture occurs. Safe to call
// repeatedly.
export function unlockAudio() {
  getCtx();
}
