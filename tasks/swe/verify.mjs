// Executes vigil-swe requirement checks against the agent's current source.
//
// Isolation: the candidate module is loaded from a data: URL, so it cannot read
// the filesystem, cannot see the verifier, and cannot import anything from the
// harness. A thrown error or a timeout is a FAILED check, not a harness crash.
//
// This is what makes the attribution trustworthy: `passed` is recomputed by
// running code, never by asking a model whether the code looks right.

const CHECK_TIMEOUT_MS = 2000;

/** Load candidate source in isolation and return its exports. */
async function loadModule(source) {
  const url = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(url);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

/**
 * Run one requirement check. Returns { id, ok, actual, error }.
 * Never throws: a broken candidate must produce a verdict, not an exception.
 */
export async function runCheck(source, check, id) {
  let mod;
  try {
    mod = await loadModule(source);
  } catch (e) {
    return { id, ok: false, actual: null, error: `module load: ${e.message}` };
  }
  const fn = mod[check.call];
  if (typeof fn !== 'function') {
    return { id, ok: false, actual: null, error: `export ${check.call} is not a function` };
  }
  try {
    const actual = await Promise.race([
      Promise.resolve(fn(...check.args)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('check timeout')), CHECK_TIMEOUT_MS)),
    ]);
    return { id, ok: deepEqual(actual, check.expect), actual, error: null };
  } catch (e) {
    return { id, ok: false, actual: null, error: `threw: ${e.message}` };
  }
}

/** Run every requirement, returning the ids that pass plus per-check detail. */
export async function runAll(source, constraints) {
  const results = [];
  for (const c of constraints) {
    if (!c.sweCheck) continue;
    results.push(await runCheck(source, c.sweCheck, c.id));
  }
  return { passed: results.filter((r) => r.ok).map((r) => r.id), results };
}

/**
 * Apply the vigil-swe action surface to a world state.
 * Called by the swe runner after each action so `passed` always reflects reality.
 */
export async function applySweAction(state, action, constraints) {
  const next = { ...state };
  if (action.type === 'edit') {
    if (typeof action.args?.source !== 'string') {
      return { state: next, ok: false, error: 'edit needs args.source (string)' };
    }
    next.src = action.args.source;
    next.edits = (next.edits ?? 0) + 1;
    const { passed, results } = await runAll(next.src, constraints);
    next.passed = passed;
    return { state: next, ok: true, checks: results };
  }
  if (action.type === 'run_ci') {
    next.ciRuns = (next.ciRuns ?? 0) + 1;
    const { passed, results } = await runAll(next.src, constraints);
    next.passed = passed;
    return { state: next, ok: true, checks: results };
  }
  return { state: next, ok: true };
}