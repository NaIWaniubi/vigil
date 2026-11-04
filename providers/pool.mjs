// Per-channel concurrency + rate limiting for the cluster runner.
//
// Each channel id gets a max in-flight cap and a minimum interval between call
// starts. The pool guarantees: never more than `max` cells running on one
// channel, at least `paceMs` between consecutive starts on that channel, and at
// most `concurrency` cells running globally. `acquire` resolves with a release
// function; calling it frees the slot and wakes waiters.

export class ChannelPool {
  constructor({ concurrency = 6, channels = {}, paceMs = 0 } = {}) {
    this.globalMax = concurrency;
    this.globalActive = 0;
    this.paceMs = paceMs;
    this.defaultCap = 2;
    this.channels = new Map();
    for (const [id, cap] of Object.entries(channels)) {
      this.channels.set(id, { max: cap, active: 0, lastStart: 0 });
    }
    this.waiters = []; // { id, resolve }
    this.timer = null;
  }

  #chan(id) {
    if (!this.channels.has(id)) {
      this.channels.set(id, { max: this.defaultCap, active: 0, lastStart: 0 });
    }
    return this.channels.get(id);
  }

  #canStart(id) {
    const ch = this.#chan(id);
    return this.globalActive < this.globalMax
      && ch.active < ch.max
      && Date.now() - ch.lastStart >= this.paceMs;
  }

  #grant(id, resolve) {
    const ch = this.#chan(id);
    this.globalActive++;
    ch.active++;
    ch.lastStart = Date.now();
    let released = false;
    resolve(() => {
      if (released) return;
      released = true;
      ch.active = Math.max(0, ch.active - 1);
      this.globalActive = Math.max(0, this.globalActive - 1);
      this.#drain();
    });
  }

  #drain() {
    for (let i = 0; i < this.waiters.length;) {
      const w = this.waiters[i];
      if (this.#canStart(w.id)) {
        this.waiters.splice(i, 1);
        this.#grant(w.id, w.resolve);
      } else {
        i++;
      }
    }
    this.#schedule();
  }

  #schedule() {
    if (this.timer || !this.waiters.length) return;
    // Re-check soon even when paceMs is 0: a waiter blocked by capacity needs a
    // release to wake it, but a waiter blocked only by pace needs a timer. The
    // timer is NOT unref'd: while waiters exist the pool has pending work and
    // must keep the event loop alive, otherwise a process whose only remaining
    // task is a pace-blocked acquire would exit before the timer fires.
    const delay = this.paceMs > 0 ? this.paceMs + 5 : 10;
    this.timer = setTimeout(() => { this.timer = null; this.#drain(); }, delay);
  }

  /** Acquire a slot. Resolves with a release() function. */
  acquire(id) {
    return new Promise((resolve) => {
      if (this.#canStart(id)) { this.#grant(id, resolve); return; }
      this.waiters.push({ id, resolve });
      // Always arm a timer when there are waiters: a waiter may be blocked only
      // by the pace interval (channel/global capacity free), and no release will
      // ever come to wake it. Without this timer the pool deadlocks.
      this.#schedule();
    });
  }

  stats() {
    return {
      globalActive: this.globalActive,
      waiting: this.waiters.length,
      channels: Object.fromEntries([...this.channels.entries()].map(([id, c]) => [id, { active: c.active, max: c.max }])),
    };
  }
}