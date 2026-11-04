// vigil-swe check runner. Spawned as a CHILD PROCESS with `--permission` and
// NO --allow-* grants: candidate code can compute but cannot touch the
// filesystem, spawn processes, or open workers (ERR_ACCESS_DENIED). All repo
// modules arrive as data: URLs (already linked by the parent), so relative
// imports resolve to sibling candidate files only.
//
// (Worker threads are NOT used: on Node v24 Windows, worker execArgv does not
// reliably activate the permission model — a spawned process does.)
//
// Protocol: parent writes { urls: {file: dataUrl}, checks: [...] } as JSON on
// stdin; we write { results: [{ id, ok, actual, error }] } as JSON on stdout and
// exit. Any failure is a verdict, never an uncaught exception.

const PER_CHECK_MS = 2000;

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

function timeout() {
  return new Promise((_, rej) => {
    const t = setTimeout(() => rej(new Error('check timeout')), PER_CHECK_MS);
    t.unref?.();
  });
}

function serialisable(v) {
  try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { urls, checks } = JSON.parse(input);
  const results = [];
  const mods = new Map();
  for (const check of checks) {
    const id = check.id;
    try {
      const url = urls[check.entry];
      if (!url) throw new Error(`entry file not in repo: ${check.entry}`);
      if (!mods.has(check.entry)) {
        mods.set(check.entry, await import(url));
      }
      const mod = mods.get(check.entry);
      const fn = mod[check.call];
      if (typeof fn !== 'function') throw new Error(`export ${check.call} is not a function in ${check.entry}`);
      let actual;
      if (check.scenarioSource) {
        // Scenario drivers are authored harness code (not candidate code); they
        // receive the candidate export and drive it through a multi-step check.
        const scenario = (0, eval)(`(${check.scenarioSource})`);
        actual = await Promise.race([Promise.resolve(scenario(fn)), timeout()]);
      } else {
        actual = await Promise.race([Promise.resolve(fn(...(check.args ?? []))), timeout()]);
      }
      results.push({ id, ok: deepEqual(actual, check.expect), actual: serialisable(actual), error: null });
    } catch (e) {
      results.push({ id, ok: false, actual: null, error: String(e?.message ?? e) });
    }
  }
  process.stdout.write(JSON.stringify({ results }));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ fatal: String(e?.message ?? e) }));
  process.exitCode = 1;
});
