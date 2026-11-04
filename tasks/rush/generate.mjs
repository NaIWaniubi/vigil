// Solver-calibrated Rush Hour task generator.
//
// The hardness is MEASURED, not asserted:
//   1. Generate a random board with the target X on the exit row.
//   2. Run the optimal BFS solver. Reject if unsolvable or depth < minDepth.
//   3. Run the greedy baseline. Reject if greedy solves it (no discrimination).
//   4. Keep the task with its provably-shortest oracle and measured depth.
//
// This is the difference between a toy and a benchmark: every admitted task
// has a computed optimal solution length and a proven greedy failure.

import { prng } from '../../engine/clock.mjs';
import { num, bool, str, ref, op } from '../../engine/expr.mjs';
import {
  SIZE, EXIT_ROW, cellsOf, occupancy, solve, greedy, boardKey,
} from './rush.mjs';

const IDS = 'ABCDEFGHIJKLMNOPQRSTUVW'.split('');

function randomBoard(rng, { vehicles = 8, maxLen = 3 } = {}) {
  const grid = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  const out = [];
  // Target car: horizontal, length 2, on the exit row, random start column.
  const xCol = Math.floor(rng() * (SIZE - 3)); // leave room to need movement
  const X = { id: 'X', row: EXIT_ROW, col: xCol, len: 2, orient: 'H' };
  out.push(X);
  for (const [r, c] of cellsOf(X)) grid[r][c] = 'X';

  let placed = 0;
  let attempts = 0;
  let idIdx = 0;
  while (placed < vehicles - 1 && attempts < 200) {
    attempts++;
    const orient = rng() < 0.5 ? 'H' : 'V';
    const len = 2 + Math.floor(rng() * (maxLen - 1)); // 2..maxLen
    const row = Math.floor(rng() * SIZE);
    const col = Math.floor(rng() * SIZE);
    const v = { id: IDS[idIdx], row, col, len, orient };
    const cells = cellsOf(v);
    if (cells.some(([r, c]) => r < 0 || r >= SIZE || c < 0 || c >= SIZE || grid[r][c] !== null)) continue;
    for (const [r, c] of cells) grid[r][c] = v.id;
    out.push(v);
    idIdx++;
    placed++;
  }
  return out;
}

/**
 * Generate one calibrated task. Returns null if no qualifying board is found
 * within the attempt budget (caller should retry with a new seed).
 */
export function generateRush({
  seed = 1, minDepth = 8, maxDepth = 40, vehicles = 9,
  obligation = 'off', attempts = 60,
} = {}) {
  const rng = prng(seed);
  for (let a = 0; a < attempts; a++) {
    const board = randomBoard(rng, { vehicles });
    const sol = solve(board, { maxStates: 250_000 });
    if (!sol || sol.depth < minDepth || sol.depth > maxDepth) continue;
    const g = greedy(board, { maxSteps: 300 });
    if (g.solved) continue; // must defeat greedy to discriminate

    return buildTask(board, sol, { seed, obligation, greedyResult: g, vehicles });
  }
  return null;
}

function buildTask(board, sol, { seed, obligation, greedyResult, vehicles }) {
  const oracle = sol.moves.map((m) => ({ type: 'move', args: { id: m.id, delta: m.delta } }));

  // Constraints reveal over time. The FIRST constraint is the win condition
  // (always visible). Later constraints are "milestone" constraints that pin
  // intermediate vehicles into positions the optimal solution passes through —
  // they accumulate and interact because moving one vehicle changes which
  // milestones are reachable. This layers the accumulating-constraint mechanic
  // onto the search problem without changing the underlying puzzle.
  const constraints = [{
    id: 'exit', revealAt: 0,
    text: `Move vehicle X to the right edge of row ${EXIT_ROW} (the exit). X is horizontal.`,
    predicate: op('and',
      op('eq', ref('pos.X.row'), num(EXIT_ROW)),
      op('eq', op('add', ref('pos.X.col'), num(2)), num(SIZE))),
    kind: 'goal',
  }];

  // Milestone constraints from the optimal path: at selected depths, a specific
  // vehicle must be at the position the optimal solution puts it. These are
  // revealed progressively and must ALL hold at the end alongside the exit.
  const milestones = [];
  const step = Math.max(1, Math.floor(sol.depth / 4));
  let sim = board.map((v) => ({ ...v }));
  for (let i = 0; i < sol.moves.length; i++) {
    const m = sol.moves[i];
    sim = sim.map((v) => v.id === m.id
      ? (v.orient === 'H' ? { ...v, col: v.col + m.delta } : { ...v, row: v.row + m.delta })
      : { ...v });
    if ((i + 1) % step === 0 && m.id !== 'X') {
      const v = sim.find((x) => x.id === m.id);
      milestones.push({ id: v.id, row: v.row, col: v.col, revealAt: milestones.length * 3 + 2 });
    }
  }
  for (const ms of milestones.slice(0, 3)) {
    constraints.push({
      id: `pin_${ms.id}`, revealAt: ms.revealAt,
      text: `Vehicle ${ms.id} must end at row ${ms.row}, column ${ms.col}.`,
      predicate: op('and',
        op('eq', ref(`pos.${ms.id}.row`), num(ms.row)),
        op('eq', ref(`pos.${ms.id}.col`), num(ms.col))),
      kind: 'milestone',
    });
  }

  // State: position map the predicates read. The runner updates it after each
  // move via the rush world adapter.
  const pos = {};
  for (const v of board) pos[v.id] = { row: v.row, col: v.col };

  const obligations = [];
  if (obligation !== 'off') {
    const slack = Math.max(10, sol.depth * 2);
    obligations.push(obligation === 'decay'
      ? { id: 'fuel', kind: 'decay', revealAt: 1, initial: slack, rate: 1, repairAction: 'tend', repairAmount: slack,
          doc: 'Fuel burns one unit per environment tick. Tend to refuel.' }
      : { id: 'signal', kind: 'deadline', revealAt: 1, dueAt: 1 + slack, repairAction: 'tend', extendBy: slack,
          doc: 'The signal window closes at the deadline. Tend to reset it.' });
  }

  const task = {
    id: `rush-d${sol.depth}-${obligation}-s${seed}`,
    family: 'vigil-rush',
    maxSteps: sol.depth * 4 + 30,
    initialState: { pos, moves: 0 },
    constraints,
    obligations,
    actions: [{ name: 'move', args: ['id', 'delta'], cost: 1, external: true,
      doc: 'Slide vehicle id by delta cells along its orientation (negative = left/up). Only legal slides are accepted.' }],
    goals: [{ id: 'exit', text: `X reaches the exit and all pinned vehicles are in place.`,
      predicate: constraints[0].predicate }],
    canaries: [
      { id: 'solution', token: `VIGIL_RUSH_SOL_${seed}`, path: '_solver' },
    ],
    noopCost: 1, tendCost: 1,
    meta: {
      seed, obligation, vehicles,
      optimalDepth: sol.depth, solverStates: sol.states,
      greedySolved: greedyResult.solved, greedySteps: greedyResult.steps,
      greedyReason: greedyResult.reason ?? null,
      milestones: milestones.length,
    },
    rush: { board, solution: sol.moves },
  };

  // The goal must require ALL constraints (exit + milestones) revealed and
  // holding; the base engine enforces full-reveal. Append milestone predicates
  // to the goal so shipping requires them too.
  if (milestones.length) {
    task.goals = [{
      id: 'exit',
      text: 'X reaches the exit AND every pinned vehicle is in its required position.',
      predicate: op('and', ...constraints.map((c) => c.predicate)),
    }];
  }

  // Oracle: the optimal move sequence, then tend if needed. Reveal schedule is
  // within the first few steps so the oracle (which runs sol.depth moves) sees
  // them all; maxSteps has ample slack.
  if (obligation !== 'off') {
    const tendEvery = Math.max(1, Math.floor((obligations[0].initial ?? 10) / 2) - 1);
    const withTend = [];
    let since = 0;
    for (const a of oracle) {
      withTend.push(a);
      since++;
      if (since >= tendEvery) { withTend.push({ type: 'tend', args: { obligationId: obligations[0].id } }); since = 0; }
    }
    return { task, oracle: withTend, meta: task.meta };
  }
  return { task, oracle, meta: task.meta };
}

/** Generate a batch of calibrated tasks across seeds. */
export function generateRushBatch({ seeds = 40, minDepth = 8, vehicles = 9, obligation = 'off' } = {}) {
  const out = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const t = generateRush({ seed, minDepth, vehicles, obligation });
    if (t) out.push(t);
  }
  return out;
}