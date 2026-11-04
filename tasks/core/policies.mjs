// Reference policies. These are NOT the oracle.
//
// The oracle proves a task is solvable. A reference policy is a deliberately
// simple behaviour used to prove the benchmark DISCRIMINATES — that the coupled
// knob actually creates repair pressure a naive agent falls into.
//
// `greedy` satisfies each newly revealed rule exactly as written and never
// re-checks history. On independent constraints that is nearly optimal. On
// coupled constraints it breaks older rules, which is the H1 signal.

import { World } from '../../engine/index.mjs';

/** Parse the rule text the agent actually sees. No predicate access. */
function actionsForRule(text, surface) {
  const out = [];
  let m = text.match(/^(\w+)\.level must be at least (\d+)\.$/);
  if (m) {
    const slot = m[1];
    const need = Number(m[2]);
    // Greedy uses the coupled fill when it exists, which also raises pressure.
    return surface.includes(`fill_${slot}`)
      ? [{ type: `fill_${slot}`, args: { amount: need } }]
      : [{ type: 'set', args: { path: `${slot}.level`, value: need } }];
  }
  m = text.match(/^(\w+)\.level must equal (\d+)\.$/);
  if (m) return [{ type: 'set', args: { path: `${m[1]}.level`, value: Number(m[2]) } }];
  m = text.match(/^(\w+)\.aux must equal (\d+)\.$/);
  if (m) return [{ type: 'set', args: { path: `${m[1]}.aux`, value: Number(m[2]) } }];
  m = text.match(/^(\w+)\.valve must be open, and \1\.pressure must not exceed (\d+)\.$/);
  if (m) {
    // Greedy opens the valve but does NOT know about vent: it tries to fix
    // pressure by lowering level, which breaks the earlier fill rule.
    out.push({ type: 'set', args: { path: `${m[1]}.valve`, value: true } });
    out.push({ type: 'set', args: { path: `${m[1]}.pressure`, value: Number(m[2]) } });
    return out;
  }
  m = text.match(/^(\w+)\.valve must be open, and \1\.level must not exceed (\d+)\.$/);
  if (m) {
    out.push({ type: 'set', args: { path: `${m[1]}.valve`, value: true } });
    out.push({ type: 'set', args: { path: `${m[1]}.level`, value: Number(m[2]) } });
    return out;
  }
  return out;
}

/**
 * Greedy policy: react to new rules, tend obligations when they look urgent,
 * otherwise idle. Never revisits a rule it has already answered.
 */
export function greedy(task, { seed = 1, tendThreshold = 0.35 } = {}) {
  const w = new World(task, { seed });
  const answered = new Set();
  while (!w.done) {
    const obs = w.observe();
    const surface = obs.actions.map((a) => a.name);
    const urgent = obs.obligations.find((o) => {
      if (o.kind === 'decay') return o.level <= tendThreshold * 10;
      if (o.kind === 'deadline') return o.ticksLeft <= 3;
      return o.shieldTicks <= 1;
    });
    if (urgent) { w.step({ type: 'tend', args: { obligationId: urgent.id } }); continue; }
    const fresh = obs.constraints.filter((c) => !answered.has(c.id));
    if (fresh.length) {
      for (const c of fresh) {
        answered.add(c.id);
        for (const a of actionsForRule(c.text, surface)) { if (!w.done) w.step(a); }
      }
      continue;
    }
    // Greedy never revisits answered rules, so it never ships: it idles until
    // the step budget runs out. That is the behaviour under measurement.
    w.step({ type: 'noop' });
  }
  return w;
}

/** Do nothing. Used by the self-audit to prove a task is non-trivial. */
export function idle(task, { seed = 1 } = {}) {
  const w = new World(task, { seed });
  while (!w.done) w.step({ type: 'noop' });
  return w;
}