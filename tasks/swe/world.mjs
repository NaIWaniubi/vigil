// SweWorld: a World whose state includes real executable source.
//
// The base World applies actions synchronously; swe actions must run candidate
// code asynchronously. Rather than making the whole engine async, SweWorld
// overrides `step` to (1) run the real checks, (2) write the resulting `passed`
// array into state, then (3) delegate to the base engine with a `set` action
// that carries the computed state. Attribution and obligations stay identical.

import { World } from '../../engine/index.mjs';
import { applySweAction, runAll } from './verify.mjs';

export class SweWorld extends World {
  constructor(task, opts = {}) {
    super(task, opts);
    this.sweChecks = [];
  }

  static async create(task, opts = {}) {
    const w = new SweWorld(task, opts);
    // Seed `passed` from the initial source so step 0 is truthful.
    const { passed, results } = await runAll(w.state.src, task.constraints);
    w.state.passed = passed;
    w.sweChecks.push({ step: -1, results });
    w.holding = new Map();
    return w;
  }

  async stepAsync(action) {
    if (this.done) throw new Error('world already terminated');
    if (action?.type === 'edit' || action?.type === 'run_ci') {
      const applied = await applySweAction(this.state, action, this.task.constraints);
      if (!applied.ok) return super.step(action);
      if (applied.checks) this.sweChecks.push({ step: this.stepIndex, results: applied.checks });
      // Hand the computed state to the engine so its before/after diff sees the
      // real change and attribution stays deterministic.
      const res = super.step({ type: '__swe_sync', args: { action, state: applied.state } });
      return res;
    }
    return super.step(action);
  }
}