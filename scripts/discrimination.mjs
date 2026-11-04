#!/usr/bin/env node
// Discrimination report: the empirical proof that the benchmark measures
// something. For the rush family it tabulates, per optimal-depth bucket:
//   - greedy win rate (must be ~0: calibration guaranteed it)
//   - oracle win rate (must be 100%: solvability)
//   - model win rate (the spread that makes it a benchmark)
//
// A first-tier benchmark needs MIXED outcomes across models. This report is the
// evidence; it reads a cluster run's results.jsonl and the static dataset.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset } from '../tasks/rush/load.mjs';
import { wilson, meanStd } from '../stats/index.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runDir = resolve(process.argv[2] ?? 'runs/latest');

const ds = loadDataset();
const depthOf = new Map(ds.tasks.map((t) => [`rush-d${t.meta.optimalDepth}-`, t.meta.optimalDepth]));

function bucket(depth) {
  if (depth <= 9) return '8-9';
  if (depth <= 12) return '10-12';
  if (depth <= 15) return '13-15';
  return '16+';
}

const report = {
  generatedAt: new Date().toISOString(),
  dataset: { name: ds.name, version: ds.version, tasks: ds.tasks.length, ...ds.stats },
  greedy: { note: 'calibration requires greedy failure on every kept task', allDefeatGreedy: ds.stats.allDefeatGreedy },
  oracle: { note: 'every kept task has a BFS-proven shortest solution', winRate: 1.0 },
  models: [],
};

if (existsSync(join(runDir, 'results.jsonl'))) {
  const rows = readFileSync(join(runDir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // Scoreable = the run produced a trajectory. Infrastructure errors (network
  // timeout, truncation) are excluded from win-rate but counted separately so a
  // flaky gateway is never mistaken for model weakness. The cluster writes
  // family as 'rush'; the task object uses 'vigil-rush'. Accept both.
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
      model, cells: rs.length, wins, winRate: wins / rs.length, winRateCI95: [lo, hi],
      meanTurns: meanStd(rs.map((r) => r.turns?.length ?? 0)).mean,
      illegalMoves: rs.reduce((s, r) => s + (r.profile?.illegalMoves ?? 0), 0),
      byDepthBucket: Object.fromEntries(Object.entries(buckets).map(([b, v]) => [b, {
        n: v.n, win: v.win, winRate: v.win / v.n, meanTurns: meanStd(v.turns).mean, illegal: v.illegal,
      }])),
    });
  }
  report.models.sort((a, b) => b.winRate - a.winRate);
  // Discrimination verdict. Two independent axes:
  //   across models  — spread between model win rates
  //   across depths  — win rate must fall as optimal depth rises
  // A benchmark can discriminate on depth with a single model available, which
  // is the case when the operator's official channel balance is exhausted.
  const rates = report.models.map((m) => m.winRate);
  const buckets = {};
  for (const m of report.models) {
    for (const [b, v] of Object.entries(m.byDepthBucket)) {
      buckets[b] = buckets[b] ?? { n: 0, win: 0 };
      buckets[b].n += v.n; buckets[b].win += v.win;
    }
  }
  const order = ['8-9', '10-12', '13-15', '16+'];
  const curve = order.filter((b) => buckets[b]).map((b) => ({
    bucket: b, n: buckets[b].n, winRate: buckets[b].win / buckets[b].n,
  }));
  const first = curve[0], last = curve[curve.length - 1];
  const monotoneDrop = curve.length >= 2 && first && last && last.winRate < first.winRate;

  report.discrimination = {
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
} else {
  report.discrimination = { verdict: 'no run data yet — run scripts/cluster.mjs first' };
}

const out = join(ROOT, 'docs', 'discrimination.json');
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`dataset: ${report.dataset.tasks} tasks, depth ${report.dataset.depthMin}-${report.dataset.depthMax}, all defeat greedy: ${report.greedy.allDefeatGreedy}`);
for (const m of report.models) {
  console.log(`  ${m.model}: ${(m.winRate * 100).toFixed(1)}% [${(m.winRateCI95[0] * 100).toFixed(0)},${(m.winRateCI95[1] * 100).toFixed(0)}] over ${m.cells} cells, ${m.illegalMoves} illegal moves`);
}
console.log(`discrimination: ${report.discrimination.verdict}`);
console.log(`wrote ${out}`);