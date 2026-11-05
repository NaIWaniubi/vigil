#!/usr/bin/env node
// Reproduction verifier. Three independent checks, any failure exits 1.
//
//   1. MANIFEST — every file in the run bundle matches its recorded sha256,
//      and no unlisted file has appeared.
//   2. PROTOCOL — the prompt fingerprint recorded in protocol.json matches a
//      freshly computed hash of the current prompt module. A silent prompt edit
//      invalidates the run.
//   3. NUMBERS — recomputing the aggregate from results.jsonl reproduces the
//      published report exactly.
//
// Workflow adapted from the CC0 evals/verify.py (see NOTICE).

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { aggregate } from '../stats/aggregate.mjs';
import { SYSTEM_PROMPT, PROMPT_VERSION } from '../providers/prompt.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).replace(/\\/g, '/'));
  }
  return out.sort();
}

function checkManifest(dir) {
  const path = join(dir, 'MANIFEST.sha256');
  if (!existsSync(path)) return { ok: false, problems: ['MANIFEST.sha256 missing — run with --write first'] };
  const listed = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (!m) return { ok: false, problems: [`malformed manifest line: ${line.slice(0, 60)}`] };
    listed.set(m[2], m[1]);
  }
  const problems = [];
  const actual = walk(dir).filter((f) => f !== 'MANIFEST.sha256');
  for (const f of actual) {
    if (!listed.has(f)) { problems.push(`unlisted file: ${f}`); continue; }
    if (sha(readFileSync(join(dir, f))) !== listed.get(f)) problems.push(`hash mismatch: ${f}`);
  }
  for (const f of listed.keys()) {
    if (!actual.includes(f)) problems.push(`missing file: ${f}`);
  }
  return { ok: problems.length === 0, problems, files: actual.length };
}

function checkProtocol(dir) {
  const path = join(dir, 'protocol.json');
  if (!existsSync(path)) return { ok: false, problems: ['protocol.json missing'] };
  const p = JSON.parse(readFileSync(path, 'utf8'));
  const problems = [];
  const current = sha(SYSTEM_PROMPT);
  if (p.promptSha256 !== current) {
    problems.push(`prompt fingerprint changed: run=${p.promptSha256?.slice(0, 12)} current=${current.slice(0, 12)}`);
  }
  if (p.promptVersion !== PROMPT_VERSION) {
    problems.push(`prompt version changed: run=${p.promptVersion} current=${PROMPT_VERSION}`);
  }
  return { ok: problems.length === 0, problems, promptSha256: current };
}

function checkNumbers(dir) {
  const path = join(dir, 'report.json');
  if (!existsSync(path)) return { ok: false, problems: ['report.json missing — run: node scripts/verify.mjs <dir> --write'] };
  const published = JSON.parse(readFileSync(path, 'utf8'));
  const fresh = aggregate(dir);
  // Compare the WHOLE report except fields that are legitimately
  // run-environment-specific. A partial comparison let an edited unchecked
  // field pass, which contradicts the "tamper one byte -> exit 1" claim.
  const IGNORE = new Set(['generatedAt', 'run']);
  const problems = [];
  const walk = (a, b, at) => {
    if (problems.length > 20) return;
    if (a === b) return;
    const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
    const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
    if (ta !== tb) { problems.push(`${at}: type ${ta} vs ${tb}`); return; }
    if (ta === 'object' || ta === 'array') {
      if (ta === 'array') {
        if (a.length !== b.length) { problems.push(`${at}: length ${a.length} vs ${b.length}`); return; }
        for (let i = 0; i < a.length; i++) walk(a[i], b[i], `${at}[${i}]`);
        return;
      }
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) {
        if (!at && IGNORE.has(k)) continue;
        walk(a[k], b[k], at ? `${at}.${k}` : k);
      }
      return;
    }
    problems.push(`${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  };
  walk(published, fresh, '');
  return { ok: problems.length === 0, problems };
}

function writeManifest(dir) {
  const files = walk(dir).filter((f) => f !== 'MANIFEST.sha256');
  const lines = files.map((f) => `${sha(readFileSync(join(dir, f)))}  ${f}`);
  writeFileSync(join(dir, 'MANIFEST.sha256'), `${lines.join('\n')}\n`);
  return files.length;
}

const args = process.argv.slice(2);
const write = args.includes('--write');
const dir = resolve(args.find((a) => !a.startsWith('--')) ?? '.');

if (!existsSync(dir)) { console.error(`no such run dir: ${dir}`); process.exit(1); }

if (write) {
  const report = aggregate(dir);
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const n = writeManifest(dir);
  console.log(`wrote report.json and MANIFEST.sha256 (${n} files)`);
}

const checks = { manifest: checkManifest(dir), protocol: checkProtocol(dir), numbers: checkNumbers(dir) };
let failed = 0;
for (const [name, c] of Object.entries(checks)) {
  if (c.ok) console.log(`PASS ${name}${c.files ? ` (${c.files} files)` : ''}`);
  else {
    failed++;
    console.error(`FAIL ${name}`);
    for (const p of c.problems) console.error(`  ${p}`);
  }
}
if (failed) { console.error(`VERIFY: FAIL (${failed} checks)`); process.exit(1); }
console.log('VERIFY: PASS — bundle is intact, protocol unchanged, numbers reproduce exactly');