# Art direction — decision trail

## Scoping pass (game-asset-director)
Confirmed: game is currently 100% code-drawn canvas (`ctx.fillStyle`/`roundRect` in `src/main.js`) — no image/sprite pipeline exists. Real art assets are a pipeline addition, not a reskin.

Three style proposals:
- **A — Glass/Crystal Shard.** Gradient + clip-path faceted look, shards get a cracked/angular silhouette tinted to the triggering piece. Strongest thematic tie to "shard"/"Fracture," pure canvas 2D (no new pipeline). Risk: linework can turn to mush at ~30px mobile cell size if overdone.
- **B — Flat Geometric** (genre-standard, Block Blast/1010! convention). Refined flat fills, shards get an actually distinct silhouette instead of the current near-identical-to-a-mono-piece-plus-label. Lowest cost/risk, least differentiated.
- **C — Rendered mineral-chip sprites** (Woodoku-style). Highest ceiling, requires building a sprite/atlas pipeline that doesn't exist yet, real production time, risks rework since no platform/engine is decided.

**Decision: B, then A, then C — approved, not just accepted by default.** B isolates and validates the silhouette-legibility question (do shards read as distinct fragments of a whole) in the cheapest treatment, before compounding it with A's added visual complexity, which carries its own flagged legibility risk. Testing one variable before stacking a second. C stays gated on a platform/engine decision that hasn't been made — correctly deferred, not silently dropped.

**Tooling (accepted as scoped):** Color Oracle/Coblis for palette audit before locking anything; Kenney.nl (CC0) for supplementary icons on B; Blender/Meshy+TexturePacker if C is ever greenlit; Affinity Designer/Figma over Aseprite (not a pixel-art direction). Licensing treated as commercial from day one (Section 6's monetization scope) — avoid CC-BY-NC.

**Platform/engine: still explicitly open, correctly not assumed by game-asset-director.** B and A are pure canvas 2D and portable regardless of final platform; this only matters for C, which is already gated behind a platform decision for that reason. Not resolving it now — no need to, nothing is blocked on it yet.

## Colorblind findings (flagged during scoping, not new scope — cheap to fix while this code is already being touched)
- Existing 7-color palette (`src/pieces.js` `COLORS`) has red and green both present — classic deuteranopia/protanopia confusion pair. Needs an actual Color Oracle/Coblis-verified fix, not an eyeballed hex swap.
- The drag drop-preview valid/invalid indicator is currently color-only — same gap class as the overflow-tray-slot indicator already fixed with a non-color glyph. Recommend the same pattern here.
- **Sequencing:** audit (game-asset-director) → specific replacement values → implementation (game-debugger). Not blocking B's silhouette work; runs alongside it.

## Style B + colorblind fixes — RESOLVED, independently re-verified
Implemented directly (not just proposed) by game-asset-director: `drawShardChip` in `src/main.js` gives shard cells a distinct irregular angular silhouette (deterministic per-shape+cell jitter, two-tone facet shading, visible gaps between adjacent shard cells) — confirmed visually distinct from same-shaped regular pieces at all three real render scales, including the smallest (18px tray subcell) where the old text-label fallback was the only differentiator before. Colorblind audit used the real Machado et al. (2009) CVD matrices with CIE76 ΔE pass/fail, not eyeballing — found 3 real collision pairs nobody had flagged (green/teal tritanopia ΔE=5.96, blue/purple deuteranopia ΔE=12.34, red/orange deuteranopia ΔE=17.38; the red/green pair actually named in the brief was fine at ΔE 21-32). New 7-color palette holds every pairwise ΔE >= ~28 across normal + all 3 CVD types, with an L*>=37 lightness floor for legibility against the dark board.

**Independent re-verification (project-manager):** reimplemented the Machado 2009 matrices and CIE76 ΔE calculation from scratch (not reusing their code) — results matched almost exactly (red/green min 21.58 vs. claimed 21-32; blue/purple deuteranopia 12.34, exact match; red/orange deuteranopia 17.38, exact match; green/teal tritanopia 6.19 vs. claimed 5.96). New palette's worst pair came out to ΔE=28.27, matching the claimed threshold; lightness floor confirmed at L*=37.4 minimum. 21/21 tests re-run and passing. Visually confirmed via a fresh-load screenshot (new palette colors render correctly in the live page) and game-asset-director's own preview harness (`tools/playtest-sim/` sibling scratchpad artifact — distinct shard silhouette confirmed at all 3 real scales, drop-preview checkmark/X glyph confirmed matching the existing overflow-slot border+glyph pattern).

One flagged question resolved (not a gap): shard visual identity is lost once a piece is placed on the board (post-placement cells only store `{color}}`, no shard flag persists). Correct as shipped — the design need was always pre-placement comprehension (queue/tray/drag), not permanent on-board marking; a placed shard becoming ordinary board-fill is the intended behavior, not an oversight.

## Status
- [x] B (flat geometric, distinct shard silhouettes) — done, independently re-verified.
- [x] Colorblind palette audit + drop-preview non-color cue — done, independently re-verified.
- [ ] Implementation-ownership pass (game-debugger) — dispatched, light-touch given no gameplay-logic surface touched.
- [ ] A (glass/crystal identity pass) — gated on B, which has now validated legibility at mobile scale. Ready to schedule when desired.
- [ ] C (rendered sprites) — gated on both A and a platform/engine decision, still open.
