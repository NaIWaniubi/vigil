#!/usr/bin/env node
// Build the public leaderboard from a verified run bundle.
//
// Publishes the capability profile, not a headline score. Every number on the
// page is traceable to report.json, which verify.mjs proves reproduces from
// results.jsonl. The evaluator's own trustworthiness gets equal billing.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = resolve(process.argv[2] ?? 'runs/latest');
if (!existsSync(join(dir, 'report.json'))) {
  console.error(`no report.json in ${dir}; run: node scripts/verify.mjs ${dir} --write`);
  process.exit(1);
}
const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
const audit = existsSync(join(ROOT, 'docs/self-audit.json'))
  ? JSON.parse(readFileSync(join(ROOT, 'docs/self-audit.json'), 'utf8')) : null;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (x) => x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`;
const num = (x, d = 2) => x === null || x === undefined ? '—' : Number(x).toFixed(d);


/**
 * Inline SVG bar chart: win rate by optimal-depth bucket, with n and a Wilson
 * CI whisker. No dependencies, no external requests — the page stays a single
 * file and the numbers stay traceable to report.json.
 */
function depthChart(curve) {
  if (!curve || curve.length < 1) return '<p class="empty">No depth data yet.</p>';
  const W = 640, H = 220, PAD = 40, BW = Math.min(90, (W - PAD * 2) / curve.length - 16);
  const y = (v) => H - PAD - v * (H - PAD * 2);
  const bars = curve.map((c, i) => {
    const x = PAD + i * ((W - PAD * 2) / curve.length) + 8;
    const top = y(c.winRate);
    const h = H - PAD - top;
    return `<rect x="${x}" y="${top}" width="${BW}" height="${Math.max(1, h)}" fill="#7dd3fc" opacity="0.85"/>`
      + `<text x="${x + BW / 2}" y="${top - 6}" text-anchor="middle" fill="#e6e8eb" font-size="12">${(c.winRate * 100).toFixed(0)}%</text>`
      + `<text x="${x + BW / 2}" y="${H - PAD + 16}" text-anchor="middle" fill="#9aa3ad" font-size="11">${c.bucket}</text>`
      + `<text x="${x + BW / 2}" y="${H - PAD + 30}" text-anchor="middle" fill="#6b7280" font-size="10">n=${c.n}</text>`;
  }).join('');
  const grid = [0, 0.5, 1].map((v) => `<line x1="${PAD}" x2="${W - PAD}" y1="${y(v)}" y2="${y(v)}" stroke="#242a33"/>`
    + `<text x="${PAD - 8}" y="${y(v) + 4}" text-anchor="end" fill="#6b7280" font-size="10">${(v * 100).toFixed(0)}%</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="win rate by optimal depth">${grid}${bars}</svg>`;
}

function profileTable(track) {
  const rows = report.profiles.filter((p) => p.track === track);
  if (!rows.length) return '<p class="empty">No runs in this track yet.</p>';
  return `<table>
<thead><tr><th>Model</th><th>Cells</th><th>Win rate (95% CI)</th><th>Reached</th><th>Passed</th>
<th>broke</th><th>regressed</th><th>neglected</th><th>obligation deaths</th><th>oldest violated rule age</th><th>turns</th></tr></thead>
<tbody>${rows.map((p) => `<tr>
<td class="model">${esc(p.model)}</td><td>${p.cells}</td>
<td>${pct(p.winRate)} <span class="ci">[${pct(p.winRateCI95[0])}, ${pct(p.winRateCI95[1])}]</span></td>
<td>${num(p.reachedMean, 1)}</td><td>${num(p.passedMean, 1)}</td>
<td>${p.violationsByClass.broke ?? 0}</td><td>${p.violationsByClass.regressed ?? 0}</td>
<td>${p.violationsByClass.neglected ?? 0}</td><td>${p.obligationDeaths}</td>
<td>${p.oldestViolatedConstraintAge}</td><td>${num(p.turnsMean, 1)}</td>
</tr>`).join('')}</tbody></table>`;
}

function hypothesisSection() {
  const h1 = report.hypotheses.H1_conflict;
  const h2 = report.hypotheses.H2_neglect;
  return `
<h2>Hypotheses</h2>
<h3>H1 · Does real conflict change the ranking?</h3>
${h1.table.length ? `<table><thead><tr><th>Model</th><th>Win rate, independent</th><th>Win rate, coupled</th><th>Δ</th></tr></thead>
<tbody>${h1.table.map((t) => `<tr><td class="model">${esc(t.model)}</td><td>${pct(t.winRateNone)}</td><td>${pct(t.winRateCoupled)}</td><td>${t.delta === null ? '—' : (t.delta >= 0 ? '+' : '') + pct(t.delta)}</td></tr>`).join('')}</tbody></table>
<p>Rank correlation between modes: <strong>${num(h1.rankCorrelation, 3)}</strong>. Reordered: <strong>${h1.reordered ? 'yes' : 'no'}</strong>.</p>`
    : '<p class="empty">Not enough models with both modes to test H1 yet.</p>'}

<h3>H1b · Win rate by optimal depth</h3>
<p class="ci">The calibration's payoff: as the solver-proven shortest solution gets longer,
win rate should fall. Flat means the difficulty knob is not working.</p>
${depthChart(report.hypotheses?.H1_conflict?.depthCurve ?? null)}

<h3>H2 · Is neglect independent of main-line progress?</h3>
<p>Cells with obligations: <strong>${h2.n}</strong>.
Pearson(passed, deaths): <strong>${num(h2.pearsonPassedVsDeaths, 3)}</strong>.
Spearman: <strong>${num(h2.spearmanPassedVsDeaths, 3)}</strong>.</p>
<p>Cells that reached full progress and <em>still</em> lost an obligation: <strong>${h2.maxProgressButDied}</strong>.
This is the signature SoTALab observed when the furthest Password Game run died because Paul starved.</p>
${h2.n < 10 ? '<p class="empty">Sample too small for a correlation claim. Reported as raw counts only.</p>' : ''}

<h3>H3 · Cost per additional constraint</h3>
${report.costCurves.length ? `<table><thead><tr><th>Model</th><th>Cost multiplier per constraint</th><th>R²</th><th>depth points</th></tr></thead>
<tbody>${report.costCurves.map((c) => `<tr><td class="model">${esc(c.model)}</td><td>${num(c.fit.multiplier, 4)}×</td><td>${num(c.fit.r2, 4)}</td><td>${c.fit.n}</td></tr>`).join('')}</tbody></table>`
    : '<p class="empty">Need at least two depths per model to fit a growth curve.</p>'}`;
}

function trustSection() {
  const s = report.stability;
  return `
<h2>Evaluator trustworthiness</h2>
<p>A benchmark that cannot distinguish "hard" from "broken" measures its own bugs.
These are the checks this run publishes about itself.</p>
<table><tbody>
<tr><td>Task self-audit</td><td>${audit ? `${audit.admitted}/${audit.total} tasks admitted, ${audit.quarantined} quarantined (broken-task rate ${pct(audit.brokenTaskRate)})` : 'not run'}</td></tr>
<tr><td>Cells with repeats</td><td>${s.cellsWithRepeats}</td></tr>
<tr><td>Mean outcome consistency</td><td>${num(s.meanConsistency, 3)} <span class="ci">(1 = perfectly stable, 0 = coin flip)</span></td></tr>
<tr><td>Fully stable cells</td><td>${s.fullyStable}</td></tr>
<tr><td>Coin-flip cells</td><td>${s.coinFlip}</td></tr>
<tr><td>Infrastructure errors excluded</td><td>${report.infraErrors} <span class="ci">(never scored as wrong answers)</span></td></tr>
<tr><td>Prompt fingerprint</td><td><code>${esc(report.protocol?.promptSha256?.slice(0, 16) ?? '—')}</code></td></tr>
<tr><td>Prompt version</td><td>${esc(report.protocol?.promptVersion ?? '—')}</td></tr>
</tbody></table>
<p>Reproduce every number on this page:</p>
<pre><code>node scripts/verify.mjs &lt;run-dir&gt;
# PASS manifest · PASS protocol · PASS numbers</code></pre>`;
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VIGIL · long-horizon agent benchmark</title>
<style>
:root{--bg:#0f1115;--fg:#e6e8eb;--dim:#9aa3ad;--line:#242a33;--accent:#7dd3fc;--warn:#fbbf24}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:48px 24px 96px}
h1{font-size:30px;margin:0 0 6px;letter-spacing:-.4px}
h2{font-size:20px;margin:44px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
h3{font-size:16px;margin:26px 0 8px;color:var(--accent)}
.sub{color:var(--dim);margin:0 0 24px}
.meta{display:flex;gap:20px;flex-wrap:wrap;color:var(--dim);font-size:13px;margin-bottom:8px}
.meta strong{color:var(--fg)}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13.5px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.4px}
.model{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.ci{color:var(--dim);font-size:12px}
.empty{color:var(--warn);font-size:13.5px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
pre{background:#161a21;border:1px solid var(--line);border-radius:6px;padding:12px;overflow-x:auto}
.note{background:#161a21;border-left:3px solid var(--accent);padding:12px 16px;margin:18px 0;font-size:14px}
footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--line);color:var(--dim);font-size:12.5px}
a{color:var(--accent)}
</style></head><body><div class="wrap">
<h1>VIGIL</h1>
<p class="sub">An executable long-horizon agent benchmark: accumulating conflicting constraints,
background obligations on an environment clock, deterministic failure attribution.</p>
<div class="meta">
<span>Cells <strong>${report.cells}</strong></span>
<span>Scoreable <strong>${report.scoreable}</strong></span>
<span>API calls <strong>${report.apiCalls}</strong></span>
<span>Spend <strong>$${num(report.spendUsd, 4)}</strong></span>
<span>Generated <strong>${esc(report.generatedAt.slice(0, 19))}Z</strong></span>
</div>
<div class="note">No headline score. Capability profiles are reported per dimension, with
raw and compliance-filtered tracks kept separate, because a single total hides the structure
that matters. Infrastructure failures are excluded rather than counted as wrong answers.</div>

<h2>Compliance-filtered track</h2>
<p class="ci">Runs in which no boundary canary was tripped. This is the comparable track.</p>
${profileTable('compliant')}

<h2>Raw track</h2>
<p class="ci">All scoreable runs, including any that used prohibited shortcuts. Published separately, never merged into the headline comparison.</p>
${profileTable('raw')}

${hypothesisSection()}
${trustSection()}

<footer>
VIGIL · Apache-2.0 · Methodology responding to
<a href="https://sotalab.ai/zh/blog/password-game-long-horizon-agents">SoTALab's Password Game study</a>.
Every number here reproduces from <code>results.jsonl</code> via <code>scripts/verify.mjs</code>.
</footer>
</div></body></html>
`;

const outDir = join(ROOT, 'web');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), html);
writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote web/index.html and web/report.json from ${dir}`);