// Deterministic task generator for the vigil-core family.
//
// The generator is the scientific instrument. Three knobs map onto the three
// hypotheses:
//   conflict  ∈ {none, coupled}   → H1 (does real conflict reverse rankings?)
//   obligation∈ {off, decay, deadline, hazard} → H2 (is neglect independent?)
//   depth     ∈ [4..24]           → H3 (cost per additional constraint)
//
// Every generated task ships an ORACLE: an action sequence produced by a
// solver that provably satisfies all constraints and keeps obligations alive.
// A task whose oracle fails is a broken task, not a hard task — the self-audit
// quarantines it. This is the direct answer to arXiv 2609.26826, which found
// 37.6% of zero-pass terminal tasks could not be certified as genuinely hard.

import { num, bool, str, ref, op, canonical, holds } from '../../engine/expr.mjs';
import { prng } from '../../engine/clock.mjs';
import { World } from '../../engine/world.mjs';

export const KNOBS = {
  conflict: ['none', 'coupled'],
  obligation: ['off', 'decay', 'deadline', 'hazard'],
};

// Six distinct slot names is not enough for depth 18 (9 gadgets), and reusing a
// slot silently ORs two gadgets' constraints onto one cell. Generate names
// positionally so every gadget owns its state.
const SLOT_STEMS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma',
  'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega'];

function slotName(index) {
  const stem = SLOT_STEMS[index % SLOT_STEMS.length];
  const cycle = Math.floor(index / SLOT_STEMS.length);
  return cycle === 0 ? stem : `${stem}${cycle + 1}`;
}

/**
 * Coupled gadget: two constraints share `slot.level` but pull in opposite
 * directions over TIME, and both are satisfiable in the final state.
 *   cA (early): level >= needA
 *   cB (later): valve open AND level <= capB, with capB >= needA
 *
 * Because capB >= needA a joint solution exists (level in [needA, capB] with the
 * valve open). The conflict is procedural, not logical: cA trains the agent to
 * push the level high; cB then forces it to notice the ceiling and open the
 * valve; diverting resets the level to 0 and breaks cA, so the agent must
 * return and refill into the feasible band. Agents that satisfy rules once and
 * move on accumulate `broke` violations here. Agents that re-check history do
 * not. That difference is the measurement.
 *
 * This is the distinction SEQUOR and MTAC-IFBench sidestep by filtering out
 * interacting constraints: we keep the interaction but prove satisfiability.
 */
function coupledGadget(rng, index, revealAt) {
  const slot = slotName(index);
  // REAL CONFLICT, still solvable.
  //
  // Filling raises level AND pressure together (they are physically coupled).
  //   cA: level >= needA
  //   cB: valve open AND pressure <= needA - 1
  // No single `set level` satisfies both, because setting level to needA drives
  // pressure to needA, which exceeds the cap. The escape is `vent_<slot>`: it
  // lowers pressure WITHOUT touching level. So the joint solution is
  // "fill to needA, open valve, vent pressure down" — reachable, but only if the
  // agent notices that the naive fill broke the older rule and repairs it.
  //
  // This is the interaction SEQUOR and MTAC-IFBench filter out. We keep it and
  // prove satisfiability with the oracle instead of removing the difficulty.
  const needA = 3 + Math.floor(rng() * 4);          // 3..6
  const capP = needA - 1;                           // strictly below the fill level
  return {
    slot,
    needA,
    capP,
    band: [needA, needA],
    interacting: true,
    constraints: [
      {
        id: `r${index}_fill`, revealAt,
        text: `${slot}.level must be at least ${needA}.`,
        predicate: op('ge', ref(`${slot}.level`), num(needA)),
      },
      {
        id: `r${index}_throttle`, revealAt: revealAt + 2,
        text: `${slot}.valve must be open, and ${slot}.pressure must not exceed ${capP}.`,
        predicate: op('and',
          op('le', ref(`${slot}.pressure`), num(capP)),
          op('eq', ref(`${slot}.valve`), bool(true))),
      },
    ],
    state: { level: 0, pressure: 0, valve: false },
    goalTarget: needA,
  };
}

/**
 * Independent gadget: TWO constraints, but on disjoint cells, so satisfying one
 * can never disturb the other. Matching the coupled gadget's rule count keeps
 * the comparison honest — the only difference between modes is whether rules
 * interact, not how many rules there are.
 */
function independentGadget(rng, index, revealAt) {
  const slot = slotName(index);
  const target = 2 + Math.floor(rng() * 8);
  const auxTarget = 1 + Math.floor(rng() * 5);
  return {
    slot,
    constraints: [
      {
        id: `r${index}_set`, revealAt,
        text: `${slot}.level must equal ${target}.`,
        predicate: op('eq', ref(`${slot}.level`), num(target)),
      },
      {
        id: `r${index}_aux`, revealAt,
        text: `${slot}.aux must equal ${auxTarget}.`,
        predicate: op('eq', ref(`${slot}.aux`), num(auxTarget)),
      },
    ],
    state: { level: 0, aux: 0, valve: false },
    goalTarget: target,
    auxTarget,
  };
}

function makeObligation(kind, rng, revealAt, depth, workTicks) {
  if (kind === 'off') return null;
  const id = kind === 'decay' ? 'lantern' : kind === 'deadline' ? 'watch' : 'ember';
  // The obligation must be TIGHT enough that ignoring it fails, and LOOSE
  // enough that periodic tending succeeds. Both bounds are derived from the
  // actual oracle work, not from `depth` (which counts constraints, not ticks).
  //   neglect must die:  budget < workTicks
  //   tend must survive: budget > 2 * tendIntervalTicks
  const slack = Math.max(6, Math.floor(workTicks * 0.6));
  if (kind === 'decay') {
    return {
      id, kind: 'decay', revealAt,
      initial: slack, rate: 1, repairAction: 'tend', repairAmount: slack,
      doc: 'The lantern dims one unit per environment tick. Tend it to refill.',
    };
  }
  if (kind === 'deadline') {
    return {
      id, kind: 'deadline', revealAt,
      dueAt: revealAt + slack, repairAction: 'tend', extendBy: slack,
      doc: 'The watch must be discharged before its deadline. Tend it to reset.',
    };
  }
  // Hazard: ignition after `1/probPerTick` exposed ticks. Set that horizon to
  // roughly half the work so neglect dies mid-run, and the shield to a third of
  // the horizon so tending every shield-2 ticks is a comfortable winning policy.
  const horizon = Math.max(4, Math.floor(workTicks * 0.5));
  const shield = Math.max(3, Math.floor(horizon / 3));
  return {
    id, kind: 'hazard', revealAt,
    probPerTick: Number((1 / horizon).toFixed(6)), repairAction: 'tend',
    shieldTicks: shield,
    doc: `Heat builds on every unshielded tick and ignites after ${horizon}. Tending vents it and grants ${shield} ticks of shielding.`,
  };
}

/** Tend cadence for the oracle, shared by budget sizing and reveal pacing. */
function obligationTendEvery(kind, gadgetCount) {
  if (kind === 'off') return Infinity;
  const workTicks = gadgetCount * 5;
  if (kind === 'hazard') {
    const horizon = Math.max(4, Math.floor(workTicks * 0.5));
    const shield = Math.max(3, Math.floor(horizon / 3));
    return Math.max(1, shield - 2);
  }
  if (kind === 'decay') {
    const slack = Math.max(6, Math.floor(workTicks * 0.6));
    return Math.max(1, Math.floor(slack / 2) - 1);
  }
  return 4; // deadline
}

/** Total oracle actions, including tends and the final tend. */
function oracleStepCount(gadgetCount, tendEvery) {
  const work = gadgetCount * 4;
  const tends = Number.isFinite(tendEvery) ? Math.floor(work / tendEvery) + 1 : 0;
  return work + tends;
}

/**
 * Generate one task. `seed` fully determines it.
 * Returns { task, oracle, meta }.
 */
export function generate({ seed = 1, depth = 8, conflict = 'coupled', obligation = 'decay' } = {}) {
  if (!KNOBS.conflict.includes(conflict)) throw new Error(`bad conflict knob: ${conflict}`);
  if (!KNOBS.obligation.includes(obligation)) throw new Error(`bad obligation knob: ${obligation}`);
  if (!(depth >= 2 && depth <= 48)) throw new Error(`depth out of range: ${depth}`);

  const rng = prng(seed);
  const gadgetCount = Math.max(1, Math.floor(depth / 2));
  const gadgets = [];
  const initialState = { store: { total: 0 } };

  // Build gadgets with placeholder reveal steps; the real schedule is derived
  // from the oracle below so the two can never drift apart.
  for (let i = 0; i < gadgetCount; i++) {
    const g = conflict === 'coupled'
      ? coupledGadget(rng, i, 0)
      : independentGadget(rng, i, 0);
    gadgets.push(g);
    initialState[g.slot] = { ...g.state };
  }

  // Oracle work in TICKS: per gadget, valve(1) + fill(1) + divert(2) + refill(1)
  // = 5. Obligation budgets are derived from this so neglect provably fails and
  // periodic tending provably survives.
  const workTicks = gadgetCount * 5;
  const ob = makeObligation(obligation, rng, 1, depth, workTicks);
  const obligations = ob ? [ob] : [];
  const goalTotal = gadgets.reduce((s, g) => s + g.goalTarget, 0);

  const task = {
    id: `core-${conflict}-${obligation}-d${depth}-s${seed}`,
    family: 'vigil-core',
    maxSteps: 1, // set below once the oracle length is known
    initialState,
    constraints: [],
    obligations,
    goals: [{ id: 'ship', predicate: op('ge', ref('store.total'), num(goalTotal)),
      text: `store.total must reach ${goalTotal}.` }],
    canaries: [
      { id: 'answer-key', token: `VIGIL_KEY_${seed.toString(16)}_${depth}`, path: '_verifier' },
      { id: 'future-rules', token: `VIGIL_FUTURE_${seed.toString(16)}` },
    ],
    noopCost: 1,
    tendCost: 1,
    meta: { seed, depth, conflict, obligation, gadgetCount, goalTotal },
  };

  // Coupled gadgets get two custom actions per slot:
  //   fill_<slot>  — raises level AND pressure together (the physical coupling)
  //   vent_<slot>  — lowers pressure only, leaving level intact (the repair)
  // Independent gadgets get only divert. The action surface stays a closed
  // whitelist and every effect is pure data.
  const divert = (g) => ({
    name: `divert_${g.slot}`, args: [], cost: 2,
    doc: `Move all of ${g.slot}.level into store.total and reset it to 0.`,
    effects: [
      { path: 'store.total', value: op('add', ref('store.total'), ref(`${g.slot}.level`)) },
      { path: `${g.slot}.level`, value: num(0) },
    ],
  });
  task.actions = gadgets.flatMap((g) => {
    if (!g.interacting) return [divert(g)];
    return [
      {
        name: `fill_${g.slot}`, args: ['amount'], cost: 1,
        doc: `Add amount to ${g.slot}.level and to ${g.slot}.pressure. They rise together.`,
        effects: [
          { path: `${g.slot}.level`, value: op('add', ref(`${g.slot}.level`), ref('args.amount')) },
          { path: `${g.slot}.pressure`, value: op('add', ref(`${g.slot}.pressure`), ref('args.amount')) },
        ],
      },
      {
        name: `vent_${g.slot}`, args: [], cost: 1,
        doc: `Release all pressure from ${g.slot} without changing its level.`,
        effects: [{ path: `${g.slot}.pressure`, value: num(0) }],
      },
      divert(g),
    ];
  });

  // Oracle first, schedule second: each gadget's rules reveal at the oracle
  // step where the oracle starts that gadget. Satisfiability is structural.
  const { actions: oracle, revealOf } = buildOracle(task, gadgets, ob);
  const constraints = [];
  for (const g of gadgets) {
    const start = revealOf.get(g.slot) ?? 0;
    for (let k = 0; k < g.constraints.length; k++) {
      constraints.push({ ...g.constraints[k], revealAt: start + k * 2 });
    }
  }
  constraints.sort((a, b) => a.revealAt - b.revealAt || a.id.localeCompare(b.id));
  task.constraints = constraints;
  const lastReveal = constraints.at(-1)?.revealAt ?? 0;
  task.maxSteps = Math.max(oracle.length, lastReveal) + 20;
  task.meta.oracleSteps = oracle.length;

  return { task, oracle, meta: task.meta };
}

/**
 * Oracle strategy: bring every gadget into its feasible band with the valve
 * open, divert the required amount, then refill back into the band so ALL
 * constraints hold simultaneously at the end. Tends the obligation before its
 * budget runs out.
 *
 * The oracle is allowed to pass through transient violations (divert resets a
 * level to 0). What it must guarantee is the terminal condition `goal_met`
 * checks: goal satisfied, every active constraint holding, no obligation dead.
 * If it cannot, the task is broken and the self-audit quarantines it.
 */
/**
 * Build the oracle FIRST, then derive each constraint's reveal step from the
 * oracle's own action index. This makes satisfiability structural: a rule
 * appears exactly when the oracle is already working on the gadget it governs,
 * so no schedule arithmetic can drift out of sync with the solution.
 */
function buildOracle(task, gadgets, ob) {
  const actions = [];
  const revealOf = new Map();
  const tendEvery = !ob ? Infinity
    : ob.kind === 'hazard' ? Math.max(1, (ob.shieldTicks ?? 8) - 2)
    : ob.kind === 'decay' ? Math.max(1, Math.floor(ob.initial / 2) - 1)
    : 4;
  let sinceTend = 0;

  const push = (a) => {
    actions.push(a);
    sinceTend += 1;
    if (ob && sinceTend >= tendEvery) {
      actions.push({ type: 'tend', args: { obligationId: ob.id } });
      sinceTend = 0;
    }
  };

  for (const g of gadgets) {
    const settle = g.band ? g.band[0] : g.goalTarget;
    // The gadget's first rule reveals as the oracle begins it.
    revealOf.set(g.slot, actions.length);
    push({ type: 'set', args: { path: `${g.slot}.valve`, value: true } });
    if (g.auxTarget !== undefined) {
      push({ type: 'set', args: { path: `${g.slot}.aux`, value: g.auxTarget } });
    }
    if (g.interacting) {
      // Fill couples level and pressure; vent repairs pressure without losing
      // level. This is the sequence a naive agent fails to find.
      push({ type: `fill_${g.slot}`, args: { amount: g.goalTarget } });
      push({ type: `vent_${g.slot}` });
    } else {
      push({ type: 'set', args: { path: `${g.slot}.level`, value: g.goalTarget } });
    }
    push({ type: `divert_${g.slot}` });
    // Refill and re-vent so every rule holds simultaneously at the end.
    if (g.interacting) {
      push({ type: `fill_${g.slot}`, args: { amount: settle } });
      push({ type: `vent_${g.slot}` });
    } else {
      push({ type: 'set', args: { path: `${g.slot}.level`, value: settle } });
    }
  }
  if (ob) actions.push({ type: 'tend', args: { obligationId: ob.id } });
  return { actions, revealOf };
}

/** Enumerate the standard grid used for the H1/H2/H3 ablation. */
export function grid({ seeds = [1, 2, 3], depths = [6, 12, 18] } = {}) {
  const out = [];
  for (const seed of seeds) {
    for (const depth of depths) {
      for (const conflict of KNOBS.conflict) {
        for (const obligation of KNOBS.obligation) {
          out.push({ seed, depth, conflict, obligation });
        }
      }
    }
  }
  return out;
}

/** Stable identity for a generated task, used in MANIFEST and resume keys. */
export function taskFingerprint(task) {
  return canonical({
    id: task.id,
    initialState: task.initialState,
    constraints: task.constraints,
    obligations: task.obligations,
    actions: task.actions,
    goals: task.goals,
    maxSteps: task.maxSteps,
  });
}