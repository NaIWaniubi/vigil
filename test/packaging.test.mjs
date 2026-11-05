// Packaging / distribution contract.
//
// The repo claims a reviewer can reproduce it offline with one command, exports
// tasks in a Harbor-compatible layout, and ships a container that runs the same
// proof. These tests hold that claim to account:
//
//   * harbor export must cover ALL THREE families and every manifest hash must
//     match the bytes on disk (verified independently of the exporter here),
//   * scripts/reproduce.mjs must exit 0 on the committed repo AND exit nonzero
//     when any of its inputs is tampered with (a check that cannot fail is not
//     a check),
//   * the Dockerfile must reference only paths that exist and install nothing,
//   * the CI workflow must be structurally sane and reference scripts that exist.
//
// YAML is validated with a small indentation/structure lint over the subset
// GitHub Actions uses. There is no YAML library in this repo (zero dependencies)
// so this is deliberately NOT a full YAML parser: it catches tabs, odd
// indentation, non-mapping lines and missing sections, not YAML semantics.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, cpSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function runNode(args, opts = {}) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// YAML subset lint (see file header: structural sanity, not a YAML parser).

const BLOCK_SCALAR = /:\s*[|>][-+]?\s*$/;

function lintYaml(text, name = 'yaml') {
  const problems = [];
  const lines = text.split(/\r?\n/);
  let blockIndent = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const lead = raw.match(/^[ \t]*/)[0];
    if (lead.includes('\t')) {
      problems.push(`${name}:${lineNo}: tab in indentation`);
      continue;
    }
    const indent = lead.length;
    if (blockIndent !== null) {
      if (raw.trim() === '') continue;
      if (indent > blockIndent) continue; // literal block content, not structure
      blockIndent = null;
    }
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    if (indent % 2 !== 0) problems.push(`${name}:${lineNo}: indent ${indent} is not a multiple of 2`);
    const content = raw.slice(indent);
    if (content === '-' || content === '- ') {
      problems.push(`${name}:${lineNo}: empty sequence item`);
      continue;
    }
    if (content.startsWith('- ')) {
      const item = content.slice(2).trim();
      if (!item) {
        problems.push(`${name}:${lineNo}: empty sequence item`);
        continue;
      }
      const looksMapping = /^[^\s:]+:(\s|$)/.test(item);
      const looksScalar = /^[A-Za-z0-9._"'/[{]$/.test(item);
      if (!looksMapping && !looksScalar) {
        problems.push(`${name}:${lineNo}: sequence item is neither a mapping nor a scalar: ${item}`);
      }
      if (BLOCK_SCALAR.test(item)) blockIndent = indent;
      continue;
    }
    const m = content.match(/^([^:#]+):(?:\s+(.*))?$/);
    if (!m) {
      problems.push(`${name}:${lineNo}: not a mapping entry: ${content}`);
      continue;
    }
    if (BLOCK_SCALAR.test(content)) blockIndent = indent;
  }
  return { problems };
}

/** Names of the jobs directly under `jobs:` (two-space indent). */
function jobNames(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, 'no top-level jobs: section');
  const names = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^ */)[0].length;
    if (indent === 0) break; // next top-level key
    if (indent === 2) {
      const m = line.match(/^ {2}([A-Za-z0-9_-]+):/);
      if (m) names.push(m[1]);
    }
  }
  return names;
}

/** Text of one job block, from `  <name>:` to the next line indented <= 2. */
function jobBlock(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.ok(start >= 0, `job ${name} missing`);
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() && !line.trim().startsWith('#') && line.match(/^ */)[0].length <= 2) break;
    out.push(line);
  }
  return out.join('\n');
}

/** Local .mjs scripts referenced by `node <path>` across the workflow. */
function referencedScripts(text) {
  const found = new Set();
  for (const m of text.matchAll(/\bnode\s+([\w./-]+\.mjs)/g)) found.add(m[1]);
  return [...found];
}

// ---------------------------------------------------------------------------
// package.json

test('package.json exposes the packaging entry points', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.reproduce, 'node scripts/reproduce.mjs');
  assert.equal(pkg.scripts['export:harbor'], 'node scripts/harbor-export.mjs dist/harbor');
  assert.equal(pkg.scripts.stats, 'node scripts/stats-report.mjs');
  for (const name of ['test', 'gate', 'audit', 'audit:full', 'audit:quick', 'run']) {
    assert.ok(pkg.scripts[name], `existing script ${name} was dropped`);
  }
  assert.deepEqual(pkg.dependencies, {}, 'the repo must stay dependency-free');
  assert.deepEqual(pkg.devDependencies, {}, 'the repo must stay dependency-free');
});

// ---------------------------------------------------------------------------
// Dockerfile + .dockerignore + compose

const DOCKER_INSTRUCTIONS = new Set([
  'FROM', 'WORKDIR', 'COPY', 'ENV', 'LABEL', 'CMD', 'ENTRYPOINT', 'USER', 'ARG', 'EXPOSE', 'RUN',
]);

function parseDockerfile(text) {
  const problems = [];
  const instructions = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (raw.trimEnd().endsWith('\\')) {
      problems.push(`line ${i + 1}: line continuations are not supported by this linter`);
      continue;
    }
    const m = raw.match(/^([A-Za-z]+)\s+(.+)$/);
    if (!m) {
      problems.push(`line ${i + 1}: not an instruction: ${raw}`);
      continue;
    }
    const cmd = m[1].toUpperCase();
    if (!DOCKER_INSTRUCTIONS.has(cmd)) problems.push(`line ${i + 1}: unknown instruction ${cmd}`);
    instructions.push({ cmd, arg: m[2].trim(), line: i + 1 });
  }
  return { instructions, problems };
}

test('Dockerfile is a valid node:24-slim build that installs nothing', () => {
  const path = join(ROOT, 'Dockerfile');
  assert.ok(existsSync(path), 'Dockerfile missing');
  const { instructions, problems } = parseDockerfile(readFileSync(path, 'utf8'));
  assert.deepEqual(problems, []);

  const froms = instructions.filter((i) => i.cmd === 'FROM');
  assert.equal(froms.length, 1, 'exactly one FROM stage');
  assert.equal(froms[0].arg, 'node:24-slim');

  const workdirs = instructions.filter((i) => i.cmd === 'WORKDIR');
  assert.equal(workdirs.length, 1);
  assert.equal(workdirs[0].arg, '/app');

  const final = instructions.at(-1);
  assert.equal(final.cmd, 'CMD');
  assert.deepEqual(JSON.parse(final.arg), ['node', 'scripts/reproduce.mjs']);

  for (const inst of instructions) {
    assert.doesNotMatch(inst.arg, /\bnpm\s+(install|ci)\b/, `line ${inst.line} installs dependencies`);
    assert.doesNotMatch(inst.arg, /\b(yarn|pnpm)\b/, `line ${inst.line} installs dependencies`);
    if (inst.cmd === 'COPY') {
      const parts = inst.arg.split(/\s+/);
      assert.ok(parts.length >= 2, `line ${inst.line}: COPY needs a source and a destination`);
      for (const src of parts.slice(0, -1)) {
        assert.ok(!src.startsWith('--'), `line ${inst.line}: flags are not expected here`);
        assert.ok(existsSync(join(ROOT, src)), `line ${inst.line}: COPY source does not exist: ${src}`);
      }
    }
  }

  // The command the container runs must exist in the build context.
  assert.ok(existsSync(join(ROOT, 'scripts', 'reproduce.mjs')), 'CMD target scripts/reproduce.mjs missing');
});

test('.dockerignore keeps git history, deps, runs and build output out of the image', () => {
  const path = join(ROOT, '.dockerignore');
  assert.ok(existsSync(path), '.dockerignore missing');
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  for (const required of ['node_modules', 'runs', '.git', 'dist']) {
    assert.ok(lines.includes(required) || lines.includes(`${required}/`), `.dockerignore does not exclude ${required}`);
  }
});

test('docker-compose runs the same reproduction command', () => {
  const path = join(ROOT, 'docker-compose.yml');
  assert.ok(existsSync(path), 'docker-compose.yml missing');
  const text = readFileSync(path, 'utf8');
  assert.deepEqual(lintYaml(text, 'docker-compose.yml').problems, []);
  assert.match(text, /^services:\s*$/m);
  assert.match(text, /^\s{2}reproduce:\s*$/m);
  assert.match(text, /build:\s*\./);
  assert.match(text, /scripts\/reproduce\.mjs/);
});

test('yaml lint is not vacuous: it rejects tabs, odd indentation and junk lines', () => {
  assert.ok(lintYaml('name: ci\njobs:\n\trun: x\n', 'bad').problems.some((p) => /tab/.test(p)));
  assert.ok(lintYaml('jobs:\n   a: 1\n', 'bad').problems.some((p) => /multiple of 2/.test(p)));
  assert.ok(lintYaml('jobs:\n  a:\n    this is not yaml\n', 'bad').problems.some((p) => /mapping entry/.test(p)));
  assert.deepEqual(lintYaml('name: ci\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node x.mjs\n', 'ok').problems, []);
});

// ---------------------------------------------------------------------------
// CI workflow

test('ci workflow wires gate, reproduce, harbor, weekly full audit and pages', () => {
  const path = join(ROOT, '.github', 'workflows', 'ci.yml');
  assert.ok(existsSync(path), 'ci.yml missing');
  const text = readFileSync(path, 'utf8');

  assert.deepEqual(lintYaml(text, 'ci.yml').problems, []);

  assert.deepEqual(jobNames(text).sort(), ['full-audit', 'gate', 'harbor', 'pages', 'reproduce']);

  assert.match(text, /schedule:\s*\n\s+- cron:\s*['"]0 6 \* \* 1['"]/, 'weekly schedule missing');

  const gate = jobBlock(text, 'gate');
  assert.match(gate, /node scripts\/gate\.mjs/);

  const reproduce = jobBlock(text, 'reproduce');
  assert.match(reproduce, /node scripts\/reproduce\.mjs/);

  const harbor = jobBlock(text, 'harbor');
  assert.match(harbor, /node scripts\/harbor-export\.mjs dist\/harbor --quick/);

  const fullAudit = jobBlock(text, 'full-audit');
  assert.match(fullAudit, /github\.event_name == 'schedule'/, 'full audit must be schedule-gated');
  assert.match(fullAudit, /run:\s*node scripts\/self-audit\.mjs\s*$/m, 'full audit must not pass --quick');
  assert.doesNotMatch(fullAudit, /self-audit\.mjs\s+--quick/);
  assert.match(fullAudit, /actions\/upload-artifact@v4/);
  assert.match(fullAudit, /path:\s*docs\/self-audit\.json/);

  const pages = jobBlock(text, 'pages');
  assert.match(pages, /needs:\s*gate/);
  assert.match(pages, /actions\/deploy-pages@v4/);

  for (const script of referencedScripts(text)) {
    assert.ok(existsSync(join(ROOT, script)), `CI references a script that does not exist: ${script}`);
  }
});

// ---------------------------------------------------------------------------
// Harbor export: all three families, manifests verified independently.

function verifyManifestsOnDisk(outRoot) {
  const problems = [];
  let taskDirs = 0;
  let members = 0;
  const dirs = readdirSync(outRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const entry of dirs) {
    taskDirs++;
    const dir = join(outRoot, entry.name);
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      problems.push(`${entry.name}: manifest.json missing`);
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifest.members) || manifest.members.length === 0) {
      problems.push(`${entry.name}: manifest has no members`);
      continue;
    }
    const listed = new Map();
    for (const member of manifest.members) {
      listed.set(member.path, member);
      if (member.path === 'manifest.json') {
        problems.push(`${entry.name}: manifest lists itself`);
        continue;
      }
      const file = join(dir, ...member.path.split('/'));
      if (!existsSync(file)) {
        problems.push(`${entry.name}: listed member missing on disk: ${member.path}`);
        continue;
      }
      const buf = readFileSync(file);
      if (sha(buf) !== member.sha256) problems.push(`${entry.name}: hash mismatch: ${member.path}`);
      if (buf.length !== member.bytes) problems.push(`${entry.name}: byte length mismatch: ${member.path}`);
      members++;
    }
    const files = [];
    const walk = (d, prefix = '') => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(d, e.name), rel);
        else files.push(rel);
      }
    };
    walk(dir);
    for (const f of files) {
      if (f !== 'manifest.json' && !listed.has(f)) problems.push(`${entry.name}: unlisted file: ${f}`);
    }
  }
  return { problems, taskDirs, members };
}

test('harbor export covers core, swe and rush with self-verifying manifests', async (t) => {
  const { exportHarbor, verifyExport } = await import('../scripts/harbor-export.mjs');
  const out = join(tempDir(t, 'vigil-harbor-'), 'harbor');
  const index = exportHarbor(out, { quick: true });
  const dataset = JSON.parse(readFileSync(join(ROOT, 'tasks', 'rush', 'dataset.json'), 'utf8'));

  const families = new Map();
  const dirs = readdirSync(out, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const entry of dirs) {
    const taskYaml = readFileSync(join(out, entry.name, 'task.yaml'), 'utf8');
    const family = taskYaml.match(/^family: (.+)$/m)?.[1];
    assert.ok(family, `${entry.name}: task.yaml has no family`);
    families.set(family, (families.get(family) ?? 0) + 1);

    const envPath = join(out, entry.name, 'environment', 'task.json');
    const oraclePath = join(out, entry.name, 'verifier', 'oracle.json');
    assert.ok(existsSync(envPath), `${entry.name}: environment/task.json missing`);
    assert.ok(existsSync(oraclePath), `${entry.name}: verifier/oracle.json missing`);
    JSON.parse(readFileSync(envPath, 'utf8'));

    const oracle = JSON.parse(readFileSync(oraclePath, 'utf8'));
    assert.ok(Array.isArray(oracle.oracle) && oracle.oracle.length > 0, `${entry.name}: empty oracle`);
    const fingerprint = taskYaml.match(/^fingerprint: ([0-9a-f]{64})$/m)?.[1];
    assert.equal(fingerprint, oracle.fingerprint, `${entry.name}: task.yaml/verifier fingerprint disagree`);
  }

  assert.deepEqual([...families.keys()].sort(), ['vigil-core', 'vigil-rush', 'vigil-swe'],
    'export must cover all three families');
  assert.equal(families.get('vigil-rush'), dataset.tasks.length,
    'every rush dataset task must be exported');

  assert.equal(index.tasks.length, dirs.length, 'index must list every task directory');
  assert.deepEqual([...new Set(index.tasks.map((x) => x.family))].sort(), ['vigil-core', 'vigil-rush', 'vigil-swe']);

  const independent = verifyManifestsOnDisk(out);
  assert.deepEqual(independent.problems, []);
  assert.equal(independent.taskDirs, index.tasks.length);
  assert.ok(independent.members > index.tasks.length * 3, 'each manifest must cover more than 3 members? (sanity)');

  const exported = verifyExport(out);
  assert.equal(exported.ok, true, exported.problems.join('\n'));
});

test('harbor verification detects a modified or deleted member', async (t) => {
  const { exportHarbor, verifyExport } = await import('../scripts/harbor-export.mjs');
  const out = join(tempDir(t, 'vigil-harbor-tamper-'), 'harbor');
  exportHarbor(out, { quick: true });
  assert.equal(verifyExport(out).ok, true);

  const dirs = readdirSync(out, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(dirs.length >= 2);

  const modified = join(out, dirs[0].name, 'environment', 'task.json');
  writeFileSync(modified, Buffer.concat([readFileSync(modified), Buffer.from('\n')]));
  const afterModify = verifyExport(out);
  assert.equal(afterModify.ok, false);
  assert.ok(afterModify.problems.some((p) => /hash mismatch/.test(p)), afterModify.problems.join('\n'));

  rmSync(join(out, dirs[1].name, 'task.yaml'));
  const afterDelete = verifyExport(out);
  assert.equal(afterDelete.ok, false);
  assert.ok(afterDelete.problems.some((p) => /missing/.test(p)), afterDelete.problems.join('\n'));
});

// ---------------------------------------------------------------------------
// reproduce.mjs: the reviewer's one command.

test('scripts/reproduce.mjs proves the committed repo offline in under 120s', () => {
  const started = Date.now();
  const res = runNode(['scripts/reproduce.mjs']);
  const elapsed = Date.now() - started;
  const out = `${res.stdout}\n${res.stderr}`;
  assert.equal(res.status, 0, out);
  for (const check of ['reference-run', 'discrimination', 'rush-calibration', 'rush-samples']) {
    assert.match(out, new RegExp(`${check}\\s+PASS`), `${check} did not pass:\n${out}`);
  }
  assert.match(out, /RESULT: PASS/);
  assert.ok(elapsed < 120_000, `reproduce took ${elapsed}ms, budget is 120s`);
});

test('reproduce fails when the committed reference bundle is tampered', (t) => {
  const dir = tempDir(t, 'vigil-repro-ref-');
  const runDir = join(dir, 'reference-run');
  cpSync(join(ROOT, 'docs', 'reference-run'), runDir, { recursive: true });
  const target = join(runDir, 'results.jsonl');
  const text = readFileSync(target, 'utf8');
  writeFileSync(target, text.replace(/"taskId"/, '"taskId_tampered"'));

  const res = runNode(['scripts/reproduce.mjs', '--reference-run', runDir]);
  const out = `${res.stdout}\n${res.stderr}`;
  assert.notEqual(res.status, 0, out);
  assert.match(out, /reference-run\s+FAIL/, out);
  assert.match(out, /RESULT: FAIL/);
});

test('reproduce fails when docs/discrimination.json is tampered', (t) => {
  const dir = tempDir(t, 'vigil-repro-disc-');
  const path = join(dir, 'discrimination.json');
  const report = JSON.parse(readFileSync(join(ROOT, 'docs', 'discrimination.json'), 'utf8'));
  report.discrimination.verdict = 'TAMPERED';
  writeFileSync(path, JSON.stringify(report, null, 2));

  const res = runNode(['scripts/reproduce.mjs', '--discrimination', path]);
  const out = `${res.stdout}\n${res.stderr}`;
  assert.notEqual(res.status, 0, out);
  assert.match(out, /discrimination\s+FAIL/, out);
});

test('reproduce fails when a rush calibration flag is flipped', (t) => {
  const dir = tempDir(t, 'vigil-repro-dataset-');
  const path = join(dir, 'dataset.json');
  const dataset = JSON.parse(readFileSync(join(ROOT, 'tasks', 'rush', 'dataset.json'), 'utf8'));
  dataset.calibration.greedyMustFail = false;
  writeFileSync(path, JSON.stringify(dataset));

  const res = runNode(['scripts/reproduce.mjs', '--dataset', path]);
  const out = `${res.stdout}\n${res.stderr}`;
  assert.notEqual(res.status, 0, out);
  assert.match(out, /rush-calibration\s+FAIL/, out);
});