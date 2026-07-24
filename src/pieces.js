// Fracture — piece and shard shape definitions.
// Engine-agnostic (no DOM). Coordinates are [row, col] offsets from a shape's
// own top-left origin (min row/col == 0).
//
// NOTE: piece *set* (which polyominoes exist, at what weight) is not specified
// by the design doc — Section 1 says the core loop is "inherited from Block
// Blast, unchanged" but the doc does not enumerate a shape list. This is a
// gray-box implementation decision, not a deviation from Sections 2-3 (the
// locked spec), and is called out in the build report.

export const BOARD_SIZE = 8;

// Standard genre convention (Block Blast / 1010! / Woodoku, cited as direct
// precedent in the design doc): pieces are placed as-is, no rotation control
// for the player. Rotational variants are pre-baked as separate shapes below.
export const SHAPES = [
  { id: 'mono', weight: 6, cells: [[0, 0]] },

  { id: 'domino_h', weight: 8, cells: [[0, 0], [0, 1]] },
  { id: 'domino_v', weight: 8, cells: [[0, 0], [1, 0]] },

  { id: 'tromino_h', weight: 6, cells: [[0, 0], [0, 1], [0, 2]] },
  { id: 'tromino_v', weight: 6, cells: [[0, 0], [1, 0], [2, 0]] },

  { id: 'tetromino_h', weight: 3, cells: [[0, 0], [0, 1], [0, 2], [0, 3]] },
  { id: 'tetromino_v', weight: 3, cells: [[0, 0], [1, 0], [2, 0], [3, 0]] },

  { id: 'penta_h', weight: 1, cells: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]] },
  { id: 'penta_v', weight: 1, cells: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]] },

  { id: 'square2', weight: 6, cells: [[0, 0], [0, 1], [1, 0], [1, 1]] },
  { id: 'square3', weight: 1, cells: [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]] },

  { id: 'L1', weight: 4, cells: [[0, 0], [1, 0], [2, 0], [2, 1]] },
  { id: 'L2', weight: 4, cells: [[0, 0], [0, 1], [1, 0], [2, 0]] },
  { id: 'L3', weight: 4, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  { id: 'L4', weight: 4, cells: [[0, 1], [1, 1], [2, 0], [2, 1]] },

  { id: 'T', weight: 4, cells: [[0, 0], [0, 1], [0, 2], [1, 1]] },
  { id: 'Tv', weight: 4, cells: [[0, 0], [1, 0], [1, 1], [2, 0]] },

  { id: 'S', weight: 4, cells: [[0, 1], [0, 2], [1, 0], [1, 1]] },
  { id: 'Z', weight: 4, cells: [[0, 0], [0, 1], [1, 1], [1, 2]] },

  { id: 'corner', weight: 5, cells: [[0, 0], [0, 1], [1, 0]] },
];

// Shard shapes: "shape-generic ... fragments, not copies of the original
// piece" (Section 2) + "size capped at 1-2 cells". Only monominoes and
// dominoes qualify.
export const SHARD_SHAPES = [
  { id: 'shard_mono', cells: [[0, 0]] },
  { id: 'shard_domino_h', cells: [[0, 0], [0, 1]] },
  { id: 'shard_domino_v', cells: [[0, 0], [1, 0]] },
];

export const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c'];

export function weightedPick(list, rng) {
  const total = list.reduce((s, x) => s + x.weight, 0);
  let roll = rng() * total;
  for (const item of list) {
    if (roll < item.weight) return item;
    roll -= item.weight;
  }
  return list[list.length - 1];
}

export function pick(list, rng) {
  return list[Math.floor(rng() * list.length)];
}
