#!/usr/bin/env node
// Build the static, solver-calibrated Rush Hour dataset ONCE.
//
// First-tier benchmarks ship a fixed, versioned task set (SWE-bench, Terminal-
// Bench). Regenerating per run wastes compute and breaks fingerprint stability.
// This script generates calibrated boards offline, writes tasks/rush/dataset.json
// with a dataset fingerprint, and the runner loads from there.
//
// Usage: node scripts/build-rush-dataset.mjs [--seeds 120] [--min-depth 8]

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { generateRush } from '../tasks/rush/generate.mjs';
import { taskFingerprint } from '../tasks/core/generate.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
const seeds = arg('--seeds', 150);
const minDepth = arg('--min-depth', 8);
const vehicles = arg('--vehicles', 10);

/**
 * Pin vehicles that never move again after their last optimal move. Their final
 * position is therefore guaranteed at the end of the oracle, so the constraint
 * is satisfiable while still forcing the agent to keep it true.
 */
function deriveMilestones(board, solution) {
  const lastMove = new Map();
  solution.forEach((m, i) => lastMove.set(m.id, i));
  const sim = board.map((v) => ({ ...v }));
  const snapshots = [];
  for (const m of solution) {
    const v = sim.find((x) => x.id === m.id);
    if (v.orient === 'H') v.col += m.delta; else v.row += m.delta;
    snapshots.push(sim.map((x) => ({ ...x })));
  }
  const milestones = [];
  for (const [id, idx] of lastMove) {
    if (id === 'X') continue;              // X is the goal, already constrained
    if (idx >= solution.length - 1) continue; // moved on the final step: pinned by the goal
    const final = snapshots[snapshots.length - 1].find((v) => v.id === id);
    const earlier = snapshots[idx].find((v) => v.id === id);
    if (final.row !== earlier.row || final.col !== earlier.col) continue;
    milestones.push({ id, row: final.row, col: final.col, revealAt: idx + 2 });
  }
  // Keep it readable and monotone in reveal order.
  return milestones.slice(0, 3).sort((a, b) => a.revealAt - b.revealAt);
}

const tasks = [];
const t0 = Date.now();
for (let seed = 1; seed <= seeds; seed++) {
  // Generate the base (off) board; obligation variants are derived at load time
  // from the same board so difficulty is identical across the ablation.
  const r = generateRush({ seed, minDepth, vehicles, obligation: 'off', attempts: 80 });
  if (!r) continue;
  tasks.push({
    seed,
    board: r.task.rush.board,
    solution: r.task.rush.solution,
    // Milestone constraints are derived from the optimal path and are
    // SATISFIABLE BY CONSTRUCTION: we only pin a vehicle that the optimal
    // solution has already moved for the last time, so its post-move position
    // still holds in the final state. Publishing them makes the family carry
    // more than one accumulating rule instead of a single terminal condition.
    milestones: deriveMilestones(r.task.rush.board, r.task.rush.solution),
    meta: r.meta,
    fingerprint: createHash('sha256').update(JSON.stringify(r.task.rush.board)).digest('hex'),
  });
  if (tasks.length % 10 === 0) {
    console.error(`  ${seed}/${seeds} seeds → ${tasks.length} kept (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
}

const depths = tasks.map((t) => t.meta.optimalDepth).sort((a, b) => a - b);
const dataset = {
  name: 'vigil-rush',
  version: '1.0.0',
  generatedAt: new Date().toISOString(),
  calibration: {
    solver: 'optimal BFS over slide moves',
    minDepth,
    greedyMustFail: true,
    vehicles,
  },
  stats: {
    seedsTried: seeds,
    tasksKept: tasks.length,
    yieldRate: tasks.length / seeds,
    depthMin: depths[0],
    depthMedian: depths[Math.floor(depths.length / 2)],
    depthMax: depths[depths.length - 1],
    allDefeatGreedy: tasks.every((t) => !t.meta.greedySolved),
  },
  tasks,
};
dataset.fingerprint = createHash('sha256').update(JSON.stringify(tasks.map((t) => t.fingerprint))).digest('hex');

const outDir = join(ROOT, 'tasks', 'rush');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'dataset.json'), JSON.stringify(dataset, null, 2));
console.log(`\nwrote tasks/rush/dataset.json`);
console.log(`  ${tasks.length}/${seeds} tasks kept (yield ${(dataset.stats.yieldRate * 100).toFixed(0)}%)`);
console.log(`  optimal depth min/median/max: ${depths[0]}/${dataset.stats.depthMedian}/${depths[depths.length - 1]}`);
console.log(`  all defeat greedy: ${dataset.stats.allDefeatGreedy}`);
console.log(`  dataset fingerprint: ${dataset.fingerprint.slice(0, 16)}`);
console.log(`  elapsed: ${((Date.now() - t0) / 1000).toFixed(0)}s`);