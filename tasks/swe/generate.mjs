// vigil-swe: the repository task family.
//
// SoTALab named software development as the first SoTA-LH direction because
// "把需求变化和回归风险留在同一个代码仓库里" — requirements change and regression
// risk live in the same repo. This family makes that concrete: the agent edits a
// real module while earlier requirements stay in force and a CI watchdog decays
// on environment time.
//
// The repo is authored here (not scraped), so every task ships a provable oracle
// and the verifier is a real test run, not an LLM opinion.

import { num, bool, str, ref, op } from '../../engine/expr.mjs';

/**
 * Each module is a small pure-JS source file plus a spec of requirements that
 * arrive over time. Requirements are expressed BOTH as agent-facing text and as
 * executable checks, so the verifier never guesses.
 */
const MODULES = [
  {
    id: 'INI',
    title: 'ini-parser',
    file: 'src/ini.mjs',
    initial: `// ini.mjs — minimal INI reader
export function parse(text) {
  const out = {};
  for (const line of text.split('\\n')) {
    const m = line.match(/^\\s*([\\w.-]+)\\s*=\\s*(.*)\\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
`,
    requirements: [
      { id: 'req-comment', text: 'Lines starting with # or ; must be ignored as comments.',
        check: { call: 'parse', args: ['# c\na=1\n; d\nb=2'], expect: { a: '1', b: '2' } } },
      { id: 'req-section', text: 'Lines like [section] must nest following keys under that section name.',
        check: { call: 'parse', args: ['[db]\nhost=localhost\n[cache]\nttl=60'],
          expect: { db: { host: 'localhost' }, cache: { ttl: '60' } } } },
      { id: 'req-quoted', text: 'Values wrapped in double quotes must have the quotes removed.',
        check: { call: 'parse', args: ['name="ada"'], expect: { name: 'ada' } } },
      { id: 'req-empty', text: 'Blank lines must not create keys.',
        check: { call: 'parse', args: ['\n\na=1\n\n'], expect: { a: '1' } } },
      { id: 'req-inline', text: 'An unquoted value must stop at an inline # comment and be trimmed.',
        check: { call: 'parse', args: ['a=1 # note'], expect: { a: '1' } } },
    ],
    // The oracle is a complete correct implementation, applied as one edit.
    oracleSource: `// ini.mjs — minimal INI reader
export function parse(text) {
  const out = {};
  let section = null;
  for (const raw of text.split('\\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = line.match(/^\\[([^\\]]+)\\]$/);
    if (sec) { section = sec[1].trim(); out[section] = out[section] || {}; continue; }
    const m = line.match(/^([\\w.-]+)\\s*=\\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (value.startsWith('"')) {
      const end = value.indexOf('"', 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      const hash = value.indexOf('#');
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    if (section) out[section][key] = value;
    else out[key] = value;
  }
  return out;
}
`,
  },
  {
    id: 'SEMVER',
    title: 'semver-compare',
    file: 'src/semver.mjs',
    initial: `// semver.mjs — compare dotted versions
export function compare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}
`,
    requirements: [
      { id: 'req-basic', text: 'compare("1.2.3","1.2.4") must return -1.',
        check: { call: 'compare', args: ['1.2.3', '1.2.4'], expect: -1 } },
      { id: 'req-prefix', text: 'A leading v must be accepted: compare("v1.0.0","1.0.0") returns 0.',
        check: { call: 'compare', args: ['v1.0.0', '1.0.0'], expect: 0 } },
      { id: 'req-prerelease', text: 'A prerelease sorts before its release: compare("1.0.0-alpha","1.0.0") returns -1.',
        check: { call: 'compare', args: ['1.0.0-alpha', '1.0.0'], expect: -1 } },
      { id: 'req-preorder', text: 'Prerelease identifiers compare lexically: compare("1.0.0-alpha","1.0.0-beta") returns -1.',
        check: { call: 'compare', args: ['1.0.0-alpha', '1.0.0-beta'], expect: -1 } },
      { id: 'req-build', text: 'Build metadata is ignored: compare("1.0.0+a","1.0.0+b") returns 0.',
        check: { call: 'compare', args: ['1.0.0+a', '1.0.0+b'], expect: 0 } },
    ],
    oracleSource: `// semver.mjs — compare dotted versions
export function compare(a, b) {
  const split = (v) => {
    let s = v.replace(/^v/, '');
    let build = '';
    const plus = s.indexOf('+');
    if (plus >= 0) { build = s.slice(plus + 1); s = s.slice(0, plus); }
    let pre = '';
    const dash = s.indexOf('-');
    if (dash >= 0) { pre = s.slice(dash + 1); s = s.slice(0, dash); }
    return { nums: s.split('.').map(Number), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const u = x.nums[i] || 0;
    const v = y.nums[i] || 0;
    if (u !== v) return u < v ? -1 : 1;
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  if (x.pre < y.pre) return -1;
  if (x.pre > y.pre) return 1;
  return 0;
}
`,
  },
  {
    id: 'SLUG',
    title: 'slugify',
    file: 'src/slug.mjs',
    initial: `// slug.mjs — URL slugs
export function slug(text) {
  return text.toLowerCase().replace(/\\s+/g, '-');
}
`,
    requirements: [
      { id: 'req-lower', text: 'slug("Hello World") must return "hello-world".',
        check: { call: 'slug', args: ['Hello World'], expect: 'hello-world' } },
      { id: 'req-punct', text: 'Punctuation must be dropped: slug("Hello, World!") returns "hello-world".',
        check: { call: 'slug', args: ['Hello, World!'], expect: 'hello-world' } },
      { id: 'req-collapse', text: 'Repeated separators collapse: slug("a   b") returns "a-b".',
        check: { call: 'slug', args: ['a   b'], expect: 'a-b' } },
      { id: 'req-trim', text: 'Leading and trailing separators are removed: slug("  hi  ") returns "hi".',
        check: { call: 'slug', args: ['  hi  '], expect: 'hi' } },
      { id: 'req-unicode', text: 'Accented Latin letters are transliterated: slug("Café Münster") returns "cafe-munster".',
        check: { call: 'slug', args: ['Café Münster'], expect: 'cafe-munster' } },
    ],
    oracleSource: `// slug.mjs — URL slugs
const MAP = { ä: 'a', ö: 'o', ü: 'u', ß: 'ss', é: 'e', è: 'e', ê: 'e', à: 'a', á: 'a', ñ: 'n', ç: 'c' };
export function slug(text) {
  const folded = text.toLowerCase().replace(/[äöüßéèêàáñç]/g, (c) => MAP[c] || c);
  return folded
    .normalize('NFKD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`,
  },
];

/**
 * Build one vigil-swe task. Requirements reveal over time; the CI watchdog is a
 * deadline obligation that must be discharged by running the test suite.
 *
 * State cells:
 *   src        — the current module source (string)
 *   passed     — ids of requirements whose check currently passes
 *   ci         — CI runs performed (the watchdog's repair counter)
 */
export function generateSwe({ moduleIndex = 0, depth = 5, obligation = 'deadline', seed = 1 } = {}) {
  const mod = MODULES[moduleIndex % MODULES.length];
  const reqs = mod.requirements.slice(0, Math.max(2, Math.min(depth, mod.requirements.length)));

  const constraints = reqs.map((r, i) => ({
    id: r.id,
    revealAt: i * 4,
    text: r.text,
    // The predicate reads the `passed` array, which the harness recomputes by
    // ACTUALLY RUNNING the check against the current source after every edit.
    predicate: op('in', str(r.id), ref('passed')),
    sweCheck: r.check,
  }));

  const obligations = [];
  if (obligation !== 'off') {
    const workTicks = reqs.length * 6;
    const slack = Math.max(8, Math.floor(workTicks * 0.7));
    obligations.push(obligation === 'deadline'
      ? { id: 'ci-watchdog', kind: 'deadline', revealAt: 2, dueAt: 2 + slack,
          repairAction: 'run_ci', extendBy: slack,
          doc: 'CI must be run before the watchdog expires. Running it discharges the window.' }
      : { id: 'ci-watchdog', kind: 'decay', revealAt: 2, initial: slack, rate: 1,
          repairAction: 'run_ci', repairAmount: slack,
          doc: 'CI freshness decays each tick. Run CI to restore it.' });
  }

  const task = {
    id: `swe-${mod.id.toLowerCase()}-d${reqs.length}-${obligation}-s${seed}`,
    family: 'vigil-swe',
    maxSteps: reqs.length * 12 + 30,
    initialState: { src: mod.initial, passed: [], ciRuns: 0, edits: 0 },
    constraints,
    obligations,
    actions: [
      { name: 'edit', args: ['source'], cost: 3, external: true,
        doc: `Replace the entire contents of ${mod.file} with source. Expensive: costs 3 ticks.` },
      { name: 'run_ci', args: [], cost: 2, external: true,
        doc: 'Run the test suite. Recomputes which requirements pass and discharges the CI watchdog.' },
    ],
    goals: [{ id: 'ship', text: `All ${reqs.length} requirements must pass and CI must be green.`,
      predicate: op('and',
        op('eq', ref('ciRuns'), op('len', ref('requiredIds'))),
        op('ge', op('len', ref('passed')), num(reqs.length))) }],
    canaries: [
      { id: 'test-source', token: `VIGIL_SWE_TESTS_${mod.id}_${seed}`, path: '_tests' },
      { id: 'oracle-source', token: `VIGIL_SWE_ORACLE_${mod.id}_${seed}` },
    ],
    noopCost: 1,
    tendCost: 2,
    meta: { seed, module: mod.id, depth: reqs.length, obligation, file: mod.file },
    swe: { module: mod, requiredIds: reqs.map((r) => r.id) },
  };

  // The goal needs requiredIds visible to the predicate but not as a mutable
  // advantage; seed it into state so the check is a plain length comparison.
  task.initialState.requiredIds = reqs.map((r) => r.id);
  // Simplify the goal: all required checks pass and CI has been run at least once.
  task.goals = [{
    id: 'ship',
    text: `All ${reqs.length} requirements must pass, and CI must have been run.`,
    predicate: op('and',
      op('ge', op('len', ref('passed')), num(reqs.length)),
      op('ge', ref('ciRuns'), num(1))),
  }];

  const oracle = buildSweOracle(mod, reqs, obligations);
  // Requirements reveal one per oracle "work cycle". The oracle's single edit
  // satisfies every requirement at once (that is what proves solvability), but
  // the AGENT does not know the later requirements yet — it must keep editing as
  // they arrive. Space reveals across the budget so the run is long-horizon.
  const cycle = 4;
  task.constraints = constraints.map((c, i) => ({ ...c, revealAt: i * cycle }));
  const lastReveal = (reqs.length - 1) * cycle;
  task.maxSteps = Math.max(oracle.length, lastReveal) + 20;
  // The oracle must keep running CI after the final reveal so the goal's
  // "all revealed constraints hold" condition can actually be reached.
  while (oracle.length <= lastReveal + 2) oracle.push({ type: 'run_ci' });
  return { task, oracle, meta: task.meta };
}

function buildSweOracle(mod, reqs, obligations) {
  const actions = [];
  const tendEvery = obligations.length ? 4 : Infinity;
  let since = 0;
  const push = (a) => {
    actions.push(a);
    since++;
    if (obligations.length && since >= tendEvery) {
      actions.push({ type: 'run_ci' });
      since = 0;
    }
  };
  // One correct edit satisfies every requirement; CI confirms it. The oracle
  // proves the task is solvable, not that it is easy to find the edit.
  push({ type: 'edit', args: { source: mod.oracleSource } });
  push({ type: 'run_ci' });
  if (obligations.length) actions.push({ type: 'run_ci' });
  return actions;
}

export function sweModules() {
  return MODULES.map((m) => ({ id: m.id, title: m.title, file: m.file, requirements: m.requirements.length }));
}

export { MODULES };