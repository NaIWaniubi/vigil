#!/usr/bin/env node
// Statistical report for a VIGIL run directory.
//
// The leaderboard question is "which model is better". The prerequisite
// question is "could this run tell?". This script answers both and writes a
// JSON + markdown pair named stats-report.json / stats-report.md.
//
// Output location:
//   - inside <run-dir> by default;
//   - <out-dir>/stats-report.* when --out-dir is given;
//   - docs/stats/<run-basename>/ when the run is a sealed bundle carrying
//     MANIFEST.sha256, because its verifier rejects any unlisted file.
//
// Inputs: <run-dir>/results.jsonl and, when present, <run-dir>/report.json.
// Win rate = goal_met among scoreable cells (completed | turn_cap). Infra
// errors are excluded, never counted as losses.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilson } from '../stats/index.mjs';
import {
  bootstrapCI,
  bootstrapDiffCI,
  holmBonferroni,
  minNForEffect,
  powerTwoProportions,
  twoProportionPValue,
} from '../stats/inference.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const USAGE = 'usage: node scripts/stats-report.mjs <run-dir> [--iterations N] [--alpha A] [--out-dir DIR]';
const EFFECT = Object.freeze({ p1: 0.3, p2: 0.6 });
const TARGET_POWER = 0.8;

function die(message) {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv) {
  let runDir = null;
  let outDir = null;
  let iterations = 10000;
  let alpha = 0.05;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--iterations') {
      iterations = Number(argv[++i]);
      if (!Number.isInteger(iterations) || iterations < 1) {
        die(`--iterations must be a positive integer\n${USAGE}`);
      }
    } else if (arg === '--alpha') {
      alpha = Number(argv[++i]);
      if (!(alpha > 0 && alpha < 1)) die(`--alpha must be in (0,1)\n${USAGE}`);
    } else if (arg === '--out-dir') {
      outDir = argv[++i];
      if (!outDir) die(`--out-dir needs a path\n${USAGE}`);
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith('-')) {
      die(`unknown option: ${arg}\n${USAGE}`);
    } else if (runDir === null) {
      runDir = arg;
    } else {
      die(`unexpected argument: ${arg}\n${USAGE}`);
    }
  }
  if (!runDir) die(USAGE);
  return { runDir: resolve(runDir), outDir: outDir ? resolve(outDir) : null, iterations, alpha };
}

function readRows(path) {
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A torn tail after a crash must not void the cells that did land.
    }
  }
  return rows;
}

const isScoreable = (r) => r.status === 'completed' || r.status === 'turn_cap';
const isWin = (r) => r.terminal?.reason === 'goal_met';
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** FNV-1a: stable per-model/per-pair seed so every bootstrap is reproducible. */
function seedFor(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h || 1;
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const ciText = (arr) => `[${pct(arr[0])}, ${pct(arr[1])}]`;
const fmtP = (p) => (p < 0.001 ? p.toExponential(2) : p.toFixed(4));

const { runDir, outDir: explicitOutDir, iterations, alpha } = parseArgs(process.argv.slice(2));
const resultsPath = join(runDir, 'results.jsonl');
if (!existsSync(resultsPath)) {
  die(`no results.jsonl in ${runDir}\n${USAGE}`);
}
const rows = readRows(resultsPath);
if (rows.length === 0) die(`results.jsonl has no parseable rows: ${resultsPath}`);

// A sealed bundle's MANIFEST covers every file in the directory, so derived
// sidecars must not land inside it. Redirect to a per-run directory next to
// the bundle unless the caller chose an output directory explicitly.
const slug = basename(runDir).replace(/[^a-zA-Z0-9._-]/g, '_');
const hasManifest = existsSync(join(runDir, 'MANIFEST.sha256'));
const outDir = explicitOutDir ?? (hasManifest ? join(ROOT, 'docs', 'stats', slug) : runDir);

const byModel = new Map();
for (const r of rows) {
  const key = r.model ?? '(unknown)';
  if (!byModel.has(key)) byModel.set(key, { attempted: 0, outcomes: [] });
  const group = byModel.get(key);
  group.attempted++;
  if (isScoreable(r)) group.outcomes.push(isWin(r) ? 1 : 0);
}
const allModelNames = [...byModel.keys()];
const emptyModels = [...byModel.entries()]
  .filter(([, g]) => g.outcomes.length === 0)
  .map(([model, g]) => ({ model, attempted: g.attempted }));

const models = [...byModel.entries()]
  .filter(([, g]) => g.outcomes.length > 0)
  .map(([model, g]) => {
    const n = g.outcomes.length;
    const wins = g.outcomes.reduce((a, b) => a + b, 0);
    const [wLo, wHi] = wilson(wins, n);
    const boot = bootstrapCI(g.outcomes, mean, {
      iterations, alpha, seed: seedFor(`model:${model}`),
    });
    return {
      model,
      n,
      wins,
      winRate: wins / n,
      wilsonCI95: [wLo, wHi],
      bootstrapCI95: [boot.lo, boot.hi],
      excludedInfraErrors: g.attempted - n,
      outcomes: g.outcomes,
    };
  })
  .sort((a, b) => b.winRate - a.winRate || a.model.localeCompare(b.model));

const pairwise = [];
if (models.length >= 2) {
  const rawP = [];
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const a = models[i];
      const b = models[j];
      const diff = bootstrapDiffCI(a.outcomes, b.outcomes, {
        iterations, alpha, seed: seedFor(`pair:${a.model}|${b.model}`),
      });
      const p = twoProportionPValue({ winsA: a.wins, nA: a.n, winsB: b.wins, nB: b.n });
      rawP.push(p);
      pairwise.push({
        a: a.model,
        b: b.model,
        nA: a.n,
        nB: b.n,
        winRateA: a.winRate,
        winRateB: b.winRate,
        delta: diff.point,
        bootstrapCI95: [diff.lo, diff.hi],
        pValue: p,
        holmAdjusted: null,
        significant: false,
      });
    }
  }
  const adjusted = holmBonferroni(rawP);
  pairwise.forEach((pair, i) => {
    pair.holmAdjusted = adjusted[i];
    pair.significant = adjusted[i] < alpha;
  });
}

const requiredN = minNForEffect({ ...EFFECT, alpha, power: TARGET_POWER });
const ns = models.map((m) => m.n);
const bestSampledN = ns.length ? Math.max(...ns) : 0;
// For a cross-model claim the weakest link is the smaller group; with a single
// model, that model's n is the whole story.
const achievedN = ns.length ? (models.length >= 2 ? Math.min(...ns) : bestSampledN) : 0;
const powerAtAchievedN = achievedN > 0
  ? powerTwoProportions({ ...EFFECT, n: achievedN, alpha })
  : null;
const verdict = models.length === 0
  ? 'no_data'
  : achievedN < requiredN ? 'underpowered' : 'adequately_powered';

let reportJson = null;
if (existsSync(join(runDir, 'report.json'))) {
  try {
    reportJson = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'));
  } catch {
    reportJson = null;
  }
}
const protocol = reportJson?.protocol
  ? {
    promptVersion: reportJson.protocol.promptVersion,
    engineVersion: reportJson.protocol.engineVersion,
    temperature: reportJson.protocol.temperature,
    reps: reportJson.protocol.reps,
    family: reportJson.protocol.family,
    targets: (reportJson.protocol.targets ?? []).map((t) => t.model),
  }
  : null;
const publishedRaw = (reportJson?.profiles ?? []).filter((p) => p.track === 'raw');
const publishedMismatches = [];
for (const m of models) {
  const published = publishedRaw.find((p) => p.model === m.model);
  if (!published) continue;
  if (published.cells !== m.n || published.wins !== m.wins) {
    publishedMismatches.push({
      model: m.model,
      published: { cells: published.cells, wins: published.wins },
      recomputed: { cells: m.n, wins: m.wins },
    });
  }
}

const cellCounts = new Map();
for (const r of rows.filter(isScoreable)) {
  const key = `${r.taskId}|${r.model}`;
  cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
}
const cellsWithRepeats = [...cellCounts.values()].filter((c) => c > 1).length;
const scoreable = models.reduce((s, m) => s + m.n, 0);
const dataQuality = {
  rows: rows.length,
  scoreable,
  infraErrors: rows.length - scoreable,
  modelsInRun: allModelNames.length,
  modelsScoreable: models.length,
  modelsWithNoScoreable: emptyModels,
  cellsWithRepeats,
  families: [...new Set(rows.map((r) => r.family).filter(Boolean))],
};

const notes = [];
if (dataQuality.infraErrors > 0) {
  notes.push(`${dataQuality.infraErrors} of ${dataQuality.rows} rows were infrastructure failures; they are excluded from win rates, not scored as losses.`);
}
if (emptyModels.length > 0) {
  notes.push(`${emptyModels.map((m) => m.model).join(', ')} produced zero scoreable cells (${emptyModels.map((m) => m.attempted).join(', ')} attempts). No win rate can be reported for them.`);
}
if (verdict === 'underpowered') {
  notes.push(`Detecting a 30pp effect at ${TARGET_POWER * 100}% power needs ${requiredN} cells per group; this run has ${achievedN}. It cannot support a claim at that effect size.`);
}
for (const m of models) {
  const width = m.wilsonCI95[1] - m.wilsonCI95[0];
  if (width > 0.3) {
    notes.push(`Wilson 95% CI for ${m.model} spans ${ciText(m.wilsonCI95)} (width ${pct(width)}); the point estimate is weakly identified.`);
  }
  if (m.n > 1 && m.bootstrapCI95[0] === m.bootstrapCI95[1]) {
    notes.push(`Bootstrap CI for ${m.model} collapsed to a point (${ciText(m.bootstrapCI95)}) because every resample was identical. At n=${m.n} this is a boundary artifact, not certainty; use the Wilson interval.`);
  }
}
if (pairwise.length > 0 && pairwise.every((p) => !p.significant)) {
  notes.push(`No pairwise difference survives Holm correction at alpha=${alpha}.`);
}
for (const mm of publishedMismatches) {
  notes.push(`report.json disagrees with recomputed counts for ${mm.model}: published ${mm.published.wins}/${mm.published.cells}, recomputed ${mm.recomputed.wins}/${mm.recomputed.cells}.`);
}
if (hasManifest && !explicitOutDir) {
  notes.push(`This run is a sealed bundle (MANIFEST.sha256); stats-report.json/md were written outside it to ${outDir} so scripts/verify.mjs stays valid.`);
} else if (hasManifest && explicitOutDir) {
  notes.push(`Sealed bundle: stats-report.json/md written to the explicit --out-dir ${outDir}.`);
}

const generatedAt = new Date().toISOString();
const out = {
  run: runDir,
  generatedAt,
  bootstrap: {
    iterations,
    alpha,
    seed: 'FNV-1a(model | pair), fixed per group — same run reproduces the same bounds',
  },
  protocol,
  dataQuality,
  models: models.map(({ outcomes, ...rest }) => rest),
  pairwise,
  power: {
    effect: { ...EFFECT, absoluteDifference: EFFECT.p2 - EFFECT.p1 },
    alpha,
    targetPower: TARGET_POWER,
    requiredNPerGroup: requiredN,
    achievedN,
    bestSampledN,
    powerAtAchievedN,
    verdict,
    explanation: verdict === 'underpowered'
      ? `n=${achievedN} < required ${requiredN} per group for a 30pp difference at ${TARGET_POWER * 100}% power`
      : verdict === 'adequately_powered'
        ? `n=${achievedN} >= required ${requiredN} per group for a 30pp difference at ${TARGET_POWER * 100}% power`
        : 'no scoreable cells, so no power statement is possible',
  },
  verdict,
  notes,
  reportJson: {
    found: reportJson !== null,
    publishedMismatches,
  },
};

const md = [];
md.push(`# Statistical report — ${runDir}`, '');
md.push(`Generated: ${generatedAt}`, '');
md.push(`**verdict: ${verdict}**`, '');
md.push('## Data quality', '');
md.push(`- ${dataQuality.scoreable} scoreable cells out of ${dataQuality.rows} rows (${dataQuality.infraErrors} infrastructure errors excluded, never scored as losses).`);
md.push(`- ${dataQuality.modelsInRun} models attempted; ${dataQuality.modelsScoreable} produced scoreable cells.`);
if (emptyModels.length > 0) {
  md.push(`- Zero scoreable cells: ${emptyModels.map((m) => `${m.model} (${m.attempted} attempts)`).join(', ')}.`);
}
md.push(`- Repeated cells (>=2 reps): ${cellsWithRepeats}.`, '');
md.push('## Per-model win rate', '');
if (models.length === 0) {
  md.push('No scoreable cells.');
} else {
  md.push('| model | n | wins | win rate | Wilson 95% | bootstrap 95% |', '|---|---:|---:|---:|---|---|');
  for (const m of models) {
    md.push(`| ${m.model} | ${m.n} | ${m.wins} | ${pct(m.winRate)} | ${ciText(m.wilsonCI95)} | ${ciText(m.bootstrapCI95)} |`);
  }
}
md.push('', '## Pairwise differences', '');
if (pairwise.length === 0) {
  md.push(`Skipped: need at least two models with scoreable cells (found ${models.length}).`);
} else {
  md.push('| a | b | delta | bootstrap 95% | raw p | Holm p | significant |', '|---|---|---:|---|---:|---:|---|');
  for (const p of pairwise) {
    md.push(`| ${p.a} | ${p.b} | ${pct(p.delta)} | ${ciText(p.bootstrapCI95)} | ${fmtP(p.pValue)} | ${fmtP(p.holmAdjusted)} | ${p.significant ? 'yes' : 'no'} |`);
  }
  md.push('', `Delta is win-rate(a) - win-rate(b). Holm-adjusted over ${pairwise.length} comparison(s) at alpha=${alpha}.`);
}
md.push('', '## Power', '');
md.push(`A 30pp effect (${EFFECT.p1.toFixed(2)} vs ${EFFECT.p2.toFixed(2)}) at alpha=${alpha} and ${TARGET_POWER * 100}% power requires **${requiredN} cells per group** (normal approximation, two-sided).`, '');
md.push(`This run's achieved n is **${achievedN}**${models.length >= 2 ? ` (weakest of ${models.length} scoreable models; best-sampled ${bestSampledN})` : ''}. Power at that n for a 30pp effect is **${powerAtAchievedN === null ? 'n/a' : powerAtAchievedN.toFixed(3)}**.`, '');
if (verdict === 'underpowered') {
  md.push(`**verdict: underpowered** — the run cannot distinguish a 30pp difference from noise.`);
}
if (notes.length > 0) {
  md.push('', '## Notes', '');
  for (const n of notes) md.push(`- ${n}`);
}

mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, 'stats-report.json');
const mdPath = join(outDir, 'stats-report.md');
writeFileSync(jsonPath, `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(mdPath, `${md.join('\n')}\n`);

console.log(`run: ${runDir}`);
console.log(`scoreable cells: ${dataQuality.scoreable} / ${dataQuality.rows} (${dataQuality.infraErrors} infrastructure errors excluded)`);
for (const m of models) {
  console.log(`  ${m.model}: ${m.wins}/${m.n} = ${pct(m.winRate)}  Wilson ${ciText(m.wilsonCI95)}  bootstrap ${ciText(m.bootstrapCI95)}`);
}
if (pairwise.length > 0) {
  for (const p of pairwise) {
    console.log(`  ${p.a} - ${p.b}: ${pct(p.delta)}  boot ${ciText(p.bootstrapCI95)}  raw p=${fmtP(p.pValue)}  Holm=${fmtP(p.holmAdjusted)}  ${p.significant ? 'SIGNIFICANT' : 'not significant'}`);
  }
} else {
  console.log('pairwise: skipped (need >= 2 models with scoreable cells)');
}
console.log(`required n per group for a 30pp effect at ${TARGET_POWER * 100}% power: ${requiredN}`);
console.log(`achieved n: ${achievedN}${models.length >= 2 ? ` (best-sampled ${bestSampledN})` : ''}`);
console.log(`power at achieved n: ${powerAtAchievedN === null ? 'n/a' : powerAtAchievedN.toFixed(3)}`);
console.log(`verdict: ${verdict}`);
if (verdict === 'underpowered') {
  console.log('note: this run cannot distinguish a 30pp difference from noise.');
}
console.log(`wrote ${jsonPath}`);
console.log(`wrote ${mdPath}`);
if (hasManifest && !explicitOutDir) {
  console.error(`warning: ${runDir} is a sealed bundle (MANIFEST.sha256); sidecars were written outside it to ${outDir}.`);
}