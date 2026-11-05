// SweWorld: a World whose state includes a real executable multi-file repo.
//
// The base World applies actions synchronously; swe actions must run candidate
// code asynchronously (in a permission-restricted worker). SweWorld overrides
// `stepAsync` to (1) run the real checks over the WHOLE repo, (2) write the
// resulting file map + `passed` array into state, then (3) delegate to the base
// engine with the internal `__swe_sync` action that carries the computed state.
// Attribution, obligations, canaries and the full-reveal goal stay identical to
// the base engine — the engine is never modified.

import { World } from '../../engine/index.mjs';
import { applySweAction, runAll } from './verify.mjs';

export class SweWorld extends World {
  constructor(task, opts = {}) {
    super(task, opts);
    this.sweChecks = [];
  }

  static async create(task, opts = {}) {
    const w = new SweWorld(task, opts);
    // Seed `passed` from the initial repo so step 0 is truthful.
    const { passed, results } = await runAll(w.state.files, task.constraints);
    w.state.passed = passed;
    w.sweChecks.push({ step: -1, results });
    w.holding = new Map();
    return w;
  }

  async stepAsync(action) {
    if (this.done) throw new Error('world already terminated');
    if (action?.type === 'edit' || action?.type === 'run_ci') {
      const applied = await applySweAction(this.state, action, this.task.constraints);
      if (!applied.ok) {
        // A rejected swe action is a logged failure, not a harness crash. The
        // base engine's #apply would iterate custom.effects (absent on external
        // actions), so route through __swe_sync with ok:false instead.
        this.actionLog.push({
          stepIndex: this.stepIndex, tick: this.tick, action, ok: false, error: applied.error, cost: 0,
        });
        this.stepIndex += 1;
        this.#checkTerminalPublic();
        return { ok: false, error: applied.error, tick: this.tick, step: this.stepIndex };
      }
      if (applied.checks) this.sweChecks.push({ step: this.stepIndex, results: applied.checks });
      // Hand the computed state to the engine so its before/after diff sees the
      // real change (files.*, passed) and attribution stays deterministic.
      const res = super.applyInternal('__swe_sync', { action, state: applied.state }, action);
      return res;
    }
    return super.step(action);
  }

  #checkTerminalPublic() {
    // Mirror the base engine's terminal check after a rejected action without
    // touching state: step budget still applies.
    if (!this.done && this.stepIndex >= this.task.maxSteps) {
      this.done = true;
      this.terminal = { reason: 'step_budget' };
    }
  }

  /**
   * Hide what the agent has not earned yet: `requiredIds` names every future
   * requirement, and `passed` is recomputed against ALL constraints including
   * unrevealed ones. Only revealed ids may be visible.
   */
  observe() {
    const base = super.observe();
    const revealed = new Set(this.active.map((c) => c.id));
    const state = { ...base.state };
    delete state.requiredIds;
    state.passed = (state.passed ?? []).filter((id) => revealed.has(id));
    return { ...base, state };
  }
}
