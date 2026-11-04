// Deterministic failure attribution.
//
// Competitors (Who&When, TRAIL, AgentRx) attribute failures by asking an LLM to
// read a transcript after the fact. Who&When's best step-localisation is 14.2%.
// We do not have that problem: constraints are predicates over a state we own,
// so we can compute exactly which action broke which constraint, and when that
// constraint was introduced. No judge, no guessing.
//
// Two failure families are kept apart because they need different fixes:
//   - constraint violations: the agent DID something that broke a rule
//   - obligation deaths:     the agent did NOTHING for too long
// Collapsing them into one "failure" number is what hides the H2 effect.

import { reads, resolvePath } from './expr.mjs';

/** Leaf paths that differ between two states. Arrays are treated as leaves. */
export function diffPaths(before, after, prefix = '', out = []) {
  if (before === after) return out;
  const bothObjects =
    before !== null && after !== null &&
    typeof before === 'object' && typeof after === 'object' &&
    !Array.isArray(before) && !Array.isArray(after);
  if (!bothObjects) {
    out.push(prefix);
    return out;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of [...keys].sort()) {
    const p = prefix ? `${prefix}.${k}` : k;
    diffPaths(before[k], after[k], p, out);
  }
  return out;
}

/**
 * Does a changed path intersect a constraint's read-set?
 * A change to `a.b` matters to a constraint reading `a` (container) or `a.b.c`
 * (the change replaced the whole subtree).
 */
export function touches(changedPath, readSet) {
  for (const r of readSet) {
    if (r === changedPath) return true;
    if (changedPath.startsWith(`${r}.`)) return true;
    if (r.startsWith(`${changedPath}.`)) return true;
  }
  return false;
}

/**
 * Classify a violation that appeared at this step.
 *
 * `newly` means the constraint held before the action and fails after.
 * `carried` means it was already failing and the action did not fix it.
 *
 * Classes:
 *   broke       — this action changed a cell the constraint reads (direct cause)
 *   collateral  — this action changed something else; constraint broke anyway
 *                 (only possible when a constraint reads derived/global state)
 *   revealed    — constraint was just revealed and the state already fails it
 *   neglected   — already failing, action did not touch its read-set
 *   regressed   — already failing, action touched its read-set but did not fix
 */
export function classifyViolation({ constraint, wasHolding, justRevealed, changed, readSet }) {
  const touched = changed.some((p) => touches(p, readSet));
  if (justRevealed) return 'revealed';
  if (wasHolding) return touched ? 'broke' : 'collateral';
  return touched ? 'regressed' : 'neglected';
}

/**
 * Build the attribution record for one violated constraint at one step.
 * `introducedAt` is the step index at which the constraint became active —
 * this is the field that answers "it forgot a rule from 30 steps ago".
 */
export function attribute({
  stepIndex, tick, constraint, wasHolding, justRevealed, changed, action,
}) {
  const readSet = reads(constraint.predicate);
  const cls = classifyViolation({ constraint, wasHolding, justRevealed, changed, readSet });
  const blamed = changed.filter((p) => touches(p, readSet));
  return {
    stepIndex,
    tick,
    constraintId: constraint.id,
    introducedAtStep: constraint.revealAt,
    ageInSteps: stepIndex - constraint.revealAt,
    class: cls,
    actionType: action?.type ?? null,
    blamedPaths: blamed.length ? blamed : changed.slice(0, 8),
    readSet: [...readSet].sort(),
    witness: witness(constraint.predicate, readSet, changed, action),
  };
}

/**
 * A small, human-checkable evidence bundle: the current value of the cells the
 * constraint reads. Lets a reader confirm the verdict without rerunning.
 */
function witness(predicate, readSet, changed, action) {
  const paths = [...new Set([...readSet, ...changed])].sort().slice(0, 12);
  return { paths, actionArgs: action?.args ?? null };
}

/** Attach live values to a witness after the step has been applied. */
export function fillWitness(record, state) {
  record.witness.values = {};
  for (const p of record.witness.paths) {
    const v = resolvePath(state, p);
    record.witness.values[p] = typeof v === 'object' && v !== null ? summarise(v) : v;
  }
  return record;
}

function summarise(v) {
  if (Array.isArray(v)) return { arrayLength: v.length, head: v.slice(0, 5) };
  const keys = Object.keys(v);
  return { keys: keys.length, sample: keys.slice(0, 5) };
}

/** Obligation death → attribution record. Cause is neglect by construction. */
export function attributeObligationDeath({ stepIndex, death, spec, live }) {
  return {
    stepIndex,
    tick: death.atTick,
    obligationId: death.obligationId,
    introducedAtStep: spec.revealAt,
    ageInSteps: stepIndex - spec.revealAt,
    class: 'obligation_lapsed',
    kind: death.kind,
    cause: death.cause,
    repairs: live.repairs,
    ticksSinceReveal: death.atTick - live.revealedAt,
  };
}

/** Roll a trajectory's records into the capability profile (no headline score). */
export function summariseAttribution(records) {
  const byClass = {};
  const byConstraint = {};
  let maxAge = 0;
  for (const r of records) {
    byClass[r.class] = (byClass[r.class] ?? 0) + 1;
    const key = r.constraintId ?? r.obligationId;
    byConstraint[key] = (byConstraint[key] ?? 0) + 1;
    maxAge = Math.max(maxAge, r.ageInSteps ?? 0);
  }
  const violations = records.filter((r) => r.constraintId);
  const ages = violations.map((r) => r.ageInSteps);
  return {
    total: records.length,
    byClass,
    byConstraint,
    constraintViolations: violations.length,
    obligationDeaths: records.length - violations.length,
    oldestViolatedConstraintAge: maxAge,
    meanViolationAge: ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : 0,
  };
}