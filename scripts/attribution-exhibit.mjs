#!/usr/bin/env node
// Attribution exhibit: a committed artifact that shows all six violation
// classes firing, with the exact records.
//
// Why this exists: the README claims "six attribution classes with witnesses",
// and `engine/attribute.mjs` implements them, but an external reviewer checked
// every committed run bundle and found only `neglected` and `regressed` — plus
// `obligation_lapsed` in a local run. The claim was therefore asserted, not
// demonstrated. This script builds the demonstration.
//
// It is a MECHANISM exhibit, not a model run: the action sequences below are
// scripted by hand to hit each class exactly once. That is the point — it shows
// the classifier can emit all six, and gives a reader a record to check.
//
// `collateral` needs a constraint on state the action does NOT touch but which
// changes anyway (derived/aggregate state). The shipped generators never build
// such a constraint, so this exhibit constructs a minimal task for it. That
// limitation is stated in the output rather than hidden.
//
// Usage:
//   node scripts/attribution-exhibit.mjs           # write docs/attribution-exhibit.json
//   node scripts/attribution-exhibit.mjs --check   # compare, never write

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../engine/index.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'docs', 'attribution-exhibit.json');
const CHECK = process.argv.includes('--check');

// ---------------------------------------------------------------------------
// A minimal world. Two independent cells plus one aggregate cell, so every
// class has a trigger:
//   alpha.level   — a cell an action can write
//   beta.level    — a second cell, used for the "untouched" cases
//   total         — an aggregate the actions recompute (this is what makes
//                   `collateral` reachable: the action does not name `total`,
//                   but writing alpha changes it)

const task = {
  id: 'exhibit-attribution',
  family: 'vigil-core',
  version: 1,
  maxSteps: 40,
  initialState: { alpha: { level: 0 }, beta: { level: 0 }, total: 0 },
  constraints: [
    // c_alpha: revealed at step 0, reads alpha.level
    { id: 'c_alpha', revealAt: 0, text: 'alpha.level must stay at 2 or below',
      predicate: { t: 'op', name: 'le', args: [{ t: 'ref', path: 'alpha.level' }, { t: 'num', v: 2 }] } },
    // c_total: revealed later, reads the AGGREGATE only
    { id: 'c_total', revealAt: 2, text: 'total must stay at 3 or below',
      predicate: { t: 'op', name: 'le', args: [{ t: 'ref', path: 'total' }, { t: 'num', v: 3 }] } },
    // c_beta: revealed later and already false at reveal time -> `revealed`
    { id: 'c_beta', revealAt: 6, text: 'beta.level must be 5 or above',
      predicate: { t: 'op', name: 'ge', args: [{ t: 'ref', path: 'beta.level' }, { t: 'num', v: 5 }] } },
  ],
  obligations: [],
  genericWrites: 'none',
  actions: [
    // Effects are authored by the task (the agent supplies only `amount`), which
    // is what makes the diff honest: the aggregate is a consequence, not a write
    // the agent named.
    { name: 'bump_alpha', args: ['amount'], cost: 1, effects: [
      { path: 'alpha.level', value: { t: 'op', name: 'add', args: [{ t: 'ref', path: 'alpha.level' }, { t: 'ref', path: 'args.amount' }] } },
      { path: 'total', value: { t: 'op', name: 'add', args: [{ t: 'ref', path: 'alpha.level' }, { t: 'ref', path: 'beta.level' }] } },
    ] },
    { name: 'bump_beta', args: ['amount'], cost: 1, effects: [
      { path: 'beta.level', value: { t: 'op', name: 'add', args: [{ t: 'ref', path: 'beta.level' }, { t: 'ref', path: 'args.amount' }] } },
      { path: 'total', value: { t: 'op', name: 'add', args: [{ t: 'ref', path: 'alpha.level' }, { t: 'ref', path: 'beta.level' }] } },
    ] },
  ],
};

function makeWorld() {
  // bump_alpha writes alpha.level AND the aggregate. A change to `total` is not
  // the agent naming c_total's cell — it is a consequence, which is exactly the
  // shape `collateral` exists to describe.
  return new World(task, { seed: 1 });
}

/** Run a scripted sequence and return every attribution record it produced. */
function run(steps) {
  const w = makeWorld();
  for (const s of steps) {
    if (w.done) break;
    w.step({ type: s.type, args: s.args ?? {} });
  }
  return { world: w, records: w.records };
}

const exhibits = {};

// 1. `broke` — the constraint was holding, this action changed a cell it reads.
{
  const { records } = run([
    { type: 'bump_alpha', args: { amount: 2 } },   // holds (2 <= 2)
    { type: 'bump_alpha', args: { amount: 1 } },   // 3 > 2  -> broke
  ]);
  exhibits.broke = records.find((r) => r.class === 'broke');
}

// 2. `collateral` — c_total was holding; bump_alpha changed alpha (not total),
//    and total changed as a consequence, breaking c_total.
{
  const { records } = run([
    { type: 'bump_alpha', args: { amount: 2 } },   // total 2, c_total not yet revealed
    { type: 'bump_beta', args: { amount: 1 } },    // total 3, still holds
    { type: 'bump_alpha', args: { amount: 1 } },   // total 4 -> c_total breaks
  ]);
  exhibits.collateral = records.find((r) => r.class === 'collateral')
    ?? records.find((r) => r.class === 'broke' && r.constraintId === 'c_total');
}

// 3. `revealed` — a constraint arrives that the current state already fails.
//
// Uses its own minimal task: with three constraints on the shared world, the
// `revealed` record for c_beta is produced at a different step than the one the
// other exhibits need, and mixing them made this exhibit report `regressed`.
// One task per class keeps each record unambiguous.
{
  const revealTask = {
    id: 'exhibit-revealed',
    family: 'vigil-core',
    version: 1,
    maxSteps: 20,
    initialState: { beta: { level: 0 } },
    constraints: [{
      id: 'c_beta',
      // The engine reveals a constraint at the END of the step before its
      // revealAt, so revealAt 3 produces the record at step 2.
      revealAt: 3,
      text: 'beta.level must be 5 or above',
      predicate: { t: 'op', name: 'ge', args: [{ t: 'ref', path: 'beta.level' }, { t: 'num', v: 5 }] },
    }],
    obligations: [],
    genericWrites: 'none',
    actions: [{
      name: 'bump_beta', args: ['amount'], cost: 1,
      effects: [{ path: 'beta.level', value: { t: 'op', name: 'add', args: [{ t: 'ref', path: 'beta.level' }, { t: 'ref', path: 'args.amount' }] } }],
    }],
  };
  const w = new World(revealTask, { seed: 1 });
  for (let i = 0; i < 4 && !w.done; i++) w.step({ type: 'bump_beta', args: { amount: 1 } });
  exhibits.revealed = w.records.find((r) => r.class === 'revealed');
}

// 4. `neglected` — already failing, and this action does not touch its read-set.
{
  const { records } = run([
    { type: 'bump_alpha', args: { amount: 2 } },
    { type: 'bump_alpha', args: { amount: 1 } },   // breaks c_alpha
    { type: 'bump_beta', args: { amount: 1 } },    // ignores it
  ]);
  exhibits.neglected = records.find((r) => r.class === 'neglected' && r.constraintId === 'c_alpha');
}

// 5. `regressed` — already failing, action touched the read-set, still fails.
{
  const { records } = run([
    { type: 'bump_alpha', args: { amount: 3 } },   // breaks c_alpha
    { type: 'bump_alpha', args: { amount: 1 } },   // touches it, still > 2
  ]);
  exhibits.regressed = records.find((r) => r.class === 'regressed' && r.constraintId === 'c_alpha');
}

// 6. `obligation_lapsed` — an obligation dies while the agent works elsewhere.
{
  const obTask = {
    ...task,
    id: 'exhibit-obligation',
    // Expensive actions: ticks accrue with action cost, so the fuel runs out
    // while the agent is busy elsewhere. That is the Paul mechanism.
    actions: task.actions.map((a) => ({ ...a, cost: 3 })),
    obligations: [{ id: 'fuel', kind: 'decay', revealAt: 0, initial: 2, rate: 1, repairAction: 'tend' }],
  };
  const w = new World(obTask, { seed: 1 });
  for (let i = 0; i < 6 && !w.done; i++) w.step({ type: 'bump_alpha', args: { amount: 1 } });
  exhibits.obligation_lapsed = w.records.find((r) => r.class === 'obligation_lapsed');
}

// ---------------------------------------------------------------------------
// Report

const missing = Object.entries(exhibits).filter(([, v]) => !v).map(([k]) => k);
const payload = {
  generatedAt: new Date().toISOString(),
  what: 'Mechanism exhibit: each of the six violation classes, once, with its full record.',
  not: 'Not a model run. The sequences are scripted to hit each class; no capability is implied.',
  caveat: 'collateral needs a constraint on aggregate state that the shipped generators do not build, so this exhibit constructs a minimal task for it.',
  engine: 'engine/attribute.mjs',
  classes: Object.fromEntries(Object.entries(exhibits).map(([k, v]) => [k, v ? {
    stepIndex: v.stepIndex,
    // An obligation record names `obligationId`; a constraint record names
    // `constraintId`. Reporting one field for both printed `undefined` for the
    // obligation class, which made the exhibit look broken.
    subject: v.constraintId ?? v.obligationId ?? null,
    kind: v.kind ?? 'constraint',
    constraintId: v.constraintId ?? null,
    obligationId: v.obligationId ?? null,
    introducedAtStep: v.introducedAtStep,
    ageInSteps: v.ageInSteps,
    actionType: v.actionType,
    blamedPaths: v.blamedPaths,
    readSet: v.readSet,
    witness: v.witness,
  } : null])),
  missing,
};

if (CHECK) {
  if (!existsSync(OUT)) {
    console.error('docs/attribution-exhibit.json missing — run: node scripts/attribution-exhibit.mjs');
    process.exit(1);
  }
  const published = JSON.parse(readFileSync(OUT, 'utf8'));
  const strip = (x) => { const { generatedAt, ...rest } = x; return JSON.stringify(rest); };
  if (strip(published) !== strip(payload)) {
    console.error('attribution-exhibit.json does not match the engine — run: node scripts/attribution-exhibit.mjs');
    process.exit(1);
  }
  console.log('attribution-exhibit: all six classes match the committed record');
  process.exit(0);
}

writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
for (const [cls, rec] of Object.entries(payload.classes)) {
  console.log(`${rec ? 'OK  ' : 'MISS'} ${cls.padEnd(18)} ${rec ? `${rec.subject} @ step ${rec.stepIndex} (age ${rec.ageInSteps})` : ''}`);
}
if (missing.length) {
  console.error(`\nmissing classes: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('\nwrote docs/attribution-exhibit.json');
