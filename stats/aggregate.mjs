// Aggregate a run directory into the capability profile and the trustworthiness
// report. No headline score: SoTALab's "子项分数往往比 headline 数字更有信息量".

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  wilson, meanStd, outcomeConsistency, costGrowth, pearson, spearman,
} from './index.mjs';

export function loadRun(dir) {
  const path = join(dir, 'results.jsonl');
  if (!existsSync(path)) throw new Error(`no results.jsonl in ${dir}`);
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn tail after a crash */ }
  }
  const protocol = existsSync(join(dir, 'protocol.json'))
    ? JSON.parse(readFileSync(join(dir, 'protocol.json'), 'utf8')) : null;
  const ledger = existsSync(join(dir, 'ledger.jsonl'))
    ? readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { rows, protocol, ledger };
}

const isWin = (r) => r.terminal?.reason === 'goal_met';
// Infrastructure failures are excluded, never counted as wrong answers.
const isScoreable = (r) => r.status === 'completed' || r.status === 'turn_cap';

/** Per-model capability profile, split by compliance track. */
export function modelProfiles(rows) {
  const byModel = new Map();
  for (const r of rows) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }
  const out = [];
  for (const [model, all] of byModel) {
    const scoreable = all.filter(isScoreable);
    const compliant = scoreable.filter((r) => r.profile?.compliant !== false);
    for (const [track, rows_] of [['raw', scoreable], ['compliant', compliant]]) {
      if (!rows_.length) continue;
      const wins = rows_.filter(isWin).length;
      const [lo, hi] = wilson(wins, rows_.length);
      const classes = {};
      let oldest = 0;
      let neglectDeaths = 0;
      for (const r of rows_) {
        for (const rec of r.records ?? []) {
          classes[rec.class] = (classes[rec.class] ?? 0) + 1;
          oldest = Math.max(oldest, rec.ageInSteps ?? 0);
          if (rec.class === 'obligation_lapsed') neglectDeaths++;
        }
      }
      const turns = meanStd(rows_.map((r) => r.turns?.length ?? r.actionLog?.length ?? 0));
      const ticks = meanStd(rows_.map((r) => r.profile?.ticks ?? 0));
      out.push({
        model, track,
        cells: rows_.length,
        wins, winRate: wins / rows_.length, winRateCI95: [lo, hi],
        reachedMean: meanStd(rows_.map((r) => r.profile?.reached ?? 0)).mean,
        passedMean: meanStd(rows_.map((r) => r.profile?.passed ?? 0)).mean,
        violationsByClass: classes,
        oldestViolatedConstraintAge: oldest,
        obligationDeaths: neglectDeaths,
        turnsMean: turns.mean, turnsStd: turns.std,
        ticksMean: ticks.mean,
        nonCompliant: scoreable.length - compliant.length,
        excludedInfraErrors: all.length - scoreable.length,
      });
    }
  }
  return out.sort((a, b) => (a.model === b.model ? a.track.localeCompare(b.track) : a.model.localeCompare(b.model)));
}

/** Repeat-run stability per (task, model) cell. */
export function stability(rows) {
  const cells = new Map();
  for (const r of rows.filter(isScoreable)) {
    const key = `${r.taskId}|${r.model}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(isWin(r) ? 'win' : 'loss');
  }
  const perCell = [...cells.entries()].map(([cellId, outcomes]) => ({
    cell: cellId, reps: outcomes.length, consistency: outcomeConsistency(outcomes),
  })).filter((c) => c.reps > 1);
  return {
    cellsWithRepeats: perCell.length,
    meanConsistency: perCell.length ? meanStd(perCell.map((c) => c.consistency)).mean : null,
    fullyStable: perCell.filter((c) => c.consistency === 1).length,
    coinFlip: perCell.filter((c) => c.consistency === 0).length,
    perCell,
  };
}

/** H3: cost multiplier per additional constraint, per model. */
export function costCurves(rows, ledger) {
  const settled = new Map();
  for (const e of ledger) {
    if (e.type !== 'settle') continue;
    // ledger ids are taskId:model:seed:tN
    const parts = e.id.split(':');
    if (parts.length < 3) continue;
    const taskId = parts[0];
    const model = parts[1];
    const key = `${taskId}|${model}`;
    settled.set(key, (settled.get(key) ?? 0) + e.micros);
  }
  const byModel = new Map();
  for (const r of rows.filter(isScoreable)) {
    const key = `${r.taskId}|${r.model}`;
    const micros = settled.get(key);
    if (micros === undefined) continue;
    const depth = r.config?.depth ?? r.profile?.totalConstraints;
    if (!depth) continue;
    if (!byModel.has(r.model)) byModel.set(r.model, new Map());
    const depths = byModel.get(r.model);
    if (!depths.has(depth)) depths.set(depth, []);
    depths.get(depth).push(micros / 1e6);
  }
  return [...byModel.entries()].map(([model, depths]) => {
    const points = [...depths.entries()]
      .map(([depth, costs]) => ({ depth, cost: meanStd(costs).mean }))
      .sort((a, b) => a.depth - b.depth);
    return { model, points, fit: costGrowth(points) };
  });
}

/**
 * H2: is background-obligation failure independent of main-line progress?
 * Correlates passed-constraint count with obligation deaths across cells.
 */
export function neglectIndependence(rows) {
  const usable = rows.filter((r) => isScoreable(r) && (r.config?.obligation ?? 'off') !== 'off');
  const passed = usable.map((r) => r.profile?.passed ?? 0);
  const deaths = usable.map((r) => (r.profile?.obligationsDead ?? []).length);
  const survived = usable.map((r) => ((r.profile?.obligationsDead ?? []).length === 0 ? 1 : 0));
  return {
    n: usable.length,
    pearsonPassedVsDeaths: pearson(passed, deaths),
    spearmanPassedVsDeaths: spearman(passed, deaths),
    pearsonPassedVsSurvival: pearson(passed, survived),
    // The headline H2 observation: cells that maximised progress but still died.
    maxProgressButDied: usable.filter((r) =>
      (r.profile?.passed ?? 0) >= (r.profile?.reached ?? 0) &&
      (r.profile?.obligationsDead ?? []).length > 0).length,
  };
}

/** H1: does enabling conflict change the model ordering? */
export function conflictEffect(rows) {
  const byModelConflict = new Map();
  for (const r of rows.filter(isScoreable)) {
    const conflict = r.config?.conflict;
    if (!conflict) continue;
    const key = `${r.model}|${conflict}`;
    if (!byModelConflict.has(key)) byModelConflict.set(key, []);
    byModelConflict.get(key).push(r);
  }
  const models = [...new Set(rows.map((r) => r.model))];
  const table = models.map((model) => {
    const get = (c) => {
      const rs = byModelConflict.get(`${model}|${c}`) ?? [];
      return rs.length ? rs.filter(isWin).length / rs.length : null;
    };
    const none = get('none');
    const coupled = get('coupled');
    return { model, winRateNone: none, winRateCoupled: coupled,
      delta: none !== null && coupled !== null ? coupled - none : null };
  });
  const rankOf = (field) => [...table].filter((t) => t[field] !== null)
    .sort((a, b) => b[field] - a[field]).map((t) => t.model);
  const rankNone = rankOf('winRateNone');
  const rankCoupled = rankOf('winRateCoupled');
  const shared = rankNone.filter((m) => rankCoupled.includes(m));
  return {
    table,
    rankNone, rankCoupled,
    rankCorrelation: shared.length >= 2
      ? spearman(shared.map((m) => rankNone.indexOf(m)), shared.map((m) => rankCoupled.indexOf(m)))
      : null,
    reordered: shared.length >= 2 && rankNone.join(',') !== rankCoupled.join(','),
  };
}

export function aggregate(dir) {
  const { rows, protocol, ledger } = loadRun(dir);
  const settled = ledger.filter((e) => e.type === 'settle');
  return {
    run: dir,
    generatedAt: new Date().toISOString(),
    protocol,
    cells: rows.length,
    scoreable: rows.filter(isScoreable).length,
    infraErrors: rows.filter((r) => r.status === 'error' || r.status === 'truncated').length,
    spendUsd: settled.reduce((s, e) => s + e.micros, 0) / 1e6,
    apiCalls: settled.length,
    profiles: modelProfiles(rows),
    stability: stability(rows),
    costCurves: costCurves(rows, ledger),
    hypotheses: {
      H1_conflict: conflictEffect(rows),
      H2_neglect: neglectIndependence(rows),
    },
  };
}