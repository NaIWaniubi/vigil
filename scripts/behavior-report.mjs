#!/usr/bin/env node
// Behavioural signature report.
//
// Why this exists: pass/fail hides HOW an agent fails. This report computes, per
// model, the shape of the trajectory:
//
//   turns          total decision points
//   legalMoves     validated board moves actually applied
//   illegalMoves   moves rejected by the board (or forbidden actions attempted)
//   noops          explicit "do nothing" actions
//   waste          (noops + illegal) / turns      -- paid for, produced nothing
//   efficiency     legalMoves / optimalDepth      -- 1.0 = optimal, >1 = wandering
//
// The last two are the thrashing signature. Measured on the committed reference
// bundle: winners waste 9% of turns at 1.77x optimal; losers waste 41% at 2.63x
// and never arrive. These are means -- one committed loss (rush-d9-deadline-s3)
// is a 66-turn budget exhaustion with ZERO waste, so "losses thrash" is a
// tendency, not a law. A pass/fail table cannot show any of this; this can.
//
// IMPORTANT honesty note: `neglected` attribution is NOT used here. With a single
// terminal constraint, every move that does not touch the goal's read-set is
// classified `neglected`, which is close to tautological. Waste and efficiency
// are computed from the action log directly and do not depend on that label.
//
// Usage:
//   node scripts/behavior-report.mjs <run-dir> [--out docs/behavior.json]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const args = process.argv.slice(2);
const runDir = resolve(args.find((a) => !a.startsWith('--')) ?? 'docs/reference-run');
const outIdx = args.indexOf('--out');
const outPath = resolve(outIdx >= 0 ? args[outIdx + 1] : join(ROOT, 'docs', 'behavior.json'));

const resultsPath = join(runDir, 'results.jsonl');
if (!existsSync(resultsPath)) {
  console.error(`no results.jsonl in ${runDir}`);
  process.exit(1);
}

const rows = readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

const scoreable = rows.filter((r) => r.status === 'completed' || r.status === 'turn_cap');

/** Optimal depth comes from the task bundle if present, else the config. */
function optimalDepth(row) {
  const p = join(runDir, `${row.taskId}.task.json`);
  if (existsSync(p)) {
    try {
      const t = JSON.parse(readFileSync(p, 'utf8'));
      return t.task?.meta?.optimalDepth ?? t.oracle?.length ?? null;
    } catch { /* fall through */ }
  }
  return row.config?.depth ?? null;
}

function signature(row) {
  const log = row.actionLog ?? [];
  const turns = row.turns?.length ?? log.length;
  const legalMoves = log.filter((a) => a.ok && a.action?.type === '__rush_sync').length;
  const illegal = row.profile?.illegalMoves ?? log.filter((a) => a.action?.type === '__illegal_move').length;
  const noops = log.filter((a) => a.action?.type === 'noop').length;
  const optimum = optimalDepth(row);
  const waste = turns ? (noops + illegal) / turns : 0;
  return {
    turns,
    legalMoves,
    illegal,
    noops,
    waste,
    optimum,
    efficiency: optimum && legalMoves ? legalMoves / optimum : null,
    won: row.terminal?.reason === 'goal_met',
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const byModel = new Map();
for (const r of scoreable) {
  const k = r.model ?? 'unknown';
  if (!byModel.has(k)) byModel.set(k, []);
  byModel.get(k).push({ row: r, sig: signature(r) });
}

function summarise(entries) {
  const wins = entries.filter((e) => e.sig.won);
  const losses = entries.filter((e) => !e.sig.won);
  const pick = (arr, f) => arr.map((e) => f(e.sig)).filter((v) => v !== null);
  const block = (arr) => ({
    n: arr.length,
    turnsMean: mean(pick(arr, (s) => s.turns)),
    turnsMedian: median(pick(arr, (s) => s.turns)),
    legalMean: mean(pick(arr, (s) => s.legalMoves)),
    illegalMean: mean(pick(arr, (s) => s.illegal)),
    noopMean: mean(pick(arr, (s) => s.noops)),
    wasteMean: mean(pick(arr, (s) => s.waste)),
    efficiencyMedian: median(pick(arr, (s) => s.efficiency)),
    efficiencyMax: pick(arr, (s) => s.efficiency).length ? Math.max(...pick(arr, (s) => s.efficiency)) : null,
  });
  return { all: block(entries), wins: block(wins), losses: block(losses) };
}

const report = {
  generatedAt: new Date().toISOString(),
  run: runDir.replace(ROOT, '.').replace(/\\/g, '/'),
  cells: rows.length,
  scoreable: scoreable.length,
  definition: {
    waste: '(noops + illegalMoves) / turns — paid turns that produced nothing',
    efficiency: 'legalMoves / optimalDepth — 1.0 means it solved in the shortest path',
    note: 'computed from the action log, NOT from the `neglected` attribution label',
  },
  models: [...byModel.entries()].map(([model, entries]) => ({ model, ...summarise(entries) })),
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

const pct = (x) => (x === null ? '—' : `${(x * 100).toFixed(0)}%`);
const num = (x, d = 1) => (x === null ? '—' : x.toFixed(d));

console.log(`behaviour report · ${report.scoreable}/${report.cells} scoreable cells from ${report.run}\n`);
for (const m of report.models) {
  console.log(`${m.model}`);
  console.log(`  wins   n=${m.wins.n}  turns ${num(m.wins.turnsMean)}  legal ${num(m.wins.legalMean)}  waste ${pct(m.wins.wasteMean)}  efficiency ${num(m.wins.efficiencyMedian, 2)}x`);
  console.log(`  losses n=${m.losses.n}  turns ${num(m.losses.turnsMean)}  legal ${num(m.losses.legalMean)}  waste ${pct(m.losses.wasteMean)}  efficiency ${num(m.losses.efficiencyMedian, 2)}x`);
  if (m.wins.n && m.losses.n) {
    const gap = m.losses.wasteMean - m.wins.wasteMean;
    console.log(`  waste gap (loss − win): ${gap >= 0 ? '+' : ''}${pct(gap)}`);
  }
  console.log('');
}
const md = [
  '# Behavioural signature',
  '',
  `Run: \`${report.run}\` · ${report.scoreable}/${report.cells} scoreable cells`,
  '',
  '| model | outcome | n | turns | legal moves | illegal | noop | waste | efficiency |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...report.models.flatMap((m) => ['wins', 'losses'].map((k) => {
    const b = m[k];
    return `| ${m.model} | ${k} | ${b.n} | ${num(b.turnsMean)} | ${num(b.legalMean)} | ${num(b.illegalMean)} | ${num(b.noopMean)} | ${pct(b.wasteMean)} | ${num(b.efficiencyMedian, 2)}x |`;
  })),
  '',
  '`waste` = (noop + illegal)/turns. `efficiency` = legalMoves/optimalDepth (1.0 = shortest path).',
  'Both are computed from the action log, not from the `neglected` label — that label is',
  'near-tautological for a single terminal constraint and is deliberately not used here.',
  '',
].join('\n');
writeFileSync(join(dirname(outPath), 'behavior.md'), md);
console.log(`wrote ${outPath.replace(ROOT, '.')} and behaviour table markdown`);