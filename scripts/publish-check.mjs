#!/usr/bin/env node
// Pre-publish gate: everything that must be true before the repo goes public.
// Runs offline, changes nothing.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const run = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

const checks = [];
const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

// 1. No secrets in tracked content.
try {
  const hits = run(['grep', '-lE', 'sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}', '--', '.'])
    .split('\n').filter(Boolean);
  add('no secret literals in tracked files', hits.length === 0, hits.join(', '));
} catch (e) {
  add('no secret literals in tracked files', true);
}

// 2. No credential-shaped filenames tracked.
const files = run(['ls-files']).split('\n');
const bad = files.filter((f) => /(^|\/)\.env|\.key$|credential|secret/i.test(f));
add('no credential files tracked', bad.length === 0, bad.join(', '));

// 3. Required public artifacts exist.
for (const f of ['README.md', 'LICENSE', 'NOTICE', 'docs/PROTOCOL.md',
  'docs/SELF-AUDIT.md', 'docs/CHANNELS.md', 'docs/reference-run/MANIFEST.sha256',
  'tasks/rush/dataset.json', 'web/index.html']) {
  add(`present: ${f}`, existsSync(join(ROOT, f)));
}

// 4. Reference bundle verifies.
try {
  execFileSync(process.execPath, ['scripts/verify.mjs', 'docs/reference-run'], { cwd: ROOT, stdio: 'pipe' });
  add('reference run verifies (manifest + prompt + numbers)', true);
} catch (e) {
  add('reference run verifies (manifest + prompt + numbers)', false, String(e.stdout ?? '').slice(-200));
}

// 5. Dataset is the calibrated one.
try {
  const ds = JSON.parse(readFileSync(join(ROOT, 'tasks/rush/dataset.json'), 'utf8'));
  add('dataset calibrated (all defeat greedy)', ds.stats.allDefeatGreedy === true,
    `${ds.tasks.length} tasks, depth ${ds.stats.depthMin}-${ds.stats.depthMax}`);
} catch (e) {
  add('dataset calibrated (all defeat greedy)', false, e.message);
}

// 6. Working tree clean.
const dirty = run(['status', '--porcelain']);
add('working tree clean', dirty === '', dirty.split('\n').slice(0, 5).join(' | '));

// 7. Remote configured?
let remote = '';
try { remote = run(['config', '--get', 'remote.origin.url']); } catch { /* none */ }
add('git remote configured', !!remote, remote || 'run: git remote add origin <url>');

let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  if (!c.ok) failed++;
}
console.log(failed ? `\nPUBLISH-CHECK: ${failed} blocking` : '\nPUBLISH-CHECK: ready to publish');
process.exit(failed ? 1 : 0);
