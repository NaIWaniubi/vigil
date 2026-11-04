// Rush-Hour sliding-block puzzles as a long-horizon agent task.
//
// Why this family exists: the previous vigil-core gadgets were INDEPENDENT —
// solve slot 1, move on. That is a recipe, not a search problem, and an 80%
// win-rate benchmark measures nothing. Rush Hour is the canonical hard
// long-horizon puzzle: the target car cannot reach the exit until blocking
// vehicles are shuffled out of the way, often by moving them BACKWARDS first.
// It is NP-hard in general, has a finite well-defined state space, and admits an
// optimal BFS solver — so every task ships a PROVABLY shortest solution and a
// measured difficulty, not a hand-waved one.
//
// Board: 6x6 grid. Vehicles occupy contiguous cells and slide only along their
// orientation. The target vehicle (id 'X') is horizontal on row 2 and wins by
// reaching the right edge (the exit). All other vehicles are obstacles.

export const SIZE = 6;
export const EXIT_ROW = 2;

/** A vehicle: { id, row, col, len, orient: 'H'|'V' }. H slides col, V slides row. */
export function cellsOf(v) {
  const cells = [];
  for (let i = 0; i < v.len; i++) {
    cells.push(v.orient === 'H' ? [v.row, v.col + i] : [v.row + i, v.col]);
  }
  return cells;
}

export function boardKey(vehicles) {
  // Positions only, in id order — orientation/length are fixed per puzzle.
  return vehicles.map((v) => `${v.id}:${v.row},${v.col}`).join('|');
}

export function occupancy(vehicles, ignoreId = null) {
  const grid = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  for (const v of vehicles) {
    if (v.id === ignoreId) continue;
    for (const [r, c] of cellsOf(v)) grid[r][c] = v.id;
  }
  return grid;
}

/** Legal moves for one vehicle: slide k cells in either direction (k>=1). */
export function movesFor(vehicles, id) {
  const v = vehicles.find((x) => x.id === id);
  const grid = occupancy(vehicles, id);
  const moves = [];
  const dir = v.orient === 'H' ? [0, 1] : [1, 0];
  for (const sign of [-1, 1]) {
    for (let k = 1; k < SIZE; k++) {
      // The leading cell after sliding k steps must be free and in bounds.
      const lead = v.orient === 'H'
        ? [v.row, v.col + (sign > 0 ? v.len - 1 + k : -k)]
        : [v.row + (sign > 0 ? v.len - 1 + k : -k), v.col];
      const [r, c] = lead;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) break;
      if (grid[r][c] !== null) break;
      moves.push({ id, delta: sign * k });
    }
  }
  return moves;
}

export function applyMove(vehicles, move) {
  return vehicles.map((v) => {
    if (v.id !== move.id) return { ...v };
    return v.orient === 'H'
      ? { ...v, col: v.col + move.delta }
      : { ...v, row: v.row + move.delta };
  });
}

export function isGoal(vehicles) {
  const x = vehicles.find((v) => v.id === 'X');
  // Win when the target's right end reaches the exit column.
  return x.orient === 'H' && x.row === EXIT_ROW && x.col + x.len === SIZE;
}

/**
 * Optimal BFS solver. Returns { moves, depth, states } or null if unsolvable.
 * Each "move" slides one vehicle any distance (standard Rush Hour metric).
 * Bounded by maxStates to keep generation tractable.
 */
export function solve(vehicles, { maxStates = 400_000 } = {}) {
  if (isGoal(vehicles)) return { moves: [], depth: 0, states: 1 };
  const start = vehicles.map((v) => ({ ...v }));
  const queue = [{ vehicles: start, moves: [] }];
  const seen = new Set([boardKey(start)]);
  let head = 0;
  let states = 1;
  while (head < queue.length) {
    const { vehicles: cur, moves } = queue[head++];
    for (const v of cur) {
      for (const move of movesFor(cur, v.id)) {
        const next = applyMove(cur, move);
        const key = boardKey(next);
        if (seen.has(key)) continue;
        seen.add(key);
        states++;
        const nextMoves = [...moves, move];
        if (isGoal(next)) return { moves: nextMoves, depth: nextMoves.length, states };
        if (states > maxStates) return null;
        queue.push({ vehicles: next, moves: nextMoves });
      }
    }
  }
  return null;
}

/**
 * Greedy baseline: repeatedly move the target toward the exit if possible;
 * otherwise move the first vehicle that blocks it, in the direction that frees
 * the target's path; otherwise make any legal move. No lookahead, no memory.
 * This is the policy a naive agent approximates; hard tasks must defeat it.
 */
export function greedy(vehicles, { maxSteps = 200 } = {}) {
  let cur = vehicles.map((v) => ({ ...v }));
  const moves = [];
  const seen = new Set();
  for (let step = 0; step < maxSteps; step++) {
    if (isGoal(cur)) return { solved: true, moves, steps: step };
    const key = boardKey(cur);
    if (seen.has(key)) return { solved: false, moves, steps: step, reason: 'loop' };
    seen.add(key);
    const x = cur.find((v) => v.id === 'X');
    const grid = occupancy(cur, 'X');
    // Cells between X's right end and the exit.
    const blockers = new Set();
    for (let c = x.col + x.len; c < SIZE; c++) {
      if (grid[EXIT_ROW][c]) blockers.add(grid[EXIT_ROW][c]);
    }
    let chosen = null;
    if (blockers.size === 0) {
      // Path clear: slide X to the exit.
      chosen = { id: 'X', delta: SIZE - (x.col + x.len) };
    } else {
      // Try to move a blocker out of row 2.
      for (const bid of blockers) {
        const cand = movesFor(cur, bid).filter((m) => {
          const next = applyMove(cur, m);
          const b = next.find((v) => v.id === bid);
          // Does the blocker still occupy the exit row in X's path?
          return !cellsOf(b).some(([r, c]) => r === EXIT_ROW && c >= x.col + x.len);
        });
        if (cand.length) { chosen = cand[0]; break; }
      }
    }
    if (!chosen) {
      // No progress move: take the first legal move (flails).
      outer: for (const v of cur) {
        const ms = movesFor(cur, v.id);
        if (ms.length) { chosen = ms[0]; break outer; }
      }
    }
    if (!chosen) return { solved: false, moves, steps: step, reason: 'stuck' };
    cur = applyMove(cur, chosen);
    moves.push(chosen);
  }
  return { solved: false, moves, steps: maxSteps, reason: 'budget' };
}