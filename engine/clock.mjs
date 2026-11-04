// Environment clock and background obligations.
//
// The clock is the whole point. In SoTALab's Password Game run, 7 of 24
// trajectories ended because Paul starved or burned — including the one that
// got furthest. The agent knew the rule; it was busy in the foreground while
// the background timer ran out.
//
// So obligations decay on ENVIRONMENT time, and environment time advances with
// the cost of each action, not with the number of turns. A model that spends
// 40 seconds reasoning pays 40 ticks of neglect. That coupling is what makes
// "background maintenance" a measurable capability instead of a freebie.

export class ObligationError extends Error {}

const KINDS = new Set(['decay', 'deadline', 'hazard']);

export function validateObligation(o) {
  if (!o || typeof o !== 'object') throw new ObligationError('obligation must be an object');
  if (typeof o.id !== 'string' || !o.id) throw new ObligationError('obligation needs id');
  if (!KINDS.has(o.kind)) throw new ObligationError(`unknown obligation kind: ${o.kind}`);
  if (typeof o.revealAt !== 'number' || o.revealAt < 0) throw new ObligationError(`${o.id}: bad revealAt`);
  if (typeof o.repairAction !== 'string' || !o.repairAction) {
    throw new ObligationError(`${o.id}: needs repairAction`);
  }
  if (o.kind === 'decay') {
    if (!(o.rate > 0)) throw new ObligationError(`${o.id}: decay needs rate > 0`);
    if (!(o.initial > 0)) throw new ObligationError(`${o.id}: decay needs initial > 0`);
  }
  if (o.kind === 'deadline' && !(o.dueAt > o.revealAt)) {
    throw new ObligationError(`${o.id}: deadline needs dueAt > revealAt`);
  }
  if (o.kind === 'hazard' && !(o.probPerTick > 0 && o.probPerTick <= 1)) {
    throw new ObligationError(`${o.id}: hazard needs 0 < probPerTick <= 1`);
  }
  return o;
}

/** Live obligation instances, keyed by id. Created when the obligation reveals. */
export function spawn(o, now) {
  switch (o.kind) {
    case 'decay':
      return { id: o.id, kind: o.kind, level: o.initial, revealedAt: now, dead: false, repairs: 0 };
    case 'deadline':
      return { id: o.id, kind: o.kind, dueAt: o.dueAt, revealedAt: now, dead: false, repairs: 0 };
    case 'hazard':
      // Spawn shielded. An obligation that can kill on the very tick it appears,
      // before the agent has had any chance to react, is an unfair task. The
      // initial shield gives one full maintenance interval to notice it.
      return { id: o.id, kind: o.kind, revealedAt: now, dead: false, repairs: 0,
        armed: true, shield: o.shieldTicks ?? 8, risk: 0 };
    default:
      throw new ObligationError(`unknown kind ${o.kind}`);
  }
}

/**
 * Advance one obligation by `dt` environment ticks.
 * `rand` is an injected deterministic PRNG so hazard runs replay exactly.
 * Returns a death record or null.
 */
export function advance(live, spec, dt, now, rand) {
  if (live.dead || dt <= 0) return null;
  switch (live.kind) {
    case 'decay': {
      live.level -= spec.rate * dt;
      if (live.level <= 0) {
        live.level = 0;
        live.dead = true;
        return { obligationId: live.id, kind: 'decay', atTick: now, cause: 'exhausted' };
      }
      return null;
    }
    case 'deadline': {
      // A discharged deadline is inert: extending it must actually buy safety,
      // otherwise `tend` would be a no-op and the obligation unfair.
      if (live.done) return null;
      if (now >= live.dueAt) {
        live.dead = true;
        return { obligationId: live.id, kind: 'deadline', atTick: now, cause: 'overdue' };
      }
      return null;
    }
    case 'hazard': {
      // Hazard pressure is CUMULATIVE, not a per-tick coin flip. Each unshielded
      // tick adds `probPerTick` to a risk accumulator; ignition at risk >= 1.
      // This makes neglect deterministically fatal after 1/probPerTick exposed
      // ticks, so "ignore it and still win" is impossible — a per-tick Bernoulli
      // would let a lucky run survive, which is an unfair task, not a hard one.
      // Tending grants a shield measured in ticks and resets the accumulator.
      if (!live.armed) return null;
      for (let i = 0; i < dt; i++) {
        if (live.shield > 0) { live.shield -= 1; continue; }
        live.risk = (live.risk ?? 0) + spec.probPerTick;
        if (live.risk >= 1) {
          live.dead = true;
          return { obligationId: live.id, kind: 'hazard', atTick: now - dt + i + 1, cause: 'ignited' };
        }
      }
      return null;
    }
    default:
      throw new ObligationError(`unknown kind ${live.kind}`);
  }
}

/** Apply a repair action. Returns true when it actually tended something. */
export function repair(live, spec) {
  if (live.dead) return false;
  live.repairs += 1;
  switch (live.kind) {
    case 'decay':
      live.level = Math.min(spec.initial, live.level + (spec.repairAmount ?? spec.initial));
      return true;
    case 'deadline':
      live.dueAt += spec.extendBy ?? 0;
      live.done = true;
      return true;
    case 'hazard':
      live.armed = false;
      live.shield = spec.shieldTicks ?? 8;
      live.risk = 0;
      return true;
    default:
      return false;
  }
}

/** Re-arm hazards after an action that did not tend them. */
export function rearm(live) {
  if (live.kind === 'hazard' && !live.dead) live.armed = true;
}

/** Snapshot for the agent's observation. Never leaks the spec's future rules. */
export function observe(live, now) {
  const base = { id: live.id, kind: live.kind, repairs: live.repairs };
  if (live.kind === 'decay') return { ...base, level: Number(live.level.toFixed(4)) };
  if (live.kind === 'deadline') return { ...base, ticksLeft: Math.max(0, live.dueAt - now), done: !!live.done };
  return { ...base, armed: live.armed, shieldTicks: live.shield, risk: Number((live.risk ?? 0).toFixed(4)) };
}

/** Mulberry32 — small, fast, seedable. Determinism is a hard requirement. */
export function prng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}