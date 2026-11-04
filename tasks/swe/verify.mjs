// Executes vigil-swe requirement checks against the agent's WHOLE repository.
//
// Isolation model (two layers):
//   1. Every repo file is loaded from a data: URL. Relative imports between repo
//      files are rewritten to the corresponding data: URLs, so cross-module
//      imports really execute but can only reach other candidate files — never
//      the harness, never the disk by path.
//   2. The load + check run happens in a CHILD PROCESS started with
//      --permission and NO --allow-* grants. Node's permission model then
//      denies every filesystem read, child process and worker spawn from
//      candidate code (ERR_ACCESS_DENIED), including dynamic import('node:fs')
//      followed by a read. A hung candidate (infinite loop) is killed with the
//      process and reported as a timeout verdict, never a harness hang.
//      (Worker threads are not used: on Node v24 Windows their execArgv does
//      not reliably activate the permission model; a spawned process does.)
//
// A thrown error, a syntax error, a missing file or a timeout is a FAILED
// check with an error verdict — never a harness crash. `passed` is recomputed
// by running code, never by asking a model whether the code looks right.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './repos.mjs';

const DEFAULT_TIMEOUT_MS = 15000;
const RUNNER_PATH = fileURLToPath(new URL('./check-worker.mjs', import.meta.url));

/**
 * Rewrite relative import specifiers to data: URLs of the sibling repo files.
 * Only string-literal specifiers in `from '...'` / `import '...'` /
 * `import('...')` positions are rewritten; anything else is left untouched and
 * will fail resolution inside the sandbox (a failed check, not a crash).
 *
 * Linking is TRANSITIVE: a file's data: URL embeds the ALREADY-LINKED URLs of
 * its dependencies, so `index -> router -> query` resolves at every hop. Repo
 * files are authored acyclic; a cycle (or a missing file) is a link error and
 * fails the checks rather than looping.
 */
export function linkRepo(files) {
  const resolveRel = (fromFile, spec) => {
    const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
    const parts = dir ? dir.split('/') : [];
    for (const seg of spec.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts.join('/');
  };
  const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.[^'"]*)\2/g;
  const deps = new Map();
  const errors = [];
  for (const [name, source] of Object.entries(files)) {
    const list = [];
    for (const m of source.matchAll(IMPORT_RE)) {
      const target = resolveRel(name, m[3]);
      if (!Object.hasOwn(files, target)) errors.push(`${name}: import of missing repo file ${m[3]}`);
      else list.push(target);
    }
    deps.set(name, list);
  }
  const urls = new Map();
  const state = new Map(); // name -> 'visiting' | 'done'
  const link = (name) => {
    if (state.get(name) === 'done') return urls.get(name);
    if (state.get(name) === 'visiting') {
      errors.push(`${name}: import cycle in repo`);
      return null;
    }
    state.set(name, 'visiting');
    const depUrls = new Map();
    for (const d of deps.get(name) ?? []) {
      const u = link(d);
      if (u) depUrls.set(d, u);
    }
    const rewritten = files[name].replace(IMPORT_RE, (whole, head, quote, spec) => {
      const target = resolveRel(name, spec);
      const u = depUrls.get(target);
      return u ? `${head}${quote}${u}${quote}` : whole;
    });
    const url = `data:text/javascript;base64,${Buffer.from(rewritten, 'utf8').toString('base64')}`;
    urls.set(name, url);
    state.set(name, 'done');
    return url;
  };
  for (const name of Object.keys(files)) link(name);
  return { urls, errors };
}

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

/** Serialise one check for the worker. Scenarios ship as source, not closures. */
function packCheck(check, id) {
  const packed = { id, entry: check.entry, call: check.call, args: check.args ?? [], expect: check.expect };
  if (check.scenario) {
    const fn = SCENARIOS[check.scenario];
    if (!fn) return { error: `unknown scenario ${check.scenario}` };
    packed.scenarioSource = fn.toString();
  }
  return packed;
}

/**
 * Run a batch of checks against one repo snapshot in a FRESH permission-
 * restricted child process. One process per batch is deliberate: a candidate
 * cannot poison state across checks, and a hung candidate is killed with its
 * process. Process start dominates latency (~1s on Windows); callers that
 * need throughput should run batches concurrently.
 * Returns [{ id, ok, actual, error }]. Never throws.
 */
function runBatch(files, checks, timeoutMs) {
  return new Promise((resolve) => {
    const { urls, errors } = linkRepo(files);
    if (errors.length) {
      resolve(checks.map((c) => ({ id: c.id, ok: false, actual: null, error: `link: ${errors[0]}` })));
      return;
    }
    const packed = [];
    for (const c of checks) {
      const p = packCheck(c.sweCheck ?? c, c.id);
      if (p.error) {
        resolve(checks.map((x) => ({ id: x.id, ok: false, actual: null, error: p.error })));
        return;
      }
      packed.push(p);
    }
    let child;
    try {
      child = spawn(process.execPath, ['--permission', RUNNER_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolve(checks.map((c) => ({ id: c.id, ok: false, actual: null, error: `runner: ${e.message}` })));
      return;
    }
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (results) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      resolve(results);
    };
    const failAll = (msg) => finish(checks.map((c) => ({ id: c.id, ok: false, actual: null, error: msg })));
    const timer = setTimeout(() => failAll('check timeout: candidate exceeded the time budget'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => failAll(`runner error: ${e.message}`));
    child.on('exit', (code) => {
      if (settled) return;
      let msg;
      try { msg = JSON.parse(stdout); } catch { failAll(`runner protocol (exit ${code}): ${(stderr || stdout).slice(0, 300)}`); return; }
      if (!msg || !Array.isArray(msg.results)) { failAll(`runner protocol: ${JSON.stringify(msg).slice(0, 300)}`); return; }
      finish(msg.results.map((r) => ({
        id: r.id,
        ok: r.ok === true && deepEqual(r.actual, checks.find((c) => c.id === r.id)?.sweCheck?.expect ?? checks.find((c) => c.id === r.id)?.expect),
        actual: r.actual ?? null,
        error: r.error ?? null,
      })));
    });
    child.stdin.on('error', () => { /* child died early; exit handler reports it */ });
    child.stdin.end(JSON.stringify({ urls: Object.fromEntries(urls), checks: packed }));
  });
}

/**
 * Run every requirement against a whole repo (file -> source map).
 * Returns { passed: [ids], results: [{ id, ok, actual, error }] }.
 */
export async function runAll(files, constraints, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const checks = constraints.filter((c) => c.sweCheck);
  if (!checks.length) return { passed: [], results: [] };
  const results = await runBatch(files, checks, timeoutMs);
  return { passed: results.filter((r) => r.ok).map((r) => r.id), results };
}

/**
 * Run bare checks (no constraint wrapper) against a repo. Used by tests and
 * tooling. Each check: { entry, call, args?, scenario?, expect }.
 */
export async function runRepo(files, checks, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const wrapped = checks.map((c, i) => ({ id: c.id ?? `check-${i}`, sweCheck: c }));
  const { passed, results } = await runAll(files, wrapped, { timeoutMs });
  return { passed, results };
}

/**
 * Apply the vigil-swe action surface to a world state.
 * State holds `files` (file -> source), `passed`, `ciRuns`, `edits`.
 */
export async function applySweAction(state, action, constraints, { timeoutMs } = {}) {
  const next = { ...state, files: { ...state.files } };
  if (action.type === 'edit') {
    const file = action.args?.file;
    const source = action.args?.source;
    if (typeof file !== 'string' || !Object.hasOwn(next.files, file)) {
      return { state, ok: false, error: `edit needs args.file naming an existing repo file (got ${JSON.stringify(file)})` };
    }
    if (typeof source !== 'string') {
      return { state, ok: false, error: 'edit needs args.source (string)' };
    }
    next.files[file] = source;
    next.edits = (next.edits ?? 0) + 1;
    const { passed, results } = await runAll(next.files, constraints, { timeoutMs });
    next.passed = passed;
    return { state: next, ok: true, checks: results };
  }
  if (action.type === 'run_ci') {
    next.ciRuns = (next.ciRuns ?? 0) + 1;
    const { passed, results } = await runAll(next.files, constraints, { timeoutMs });
    next.passed = passed;
    return { state: next, ok: true, checks: results };
  }
  return { state: next, ok: true };
}
