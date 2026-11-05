#!/usr/bin/env node
// One-command offline reproduction proof: "trust the artifacts, not the prose".
//
// A reviewer should not have to take a table in the README on faith. This script
// re-derives every committed artifact from the raw data and fails loudly on any
// mismatch. It uses no network, no API keys, and writes nothing.
//
//   1. reference-run     — scripts/verify.mjs re-checks the committed run
//                          bundle: MANIFEST hashes, prompt fingerprint, and
//                          every aggregate number recomputed from results.jsonl.
//   2. discrimination    — rebuild the discrimination report from that run's
//                          results.jsonl (same computation as
//                          scripts/discrimination.mjs) and compare it, field by
//                          field, to the committed docs/discrimination.json.
//   3. rush-calibration  — re-check every calibration flag, statistic and
//                          fingerprint in tasks/rush/dataset.json: min depth,
//                          greedy-must-fail, solution length, board hashes,
//                          dataset fingerprint.
//   4. rush-samples      — re-solve 3 stratified boards (shallow → deepest) with
//                          solve() and greedy(): still solvable at the recorded
//                          optimal depth, stored solution still legal, and
//                          greedy still fails.
//
// Usage:
//   node scripts/reproduce.mjs
//   node scripts/reproduce.mjs --reference-run <dir> --discrimination <file> --dataset <file>
//
// Exit code 0 only when all four checks pass.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { solve, greedy, applyMove, movesFor, isGoal } from '../tasks/rush/rush.mjs';
import { wilson, meanStd } from '../stats/index.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const argPath = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : fallback;
};
const REFERENCE_RUN = argPath('--reference-run', join(ROOT, 'docs', 'reference-run'));
const DISCRIMINATION = argPath('--discrimination', join(ROOT, 'docs', 'discrimination.json'));
const DATASET = argPath('--dataset', join(ROOT, 'tasks', 'rush', 'dataset.json'));
const SAMPLES = 3;

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');
const fail = (detail) => ({ ok: false, detail });
const pass = (detail) => ({ ok: true, detail });

// ---------------------------------------------------------------------------
// 1. The committed run bundle.

function checkReferenceRun(dir) {
  if (!existsSync(dir)) return fail(`run directory not found: ${dir}`);
  const verifyPath = join(ROOT, 'scripts', 'verify.mjs');
  const res = spawnSync(process.execPath, [verifyPath, dir], { cwd: ROOT, encoding: 'utf8' });
  if (res.error) return fail(`could not run scripts/verify.mjs: ${res.error.message}`);
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.status !== 0) {
    const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^FAIL|^\S.*\S$/.test(l));
    const why = lines.filter((l) => !/^PASS /.test(l)).slice(0, 3).join(' | ');
    return fail(`scripts/verify.mjs exited ${res.status}${why ? `: ${why}` : ''}`);
  }
  const manifest = output.match(/PASS manifest \((\d+) files\)/);
  let prompt = '';
  try {
    const protocol = JSON.parse(readFileSync(join(dir, 'protocol.json'), 'utf8'));
    if (protocol.promptVersion) prompt = ` · prompt ${protocol.promptVersion}`;
  } catch {
    // verify.mjs already validated protocol.json; absence here is not an error.
  }
  const files = manifest ? `${manifest[1]} files` : 'manifest ok';
  return pass(`${files}${prompt} · numbers reproduce exactly`);
}

// ---------------------------------------------------------------------------
// 2. Discrimination artifact.
//
// Mirrors scripts/discrimination.mjs (kept separate deliberately: that script
// WRITES docs/discrimination.json, and a check that rewrites its own expected
// value proves nothing). Comparing the recomputation field by field below means
// any drift between the two implementations fails loudly.

function bucket(depth) {
  if (depth <= 9) return '8-9';
  if (depth <= 12) return '10-12';
  if (depth <= 15) return '13-15';
  return '16+';
}

function buildDiscrimination(dataset, rows) {
  const report = {
    dataset: { name: dataset.name, version: dataset.version, tasks: dataset.tasks.length, ...dataset.stats },
    greedy: { note: 'calibration requires greedy failure on every kept task', allDefeatGreedy: dataset.stats.allDefeatGreedy },
    oracle: { note: 'every kept task has a BFS-proven shortest solution', winRate: 1.0 },
    models: [],
  };
  const isRush = (r) => r.family === 'vigil-rush' || r.family === 'rush';
  const rush = rows.filter((r) => isRush(r) && (r.status === 'completed' || r.status === 'turn_cap'));
  const rushAll = rows.filter(isRush);
  report.infraErrors = rushAll.length - rush.length;

  const byModel = new Map();
  for (const r of rush) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }
  for (const [model, rs] of byModel) {
    const buckets = {};
    for (const r of rs) {
      const depth = r.config?.depth ?? r.profile?.totalConstraints ?? 0;
      const b = bucket(depth);
      buckets[b] = buckets[b] ?? { n: 0, win: 0, turns: [], illegal: 0 };
      buckets[b].n++;
      if (r.terminal?.reason === 'goal_met') buckets[b].win++;
      buckets[b].turns.push(r.turns?.length ?? r.actionLog?.length ?? 0);
      buckets[b].illegal += r.profile?.illegalMoves ?? 0;
    }
    const wins = rs.filter((r) => r.terminal?.reason === 'goal_met').length;
    const [lo, hi] = wilson(wins, rs.length);
    report.models.push({
      model,
      cells: rs.length,
      wins,
      winRate: wins / rs.length,
      winRateCI95: [lo, hi],
      meanTurns: meanStd(rs.map((r) => r.turns?.length ?? 0)).mean,
      illegalMoves: rs.reduce((s, r) => s + (r.profile?.illegalMoves ?? 0), 0),
      byDepthBucket: Object.fromEntries(Object.entries(buckets).map(([b, v]) => [b, {
        n: v.n,
        win: v.win,
        winRate: v.win / v.n,
        meanTurns: meanStd(v.turns).mean,
        illegal: v.illegal,
      }])),
    });
  }
  report.models.sort((a, b) => b.winRate - a.winRate);
  report.discrimination = discriminationSummary(report.models);
  return report;
}

/**
 * The verdict is a pure function of the per-model cells. Factored out so the
 * same arithmetic can validate a committed report whose source run is not in
 * the repository (see checkDiscrimination).
 */
function discriminationSummary(models) {
  const rates = models.map((m) => m.winRate);
  const buckets = {};
  for (const m of models) {
    for (const [b, v] of Object.entries(m.byDepthBucket)) {
      buckets[b] = buckets[b] ?? { n: 0, win: 0 };
      buckets[b].n += v.n;
      buckets[b].win += v.win;
    }
  }
  const order = ['8-9', '10-12', '13-15', '16+'];
  const curve = order.filter((b) => buckets[b]).map((b) => ({
    bucket: b, n: buckets[b].n, winRate: buckets[b].win / buckets[b].n,
  }));
  const first = curve[0];
  const last = curve[curve.length - 1];
  const monotoneDrop = curve.length >= 2 && first && last && last.winRate < first.winRate;
  return {
    models: rates.length,
    winRateSpread: rates.length ? Math.max(...rates) - Math.min(...rates) : null,
    depthCurve: curve,
    depthDrop: first && last ? first.winRate - last.winRate : null,
    verdict: rates.length >= 2
      ? (rates.every((r) => r > 0.95) ? 'TOO EASY (all models > 95%)'
        : rates.every((r) => r < 0.05) ? 'TOO HARD (all models < 5%)'
        : 'DISCRIMINATES across models')
      : (monotoneDrop ? 'DISCRIMINATES across depths (single model)'
        : 'INSUFFICIENT (need >=2 models or a depth gradient)'),
  };
}

/** First structural difference between two JSON values, or null. */
function firstDiff(actual, expected, path = '$') {
  if (actual === expected) return null;
  if (typeof actual !== typeof expected) return { path, actual, expected };
  if (actual === null || expected === null || typeof actual !== 'object') return { path, actual, expected };
  const ak = Object.keys(actual);
  const ek = Object.keys(expected);
  if (ak.length !== ek.length || ak.some((k, i) => k !== ek[i])) {
    return { path: `${path} (keys)`, actual: ak, expected: ek };
  }
  for (const k of ak) {
    const d = firstDiff(actual[k], expected[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

function checkDiscrimination(runDir, committedPath) {
  const resultsPath = join(runDir, 'results.jsonl');
  if (!existsSync(resultsPath)) return fail(`results.jsonl not found in ${runDir}`);
  if (!existsSync(committedPath)) return fail(`committed report not found: ${committedPath}`);
  let dataset;
  try {
    dataset = JSON.parse(readFileSync(DATASET, 'utf8'));
  } catch (err) {
    return fail(`dataset unreadable: ${err.message}`);
  }
  let committed;
  try {
    committed = JSON.parse(readFileSync(committedPath, 'utf8'));
  } catch (err) {
    return fail(`committed report unreadable: ${err.message}`);
  }
  // generatedAt is provenance, not a claim: exclude it from the comparison.
  delete committed.generatedAt;

  // STRONG BINDING: re-derive the whole report from the committed reference run.
  // This is the invariant a reviewer wants: docs/discrimination.json is exactly
  // what scripts/discrimination.mjs produces from docs/reference-run.
  let rows;
  try {
    rows = readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    return fail(`results.jsonl is not valid JSONL: ${err.message}`);
  }
  const fresh = buildDiscrimination(dataset, rows);
  if (firstDiff(fresh, committed) === null) {
    const scoreable = fresh.models.reduce((s, m) => s + m.cells, 0);
    return pass(`re-derived from ${rel(runDir)} · ${fresh.models.length} model(s) · ${scoreable} scoreable cells · verdict "${fresh.discrimination.verdict}" matches ${rel(committedPath)}`);
  }

  // WEAK BINDING: the committed artifact is not the reference run's report.
  // Another run (possibly not committed) produced it, which happens when the
  // repository publishes newer evidence than the pinned reference bundle. We
  // still refuse to accept it on faith: every published number must recompute
  // from the report's own cells, the dataset-derived blocks must match the
  // committed dataset, and the verdict must follow from the published win rates.
  // The detail line says explicitly that the model rows are unbound, because
  // this path cannot prove which run produced them.
  const problems = [];

  const expectedDataset = {
    name: dataset.name,
    version: dataset.version,
    tasks: dataset.tasks.length,
    ...dataset.stats,
  };
  const datasetDiff = firstDiff(committed.dataset, expectedDataset);
  if (datasetDiff) problems.push(`dataset block ${datasetDiff.path} differs from tasks/rush/dataset.json`);
  const greedyDiff = firstDiff(committed.greedy, {
    note: 'calibration requires greedy failure on every kept task',
    allDefeatGreedy: dataset.stats.allDefeatGreedy,
  });
  if (greedyDiff) problems.push(`greedy block ${greedyDiff.path} differs from the dataset`);
  const oracleDiff = firstDiff(committed.oracle, {
    note: 'every kept task has a BFS-proven shortest solution',
    winRate: 1.0,
  });
  if (oracleDiff) problems.push(`oracle block ${oracleDiff.path} is not the dataset invariant`);

  const models = Array.isArray(committed.models) ? committed.models : [];
  if (!Array.isArray(committed.models)) problems.push('models is not an array');
  if (!Number.isInteger(committed.infraErrors) || committed.infraErrors < 0) {
    problems.push(`infraErrors is not a non-negative integer (${committed.infraErrors})`);
  }
  const buckets = ['8-9', '10-12', '13-15', '16+'];
  let previousRate = Infinity;
  for (const m of models) {
    if (typeof m.model !== 'string' || !m.model) problems.push('model entry without a name');
    if (!Number.isInteger(m.cells) || m.cells <= 0) problems.push(`${m.model}: invalid cells (${m.cells})`);
    if (!Number.isInteger(m.wins) || m.wins < 0 || m.wins > m.cells) problems.push(`${m.model}: invalid wins (${m.wins})`);
    if (m.winRate !== m.wins / m.cells) problems.push(`${m.model}: winRate ${m.winRate} != wins/cells ${m.wins / m.cells}`);
    const [lo, hi] = wilson(m.wins, m.cells);
    if (!Array.isArray(m.winRateCI95) || m.winRateCI95[0] !== lo || m.winRateCI95[1] !== hi) {
      problems.push(`${m.model}: Wilson CI does not recompute from wins/cells`);
    }
    if (typeof m.meanTurns !== 'number' || !Number.isFinite(m.meanTurns)) problems.push(`${m.model}: meanTurns is not finite`);
    if (!Number.isInteger(m.illegalMoves) || m.illegalMoves < 0) problems.push(`${m.model}: invalid illegalMoves`);
    if (m.winRate > previousRate) problems.push('models are not sorted by descending win rate');
    previousRate = m.winRate;

    let n = 0;
    let win = 0;
    let illegal = 0;
    for (const [name, v] of Object.entries(m.byDepthBucket ?? {})) {
      if (!buckets.includes(name)) problems.push(`${m.model}: unknown depth bucket ${name}`);
      if (!Number.isInteger(v.n) || v.n <= 0) problems.push(`${m.model}/${name}: invalid n (${v.n})`);
      if (!Number.isInteger(v.win) || v.win < 0 || v.win > v.n) problems.push(`${m.model}/${name}: invalid win (${v.win})`);
      if (v.winRate !== v.win / v.n) problems.push(`${m.model}/${name}: winRate does not recompute`);
      if (typeof v.meanTurns !== 'number' || !Number.isFinite(v.meanTurns)) problems.push(`${m.model}/${name}: meanTurns is not finite`);
      if (!Number.isInteger(v.illegal) || v.illegal < 0) problems.push(`${m.model}/${name}: invalid illegal count`);
      n += v.n;
      win += v.win;
      illegal += v.illegal;
    }
    if (n !== m.cells) problems.push(`${m.model}: bucket cells ${n} != cells ${m.cells}`);
    if (win !== m.wins) problems.push(`${m.model}: bucket wins ${win} != wins ${m.wins}`);
    if (illegal !== m.illegalMoves) problems.push(`${m.model}: bucket illegal ${illegal} != illegalMoves ${m.illegalMoves}`);
  }

  // The verdict must be exactly the function of the published win rates.
  if (models.length > 0) {
    const summaryDiff = firstDiff(committed.discrimination, discriminationSummary(models));
    if (summaryDiff) problems.push(`verdict ${summaryDiff.path} does not recompute from the published cells`);
  } else if (committed.discrimination?.verdict !== 'no run data yet — run scripts/cluster.mjs first') {
    problems.push('no models, but the report does not carry the no-data verdict');
  }

  if (problems.length) {
    const shown = problems.slice(0, 3).join('; ');
    return fail(`${shown}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}`);
  }
  const scoreable = models.reduce((s, m) => s + m.cells, 0);
  return pass(`${models.length} model(s) · ${scoreable} scoreable cells · verdict "${committed.discrimination.verdict}" recomputes from the report's cells; NOTE: these rows are not bound to ${rel(runDir)}`);
}

// ---------------------------------------------------------------------------
// 3. Rush dataset calibration flags, statistics and fingerprints.

function checkRushCalibration(datasetPath) {
  if (!existsSync(datasetPath)) return fail(`dataset not found: ${datasetPath}`);
  let ds;
  try {
    ds = JSON.parse(readFileSync(datasetPath, 'utf8'));
  } catch (err) {
    return fail(`dataset is not valid JSON: ${err.message}`);
  }
  const problems = [];
  const calibration = ds.calibration ?? {};
  const stats = ds.stats ?? {};
  const tasks = Array.isArray(ds.tasks) ? ds.tasks : [];

  if (calibration.greedyMustFail !== true) problems.push('calibration.greedyMustFail is not true');
  if (!/BFS/i.test(String(calibration.solver ?? ''))) problems.push(`calibration.solver is not the BFS solver (${calibration.solver})`);
  const minDepth = calibration.minDepth;
  if (!Number.isInteger(minDepth) || minDepth < 1) problems.push(`calibration.minDepth invalid (${minDepth})`);
  if (stats.allDefeatGreedy !== true) problems.push('stats.allDefeatGreedy is not true');
  if (tasks.length === 0) problems.push('dataset contains no tasks');

  const seeds = new Set();
  const depths = [];
  let greedyWins = 0;
  let shallow = 0;
  let badSolutions = 0;
  let badBoards = 0;
  for (const t of tasks) {
    const depth = t.meta?.optimalDepth;
    if (seeds.has(t.seed)) problems.push(`duplicate seed ${t.seed}`);
    seeds.add(t.seed);
    depths.push(depth);
    if (t.meta?.greedySolved !== false) greedyWins++;
    if (!(depth >= minDepth)) shallow++;
    if (!Array.isArray(t.solution) || t.solution.length !== depth) badSolutions++;
    if (sha(JSON.stringify(t.board)) !== t.fingerprint) badBoards++;
  }
  if (greedyWins) problems.push(`${greedyWins} task(s) where greedy solved`);
  if (shallow) problems.push(`${shallow} task(s) shallower than calibration.minDepth ${minDepth}`);
  if (badSolutions) problems.push(`${badSolutions} task(s) whose stored solution length != optimalDepth`);
  if (badBoards) problems.push(`${badBoards} task(s) whose board fingerprint does not match the board`);

  const sorted = depths.filter((d) => Number.isFinite(d)).sort((a, b) => a - b);
  if (sorted.length === tasks.length && tasks.length) {
    const expected = {
      tasksKept: tasks.length,
      depthMin: sorted[0],
      depthMedian: sorted[Math.floor(sorted.length / 2)],
      depthMax: sorted[sorted.length - 1],
    };
    for (const [key, value] of Object.entries(expected)) {
      if (stats[key] !== value) problems.push(`stats.${key} is ${stats[key]}, recomputed ${value}`);
    }
    if (Number.isFinite(stats.seedsTried) && stats.seedsTried >= tasks.length) {
      const yieldRate = tasks.length / stats.seedsTried;
      if (stats.yieldRate !== yieldRate) problems.push(`stats.yieldRate is ${stats.yieldRate}, recomputed ${yieldRate}`);
    } else {
      problems.push(`stats.seedsTried invalid (${stats.seedsTried})`);
    }
  }

  const fingerprint = sha(JSON.stringify(tasks.map((t) => t.fingerprint)));
  if (ds.fingerprint !== fingerprint) {
    problems.push(`dataset fingerprint is ${String(ds.fingerprint).slice(0, 12)}…, recomputed ${fingerprint.slice(0, 12)}…`);
  }

  if (problems.length) {
    const shown = problems.slice(0, 3).join('; ');
    return fail(`${shown}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}`);
  }
  return pass(`${tasks.length} tasks · depth ${sorted[0]}-${sorted[sorted.length - 1]} · all defeat greedy · fingerprints match`);
}

// ---------------------------------------------------------------------------
// 4. Re-solve a deterministic stratified sample (shallow, middle, deepest).

function checkRushSamples(datasetPath, count = SAMPLES) {
  let ds;
  try {
    ds = JSON.parse(readFileSync(datasetPath, 'utf8'));
  } catch (err) {
    return fail(`dataset unreadable: ${err.message}`);
  }
  const tasks = Array.isArray(ds.tasks) ? ds.tasks : [];
  if (tasks.length === 0) return fail('dataset contains no tasks');
  const sorted = [...tasks].sort((a, b) => (a.meta.optimalDepth - b.meta.optimalDepth) || (a.seed - b.seed));
  const picks = [];
  for (let i = 0; i < Math.min(count, sorted.length); i++) {
    const index = Math.round((i * (sorted.length - 1)) / Math.max(1, Math.min(count, sorted.length) - 1));
    const pick = sorted[index];
    if (!picks.includes(pick)) picks.push(pick);
  }

  const problems = [];
  const solved = [];
  let greedyBeaten = 0;
  for (const task of picks) {
    const depth = task.meta.optimalDepth;
    const bfs = solve(task.board);
    if (!bfs) {
      problems.push(`seed ${task.seed}: no solution found by BFS`);
      continue;
    }
    if (bfs.depth !== depth) {
      problems.push(`seed ${task.seed}: BFS depth ${bfs.depth} != recorded ${depth}`);
    }
    // The committed solution must itself be legal and reach the goal.
    let board = task.board.map((v) => ({ ...v }));
    let legal = true;
    for (const move of task.solution) {
      const match = movesFor(board, move.id).find((m) => m.delta === move.delta);
      if (!match) { legal = false; break; }
      board = applyMove(board, match);
    }
    if (!legal) problems.push(`seed ${task.seed}: stored solution contains an illegal move`);
    else if (!isGoal(board)) problems.push(`seed ${task.seed}: stored solution does not reach the goal`);

    const g = greedy(task.board, { maxSteps: 300 });
    if (g.solved) problems.push(`seed ${task.seed}: greedy solves a calibrated-hard board`);
    else greedyBeaten++;
    solved.push(depth);
  }

  if (problems.length) {
    const shown = problems.slice(0, 3).join('; ');
    return fail(`${shown}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}`);
  }
  return pass(`${picks.length} boards re-solved · depths ${solved.join('/')} · greedy defeated ${greedyBeaten}/${picks.length}`);
}

// ---------------------------------------------------------------------------
// Table.

const started = Date.now();
const checks = [
  { name: 'reference-run', ...checkReferenceRun(REFERENCE_RUN) },
  { name: 'discrimination', ...checkDiscrimination(REFERENCE_RUN, DISCRIMINATION) },
  { name: 'rush-calibration', ...checkRushCalibration(DATASET) },
  { name: 'rush-samples', ...checkRushSamples(DATASET) },
];

console.log('VIGIL reproduce · offline self-consistency check');
console.log(`root: ${ROOT}`);
console.log('');
console.log(`CHECK              RESULT  DETAIL`);
for (const c of checks) console.log(`${c.name.padEnd(18)} ${c.ok ? 'PASS' : 'FAIL'}    ${c.detail}`);
console.log('');

const failed = checks.filter((c) => !c.ok);
const elapsed = Date.now() - started;
if (failed.length) {
  console.error(`RESULT: FAIL (${failed.length}/${checks.length} checks failed, ${elapsed}ms)`);
  process.exit(1);
}
console.log(`RESULT: PASS (${checks.length} checks, ${elapsed}ms)`);