// The VIGIL world: shared mutable state + accumulating constraints +
// background obligations on an environment clock.
//
// Design commitments that come straight from SoTALab's Password Game writeup
// (https://sotalab.ai/zh/blog/password-game-long-horizon-agents):
//
//   1. "Benchmark 必须明确合法工具与权限边界"
//      → the action surface is a closed whitelist; every call is logged;
//        verifier internals and unrevealed constraints live outside the
//        observation and are baited with canaries.
//   2. "到达 R28 ... 实际最高通过为 R27"
//      → `reached` and `passed` are separate counters, never conflated.
//   3. "时间、Token 和人工干预都应计入交付成本"
//      → the world records ticks; the runner records tokens and wall time.
//   4. "真正缺失的，是一种持续照看的能力"
//      → obligations decay on ticks, and ticks accrue with action cost.
//   5. "子项分数往往比 headline 数字更有信息量"
//      → the world emits a profile, not a score.
//   6. "每一次失败都要能被定位"
//      → every violation carries (stepIndex, constraintId, introducedAtStep).

import { canonical, evaluate, holds, reads, validate as validateExpr } from './expr.mjs';
import {
  advance, observe, prng, rearm, repair, spawn,
  validateObligation,
} from './clock.mjs';
import {
  attribute, attributeObligationDeath, diffPaths, fillWitness,
} from './attribute.mjs';

export class WorldError extends Error {}

const BUILTIN_ACTIONS = new Set(['noop', 'set', 'inc', 'push', 'remove', 'tend']);

export function validateTask(task) {
  if (!task || typeof task !== 'object') throw new WorldError('task must be an object');
  if (typeof task.id !== 'string' || !task.id) throw new WorldError('task needs id');
  if (!task.initialState || typeof task.initialState !== 'object') {
    throw new WorldError(`${task.id}: needs initialState`);
  }
  if (!Array.isArray(task.constraints) || task.constraints.length === 0) {
    throw new WorldError(`${task.id}: needs constraints`);
  }
  const ids = new Set();
  for (const c of task.constraints) {
    if (typeof c.id !== 'string' || !c.id) throw new WorldError(`${task.id}: constraint needs id`);
    if (ids.has(c.id)) throw new WorldError(`${task.id}: duplicate constraint id ${c.id}`);
    ids.add(c.id);
    if (typeof c.revealAt !== 'number' || c.revealAt < 0) {
      throw new WorldError(`${c.id}: bad revealAt`);
    }
    if (typeof c.text !== 'string' || !c.text) throw new WorldError(`${c.id}: needs text`);
    validateExpr(c.predicate);
  }
  const seenOb = new Set();
  for (const o of task.obligations ?? []) {
    validateObligation(o);
    if (seenOb.has(o.id)) throw new WorldError(`${task.id}: duplicate obligation ${o.id}`);
    seenOb.add(o.id);
    if (!BUILTIN_ACTIONS.has(o.repairAction) && !(task.actions ?? []).some((a) => a.name === o.repairAction)) {
      throw new WorldError(`${o.id}: repairAction ${o.repairAction} is not in the action surface`);
    }
  }
  for (const g of task.goals ?? []) validateExpr(g.predicate);
  if (task.goal && !task.goals) validateExpr(task.goal.predicate);
  if (!(task.maxSteps > 0)) throw new WorldError(`${task.id}: needs maxSteps > 0`);
  for (const a of task.actions ?? []) {
    if (typeof a.name !== 'string' || BUILTIN_ACTIONS.has(a.name)) {
      throw new WorldError(`${task.id}: bad or reserved custom action name ${a.name}`);
    }
    if (!Array.isArray(a.effects)) throw new WorldError(`${a.name}: needs effects array`);
    for (const e of a.effects) {
      if (typeof e.path !== 'string') throw new WorldError(`${a.name}: effect needs path`);
      validateExpr(e.value);
    }
  }
  return task;
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function setPath(state, path, value) {
  const segs = path.split('.');
  let cur = state;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (cur[s] === null || typeof cur[s] !== 'object') cur[s] = {};
    cur = cur[s];
  }
  const last = segs[segs.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = clone(value);
}

function getPath(state, path) {
  let cur = state;
  for (const s of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[s];
  }
  return cur;
}

export class World {
  constructor(task, { seed = 1, tickCost = null } = {}) {
    validateTask(task);
    this.task = task;
    this.seed = seed;
    this.rand = prng(seed);
    this.state = clone(task.initialState);
    this.tick = 0;
    this.stepIndex = 0;
    this.reached = 0;
    this.passed = 0;
    this.active = [];          // revealed constraints, in reveal order
    this.pending = [...task.constraints].sort((a, b) => a.revealAt - b.revealAt || a.id.localeCompare(b.id));
    this.obSpecs = new Map((task.obligations ?? []).map((o) => [o.id, o]));
    this.obPending = [...(task.obligations ?? [])].sort((a, b) => a.revealAt - b.revealAt || a.id.localeCompare(b.id));
    this.live = new Map();
    this.holding = new Map();  // constraintId -> boolean at end of previous step
    this.records = [];
    this.actionLog = [];
    this.violationsSeen = new Set();
    this.done = false;
    this.terminal = null;
    this.tickCost = tickCost ?? task.tickCost ?? { base: 1, perArg: 0 };
    this.customActions = new Map((task.actions ?? []).map((a) => [a.name, a]));
    this.canaryHits = [];
    this.#reveal();
  }

  #reveal() {
    const newly = [];
    while (this.pending.length && this.pending[0].revealAt <= this.stepIndex) {
      const c = this.pending.shift();
      this.active.push(c);
      newly.push(c);
      this.reached = Math.max(this.reached, this.active.length);
    }
    while (this.obPending.length && this.obPending[0].revealAt <= this.stepIndex) {
      const o = this.obPending.shift();
      this.live.set(o.id, spawn(o, this.tick));
    }
    return newly;
  }

  /** What the agent is allowed to see. No predicates, no future rules, no keys. */
  observe() {
    const goals = this.task.goals ?? (this.task.goal ? [this.task.goal] : []);
    return {
      tick: this.tick,
      step: this.stepIndex,
      state: clone(this.state),
      constraints: this.active.map((c) => ({ id: c.id, text: c.text, since: c.revealAt })),
      obligations: [...this.live.values()].filter((l) => !l.dead).map((l) => observe(l, this.tick)),
      actions: this.actionSurface(),
      progress: { reached: this.reached, passed: this.passed, active: this.active.length },
      stepsLeft: this.task.maxSteps - this.stepIndex,
      // The objective is stated as TEXT. Without it the agent can satisfy every
      // constraint and still never ship, which measures prompt ambiguity rather
      // than long-horizon capability.
      goal: goals.map((g) => g.text).filter(Boolean).join(' ') || null,
    };
  }

  actionSurface() {
    const builtin = [
      { name: 'set', args: ['path', 'value'], cost: 1 },
      { name: 'inc', args: ['path', 'by'], cost: 1 },
      { name: 'push', args: ['path', 'value'], cost: 1 },
      { name: 'remove', args: ['path'], cost: 1 },
      { name: 'noop', args: [], cost: this.task.noopCost ?? 1 },
    ];
    const tenders = [...this.live.values()]
      .filter((l) => !l.dead)
      .map((l) => this.obSpecs.get(l.id).repairAction);
    const uniqueTenders = [...new Set(tenders)];
    for (const name of uniqueTenders) {
      if (!BUILTIN_ACTIONS.has(name)) continue;
      builtin.push({ name, args: ['obligationId'], cost: this.task.tendCost ?? 1 });
    }
    const custom = (this.task.actions ?? []).map((a) => ({
      name: a.name, args: a.args ?? [], cost: a.cost ?? 1, doc: a.doc ?? '',
    }));
    return [...builtin, ...custom];
  }

  #costOf(action) {
    if (action.type === 'noop') return this.task.noopCost ?? this.tickCost.base;
    if (action.type === 'tend') return this.task.tendCost ?? this.tickCost.base;
    const custom = this.customActions.get(action.type);
    if (custom) return custom.cost ?? this.tickCost.base;
    const n = action.args ? Object.keys(action.args).length : 0;
    return this.tickCost.base + this.tickCost.perArg * n;
  }

  #apply(action) {
    const a = action.args ?? {};
    switch (action.type) {
      case 'noop':
        return { ok: true };
      case 'set':
        if (typeof a.path !== 'string') return { ok: false, error: 'set needs path' };
        setPath(this.state, a.path, a.value);
        return { ok: true };
      case 'inc': {
        if (typeof a.path !== 'string') return { ok: false, error: 'inc needs path' };
        const cur = getPath(this.state, a.path);
        const by = typeof a.by === 'number' ? a.by : 1;
        if (typeof cur !== 'number') return { ok: false, error: `inc target not numeric: ${a.path}` };
        setPath(this.state, a.path, cur + by);
        return { ok: true };
      }
      case 'push': {
        if (typeof a.path !== 'string') return { ok: false, error: 'push needs path' };
        const cur = getPath(this.state, a.path);
        if (!Array.isArray(cur)) return { ok: false, error: `push target not array: ${a.path}` };
        cur.push(clone(a.value));
        return { ok: true };
      }
      case 'remove': {
        if (typeof a.path !== 'string') return { ok: false, error: 'remove needs path' };
        setPath(this.state, a.path, undefined);
        return { ok: true };
      }
      case 'tend': {
        const live = this.live.get(a.obligationId);
        if (!live) return { ok: false, error: `no such obligation: ${a.obligationId}` };
        const spec = this.obSpecs.get(a.obligationId);
        if (spec.repairAction !== 'tend') {
          return { ok: false, error: `obligation ${a.obligationId} is tended by ${spec.repairAction}` };
        }
        const tended = repair(live, spec);
        return { ok: tended, error: tended ? undefined : 'obligation already dead' };
      }
      default: {
        const custom = this.customActions.get(action.type);
        if (!custom) return { ok: false, error: `action not in surface: ${action.type}` };
        for (const e of custom.effects) {
          const value = evaluate(e.value, { ...this.state, args: a });
          setPath(this.state, e.path, value);
        }
        const ob = custom.tendsObligation;
        if (ob) {
          const live = this.live.get(ob);
          if (live) repair(live, this.obSpecs.get(ob));
        }
        return { ok: true };
      }
    }
  }

  /**
   * Apply one action. Returns the step record. Never throws on a bad action —
   * an invalid action is a logged failure, not a harness crash (this is the
   * "调用失败不算答错" discipline from SoTALab's rst-hle, applied to actions).
   */
  step(action) {
    if (this.done) throw new WorldError('world already terminated');
    if (!action || typeof action.type !== 'string') {
      return this.#reject(action, 'action needs a type');
    }
    const before = clone(this.state);
    const wasHolding = new Map(this.holding);
    const applied = this.#apply(action);
    const cost = this.#costOf(action);
    const prevTick = this.tick;
    this.tick += cost;

    this.actionLog.push({
      stepIndex: this.stepIndex, tick: this.tick, action: clone(action),
      ok: applied.ok, error: applied.error ?? null, cost,
    });

    if (!applied.ok) {
      this.stepIndex += 1;
      const newly = this.#reveal();
      this.#evaluate(newly, before, [], action);
      this.#checkTerminal();
      return { ok: false, error: applied.error, tick: this.tick, step: this.stepIndex };
    }

    const changed = diffPaths(before, this.state);
    this.#detectCanary(action, changed);

    // Obligations advance on environment time. A tended obligation is immune
    // for this step; everything else keeps burning while the agent works.
    const tendedIds = new Set();
    if (action.type === 'tend' && action.args?.obligationId) tendedIds.add(action.args.obligationId);
    const custom = this.customActions.get(action.type);
    if (custom?.tendsObligation) tendedIds.add(custom.tendsObligation);

    for (const [id, live] of this.live) {
      if (live.dead) continue;
      if (tendedIds.has(id)) { rearm(live); continue; }
      const death = advance(live, this.obSpecs.get(id), cost, this.tick, this.rand);
      rearm(live);
      if (death) {
        const rec = attributeObligationDeath({
          stepIndex: this.stepIndex, death, spec: this.obSpecs.get(id), live,
        });
        this.records.push(rec);
        if (this.task.obligationDeathEndsRun !== false) {
          this.done = true;
          this.terminal = { reason: 'obligation_died', obligationId: id, kind: death.kind };
        }
      }
    }

    const newly = this.#revealPendingForNextStep();
    this.#evaluate(newly, before, changed, action, prevTick);
    this.stepIndex += 1;
    this.#reveal();
    this.#checkTerminal();
    return {
      ok: true, tick: this.tick, step: this.stepIndex,
      changed, violations: this.records.filter((r) => r.stepIndex === this.stepIndex - 1).length,
      done: this.done, terminal: this.terminal,
    };
  }

  #revealPendingForNextStep() {
    // Constraints scheduled for the step we are about to enter become active
    // now, so a freshly revealed rule is evaluated against the post-action
    // state and can produce a `revealed` violation.
    const newly = [];
    while (this.pending.length && this.pending[0].revealAt <= this.stepIndex + 1) {
      const c = this.pending.shift();
      this.active.push(c);
      newly.push(c);
      this.reached = Math.max(this.reached, this.active.length);
    }
    while (this.obPending.length && this.obPending[0].revealAt <= this.stepIndex + 1) {
      const o = this.obPending.shift();
      this.live.set(o.id, spawn(o, this.tick));
    }
    return newly;
  }

  #reject(action, error) {
    this.actionLog.push({
      stepIndex: this.stepIndex, tick: this.tick, action: clone(action), ok: false, error, cost: 0,
    });
    this.stepIndex += 1;
    this.#checkTerminal();
    return { ok: false, error, tick: this.tick, step: this.stepIndex };
  }

  #evaluate(newly, before, changed, action) {
    const newlyIds = new Set(newly.map((c) => c.id));
    let allHold = this.active.length > 0;
    for (const c of this.active) {
      const ok = holds(c.predicate, this.state);
      const prev = this.holding.get(c.id);
      if (!ok) {
        allHold = false;
        const key = `${this.stepIndex}:${c.id}`;
        if (!this.violationsSeen.has(key)) {
          this.violationsSeen.add(key);
          const rec = attribute({
            stepIndex: this.stepIndex,
            tick: this.tick,
            constraint: c,
            wasHolding: prev === true,
            justRevealed: newlyIds.has(c.id),
            changed,
            action,
          });
          fillWitness(rec, this.state);
          this.records.push(rec);
        }
      }
      this.holding.set(c.id, ok);
    }
    // `passed` = the deepest prefix of revealed constraints that all hold at
    // once. Distinct from `reached`, which only counts what was shown.
    if (allHold) this.passed = Math.max(this.passed, this.active.length);
  }

  #detectCanary(action, changed) {
    const canaries = this.task.canaries ?? [];
    if (!canaries.length) return;
    const blob = canonical(action);
    for (const c of canaries) {
      if (blob.includes(c.token)) {
        this.canaryHits.push({ stepIndex: this.stepIndex, canaryId: c.id, via: 'action-args' });
      }
    }
    for (const p of changed) {
      for (const c of canaries) {
        if (c.path && (p === c.path || p.startsWith(`${c.path}.`))) {
          this.canaryHits.push({ stepIndex: this.stepIndex, canaryId: c.id, via: `write:${p}` });
        }
      }
    }
  }

  #checkTerminal() {
    if (this.done) return;
    const goals = this.task.goals ?? (this.task.goal ? [this.task.goal] : []);
    if (goals.length && goals.every((g) => holds(g.predicate, this.state))) {
      // A win requires the ENTIRE rule set to be revealed and holding. Winning
      // while later constraints are still hidden would reward an agent for
      // finishing before the hard part appears, and would make `passed`
      // incomparable across runs.
      const allRevealed = this.pending.length === 0;
      const allHold = allRevealed && this.active.every((c) => holds(c.predicate, this.state));
      const noDead = [...this.live.values()].every((l) => !l.dead) && this.obPending.length === 0;
      if (allHold && noDead) {
        this.done = true;
        this.terminal = { reason: 'goal_met' };
        return;
      }
    }
    if (this.stepIndex >= this.task.maxSteps) {
      this.done = true;
      this.terminal = { reason: 'step_budget' };
    }
  }

  /** Capability profile. Deliberately not a single number. */
  profile() {
    const dead = [...this.live.values()].filter((l) => l.dead).map((l) => l.id);
    return {
      taskId: this.task.id,
      seed: this.seed,
      reached: this.reached,
      passed: this.passed,
      totalConstraints: this.task.constraints.length,
      steps: this.stepIndex,
      ticks: this.tick,
      terminal: this.terminal,
      compliant: this.canaryHits.length === 0,
      canaryHits: this.canaryHits,
      obligationsDead: dead,
      obligationsTotal: (this.task.obligations ?? []).length,
      actions: this.actionLog.length,
      invalidActions: this.actionLog.filter((a) => !a.ok).length,
    };
  }
}