// Static loader for the solver-calibrated Rush Hour dataset.
//
// The dataset is built ONCE by scripts/build-rush-dataset.mjs and committed.
// Loading is instant and fingerprints are stable across runs — the property a
// versioned benchmark needs. Obligation variants are derived from the same
// board so difficulty is identical across the ablation.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { num, ref, op } from '../../engine/expr.mjs';
import { SIZE, EXIT_ROW } from './rush.mjs';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
let CACHE = null;

export function loadDataset() {
  if (CACHE) return CACHE;
  const path = join(HERE, 'dataset.json');
  if (!existsSync(path)) {
    throw new Error('tasks/rush/dataset.json missing — run: node scripts/build-rush-dataset.mjs');
  }
  CACHE = JSON.parse(readFileSync(path, 'utf8'));
  return CACHE;
}

/** Rebuild a full task from a stored board + solution, with an obligation variant. */
export function taskFromEntry(entry, { obligation = 'off' } = {}) {
  const board = entry.board;
  const solution = entry.solution;
  const depth = entry.meta.optimalDepth;

  const pos = {};
  for (const v of board) pos[v.id] = { row: v.row, col: v.col };

  const constraints = [{
    id: 'exit', revealAt: 0,
    text: `Move vehicle X to the right edge of row ${EXIT_ROW} (the exit). X is horizontal, length 2.`,
    predicate: op('and',
      op('eq', ref('pos.X.row'), num(EXIT_ROW)),
      op('eq', op('add', ref('pos.X.col'), num(2)), num(SIZE))),
    kind: 'goal',
  }];

  // Milestones come from the dataset (see build-rush-dataset.mjs). Each pins a
  // vehicle that the optimal solution has already parked, so it is satisfiable
  // AND it accumulates: once revealed, the agent must keep it true for the rest
  // of the run. Without these the family would ship a single terminal rule.
  for (const ms of entry.milestones ?? []) {
    constraints.push({
      id: `pin_${ms.id}`,
      revealAt: ms.revealAt,
      text: `Vehicle ${ms.id} must stay at row ${ms.row}, column ${ms.col} from now on.`,
      predicate: op('and',
        op('eq', ref(`pos.${ms.id}.row`), num(ms.row)),
        op('eq', ref(`pos.${ms.id}.col`), num(ms.col))),
      kind: 'milestone',
    });
  }
  constraints.sort((a, b) => a.revealAt - b.revealAt || a.id.localeCompare(b.id));

  const obligations = [];
  if (obligation !== 'off') {
    // The budget must be TIGHT enough that ignoring the obligation fails, and
    // loose enough that periodic tending survives. The oracle spends `depth`
    // ticks on moves plus ~1 tick per tend, so:
    //   neglect must die:  slack < depth
    //   tending must live: slack > 2 * tendEvery
    // `depth * 2` satisfied neither (260/260 rush obligation configs won with
    // zero tends -- caught by an external reviewer).
    const slack = Math.max(4, Math.floor(depth * 0.6));
    obligations.push(obligation === 'decay'
      ? { id: 'fuel', kind: 'decay', revealAt: 1, initial: slack, rate: 1, repairAction: 'tend', repairAmount: slack,
          doc: 'Fuel burns one unit per environment tick. Tend to refuel.' }
      : { id: 'signal', kind: 'deadline', revealAt: 1, dueAt: 1 + slack, repairAction: 'tend', extendBy: slack,
          doc: 'The signal window closes at the deadline. Tend to reset it.' });
  }

  const oracle = solution.map((m) => ({ type: 'move', args: { id: m.id, delta: m.delta } }));
  if (obligation !== 'off') {
    // deadline obligations have no `initial`; derive the budget from the
    // window they actually have. Using `initial` here produced NaN for
    // deadline, so the oracle never tended and killed its own run.
    const ob0 = obligations[0];
    const slack = ob0.initial ?? (ob0.dueAt - ob0.revealAt);
    const tendEvery = Math.max(1, Math.floor(slack / 2) - 1);
    // eslint-disable-next-line no-unused-expressions
    const withTend = [];
    let since = 0;
    for (const a of oracle) {
      withTend.push(a); since++;
      if (since >= tendEvery) { withTend.push({ type: 'tend', args: { obligationId: obligations[0].id } }); since = 0; }
    }
    oracle.length = 0;
    oracle.push(...withTend);
  }

  const task = {
    id: `rush-d${depth}-${obligation}-s${entry.seed}`,
    family: 'vigil-rush',
    maxSteps: depth * 4 + 30,
    initialState: { pos, moves: 0 },
    constraints,
    obligations,
    actions: [{ name: 'move', args: ['id', 'delta'], cost: 1, external: true,
      doc: 'Slide vehicle id by delta cells along its orientation (negative = left/up). Only legal slides are accepted.' }],
    goals: [{ id: 'exit', text: 'X reaches the exit.', predicate: constraints[0].predicate }],
    canaries: [{ id: 'solution', token: `VIGIL_RUSH_SOL_${entry.seed}`, path: '_solver' }],
    noopCost: 1, tendCost: 1,
    genericWrites: 'none',
    meta: { ...entry.meta, seed: entry.seed, obligation },
    rush: { board, solution },
  };
  return { task, oracle, meta: task.meta };
}

/** Enumerate configs for the runner: each stored board × obligation variant. */
export function rushConfigs({ obligations = ['off', 'decay', 'deadline'], limit = null } = {}) {
  const ds = loadDataset();
  const configs = [];
  for (const entry of ds.tasks) {
    for (const obligation of obligations) {
      configs.push({ seed: entry.seed, obligation, depth: entry.meta.optimalDepth, entry });
    }
  }
  return limit ? configs.slice(0, limit) : configs;
}

export function generateRushFromConfig(cfg) {
  return taskFromEntry(cfg.entry, { obligation: cfg.obligation });
}