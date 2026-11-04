#!/usr/bin/env node
// Quality gate. Fixed argv (never through a shell) so Windows Git Bash cannot
// silently route the command into WSL. Pattern borrowed from
// studio/scripts/cluster-gate.ts (MIT, HBAI-Ltd) — see NOTICE.
//
// Every step prints the exact command needed to reproduce a failure by hand.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const STEPS = [
  { name: 'engine + attribution + boundary tests', argv: [process.execPath, '--test', 'test/*.test.mjs'] },
  // Quick audit by default: the gate must stay fast enough to run on every
  // change. The full 586-configuration audit is `npm run audit:full` and is
  // required before publishing a run bundle.
  { name: 'task oracle self-audit (quick)', argv: [process.execPath, 'scripts/self-audit.mjs', '--quick', '--no-write'] },
  { name: 'repo hygiene', argv: [process.execPath, 'scripts/pr-check.mjs'] },
];

const skip = new Set(process.argv.slice(2).filter((a) => a.startsWith('--skip=')).map((a) => a.slice(7)));
const isolated = mkdtempSync(join(tmpdir(), 'vigil-gate-'));
const failures = [];

console.log(`vigil gate · root=${ROOT}`);
console.log(`isolated data dir=${isolated}\n`);

for (const step of STEPS) {
  if (skip.has(step.name)) { console.log(`SKIP ${step.name}`); continue; }
  const started = Date.now();
  const res = spawnSync(step.argv[0], step.argv.slice(1), {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, VIGIL_DATA_DIR: isolated, NO_COLOR: '1' },
    shell: false,
  });
  const ms = Date.now() - started;
  if (res.status === 0) {
    console.log(`\nPASS ${step.name} (${ms}ms)\n`);
  } else {
    console.error(`\nFAIL ${step.name} exit=${res.status} (${ms}ms)`);
    console.error(`  reproduce: ${step.argv.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}\n`);
    failures.push(step.name);
    break; // fail fast: later steps assume earlier invariants
  }
}

rmSync(isolated, { recursive: true, force: true });

if (failures.length) {
  console.error(`GATE: FAIL (${failures.join(', ')})`);
  process.exit(1);
}
console.log('GATE: PASS');