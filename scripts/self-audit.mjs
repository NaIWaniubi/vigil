#!/usr/bin/env node
// Evaluator self-audit. Runs BEFORE any model is scored.
//
// Motivation: arXiv 2609.26826 audited 125 zero-pass terminal tasks and found
// 37.6% could not be certified as genuinely hard (broken oracles, bypassable
// verifiers). A benchmark that cannot distinguish "hard" from "broken" is
// measuring its own bugs.
//
// Four checks per task:
//   1. oracle    — the shipped solution must reach goal_met
//   2. lazy      — doing nothing must NOT reach goal_met (task is non-trivial)
//   3. neglect   — ignoring obligations must fail when obligations exist
//   4. determinism — replaying the oracle gives byte-identical records
//
// A task failing any check is QUARANTINED and reported, never silently dropped.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../engine/index.mjs';
import { generate, grid, taskFingerprint } from '../tasks/core/generate.mjs';
import { generateSwe, MODULES } from '../tasks/swe/generate.mjs';
import { SweWorld } from '../tasks/swe/world.mjs';
import { createHash } from 'node:crypto';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function replay(task, actions, seed) {
  const w = new World(task, { seed });
  for (const a of actions) {
    if (w.done) break;
    w.step(a);
  }
  return w;
}

function auditOne(cfg) {
  const { task, oracle } = generate(cfg);
  const findings = [];

  const solved = replay(task, oracle, cfg.seed);
  if (solved.profile().terminal?.reason !== 'goal_met') {
    findings.push({ check: 'oracle', verdict: 'fail',
      detail: `oracle ended ${JSON.stringify(solved.profile().terminal)}, passed ${solved.passed}/${task.constraints.length}` });
  }

  const lazy = replay(task, Array.from({ length: task.maxSteps }, () => ({ type: 'noop' })), cfg.seed);
  if (lazy.profile().terminal?.reason === 'goal_met') {
    findings.push({ check: 'lazy', verdict: 'fail', detail: 'doing nothing solves the task' });
  }

  if ((task.obligations ?? []).length) {
    // Same oracle work, but never tend. Must die of neglect.
    const noTend = oracle.filter((a) => a.type !== 'tend');
    const neglected = replay(task, noTend, cfg.seed);
    const p = neglected.profile();
    if (p.obligationsDead.length === 0 && p.terminal?.reason === 'goal_met') {
      findings.push({ check: 'neglect', verdict: 'fail',
        detail: 'obligations exist but ignoring them still succeeds' });
    }
  }

  const again = replay(task, oracle, cfg.seed);
  const h = (w) => createHash('sha256').update(JSON.stringify({ r: w.records, p: w.profile() })).digest('hex');
  if (h(solved) !== h(again)) {
    findings.push({ check: 'determinism', verdict: 'fail', detail: 'replay diverged' });
  }

  return {
    taskId: task.id,
    config: cfg,
    family: 'vigil-core',
    fingerprint: createHash('sha256').update(taskFingerprint(task)).digest('hex'),
    checks: ['oracle', 'lazy', ...(task.obligations?.length ? ['neglect'] : []), 'determinism'],
    findings,
    status: findings.length ? 'quarantined' : 'admitted',
    oracleProfile: solved.profile(),
  };
}

async function auditSwe(cfg) {
  const { task, oracle } = generateSwe(cfg);
  const findings = [];
  const replaySwe = async (actions) => {
    const w = await SweWorld.create(task, { seed: cfg.seed });
    for (const a of actions) { if (w.done) break; await w.stepAsync(a); }
    return w;
  };

  const solved = await replaySwe(oracle);
  if (solved.profile().terminal?.reason !== 'goal_met') {
    findings.push({ check: 'oracle', verdict: 'fail',
      detail: `oracle ended ${JSON.stringify(solved.profile().terminal)}, passed ${solved.passed}/${task.constraints.length}` });
  }

  const lazy = await replaySwe(Array.from({ length: task.maxSteps }, () => ({ type: 'noop' })));
  if (lazy.profile().terminal?.reason === 'goal_met') {
    findings.push({ check: 'lazy', verdict: 'fail', detail: 'doing nothing solves the task' });
  }

  if ((task.obligations ?? []).length) {
    const noCi = oracle.filter((a) => a.type !== 'run_ci');
    const neglected = await replaySwe(noCi);
    const p = neglected.profile();
    if (p.obligationsDead.length === 0 && p.terminal?.reason === 'goal_met') {
      findings.push({ check: 'neglect', verdict: 'fail', detail: 'CI watchdog exists but ignoring it still succeeds' });
    }
  }

  const again = await replaySwe(oracle);
  const h = (w) => createHash('sha256').update(JSON.stringify({ r: w.records, p: w.profile(), s: w.state.passed })).digest('hex');
  if (h(solved) !== h(again)) {
    findings.push({ check: 'determinism', verdict: 'fail', detail: 'replay diverged' });
  }

  return {
    taskId: task.id, config: cfg, family: 'vigil-swe',
    fingerprint: createHash('sha256').update(taskFingerprint(task)).digest('hex'),
    checks: ['oracle', 'lazy', ...(task.obligations?.length ? ['neglect'] : []), 'determinism'],
    findings,
    status: findings.length ? 'quarantined' : 'admitted',
    oracleProfile: solved.profile(),
  };
}

const args = new Set(process.argv.slice(2));
const coreConfigs = args.has('--quick')
  ? grid({ seeds: [1, 2], depths: [6, 12] })
  : grid({ seeds: [1, 2, 3, 4, 5], depths: [6, 12, 18, 24] });

const sweConfigs = [];
for (let moduleIndex = 0; moduleIndex < MODULES.length; moduleIndex++) {
  for (const obligation of ['off', 'deadline', 'decay']) {
    for (const seed of args.has('--quick') ? [1] : [1, 2, 3]) {
      sweConfigs.push({ moduleIndex, depth: 5, obligation, seed });
    }
  }
}

// Rush family: the solver-calibrated dataset. Audit a sample (or all) of the
// stored boards across obligation variants. The oracle is the BFS shortest
// solution; greedy must fail (calibration guaranteed it, the audit re-proves it).
async function auditRush(cfg) {
  const { generateRushFromConfig } = await import('../tasks/rush/load.mjs');
  const { RushWorld } = await import('../tasks/rush/world.mjs');
  const { greedy } = await import('../tasks/rush/rush.mjs');
  const { task, oracle } = generateRushFromConfig(cfg);
  const findings = [];
  const replay = (actions) => {
    const w = RushWorld.create(task, { seed: cfg.seed });
    for (const a of actions) { if (w.done) break; w.step(a); }
    return w;
  };
  const solved = replay(oracle);
  if (solved.profile().terminal?.reason !== 'goal_met') {
    findings.push({ check: 'oracle', verdict: 'fail', detail: `oracle ended ${JSON.stringify(solved.profile().terminal)}` });
  }
  const g = greedy(task.rush.board, { maxSteps: task.maxSteps });
  if (g.solved) {
    findings.push({ check: 'discrimination', verdict: 'fail', detail: 'greedy solves a calibrated-hard task' });
  }
  const lazy = replay(Array.from({ length: task.maxSteps }, () => ({ type: 'noop' })));
  if (lazy.profile().terminal?.reason === 'goal_met') {
    findings.push({ check: 'lazy', verdict: 'fail', detail: 'doing nothing solves the task' });
  }
  const again = replay(oracle);
  const h = (w) => createHash('sha256').update(JSON.stringify({ r: w.records, p: w.profile() })).digest('hex');
  if (h(solved) !== h(again)) {
    findings.push({ check: 'determinism', verdict: 'fail', detail: 'replay diverged' });
  }
  return {
    taskId: task.id, config: { seed: cfg.seed, obligation: cfg.obligation, depth: cfg.depth }, family: 'vigil-rush',
    fingerprint: createHash('sha256').update(taskFingerprint(task)).digest('hex'),
    checks: ['oracle', 'discrimination', 'lazy', 'determinism'],
    findings, status: findings.length ? 'quarantined' : 'admitted',
    oracleProfile: solved.profile(),
    optimalDepth: cfg.depth,
  };
}

let rushResults = [];
try {
  const { rushConfigs } = await import('../tasks/rush/load.mjs');
  const allRush = rushConfigs({ obligations: ['off', 'decay', 'deadline'] });
  const sample = args.has('--quick') ? allRush.filter((c) => c.obligation === 'off').slice(0, 8) : allRush;
  rushResults = await Promise.all(sample.map(auditRush));
} catch (e) {
  if (!String(e.message).includes('dataset.json missing')) throw e;
  console.error('note: rush dataset not built; skipping rush audit (run scripts/build-rush-dataset.mjs)');
}

const results = [
  ...coreConfigs.map(auditOne),
  ...(await Promise.all(sweConfigs.map(auditSwe))),
  ...rushResults,
];
const admitted = results.filter((r) => r.status === 'admitted');
const quarantined = results.filter((r) => r.status === 'quarantined');

const report = {
  generatedAt: new Date().toISOString(),
  tool: 'vigil self-audit v0.1.0',
  total: results.length,
  admitted: admitted.length,
  quarantined: quarantined.length,
  brokenTaskRate: results.length ? quarantined.length / results.length : 0,
  results,
};

if (!args.has('--no-write')) {
  const dir = join(ROOT, 'docs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'self-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
}

console.log(`self-audit: ${results.length} tasks, ${admitted.length} admitted, ${quarantined.length} quarantined`);
for (const q of quarantined) {
  console.error(`QUARANTINE ${q.taskId}`);
  for (const f of q.findings) console.error(`  ${f.check}: ${f.detail}`);
}
if (quarantined.length) {
  console.error(`SELF-AUDIT: FAIL (${quarantined.length} broken tasks)`);
  process.exit(1);
}
console.log('SELF-AUDIT: PASS — every admitted task has a working oracle, is non-trivial, and replays exactly');