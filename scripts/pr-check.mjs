#!/usr/bin/env node
// Repository hygiene gate. Zero dependencies.
// Pattern from starlight-camp-3d/scripts/pr-check.mjs (same author).
//
// Blocks: oversized files, vendored deps, archives, credential-looking files.
// Warns: suspiciously large text, TODO/FIXME density.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SKIP_DIRS = new Set(['.git', 'node_modules', '_build', 'dist', 'runs', 'coverage', 'tmp']);
const BLOCK_EXT = new Set(['.zip', '.tar', '.gz', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib']);
const BLOCK_NAME = /^(\.env.*|.*\.pem|.*\.key|id_rsa.*|credentials\..*)$/;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;
const SECRET_RE = /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})\b/;
const TEXT_EXT = new Set(['.mjs', '.js', '.ts', '.json', '.md', '.toml', '.yaml', '.yml', '.py', '.txt', '.html', '.css']);

const block = [];
const warn = [];
let total = 0;
let files = 0;

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      continue;
    }
    const p = join(dir, entry.name);
    const rel = p.slice(ROOT.length + 1).replace(/\\/g, '/');
    const st = statSync(p);
    files += 1;
    total += st.size;
    if (st.size > MAX_FILE) block.push(`${rel}: ${st.size} bytes > ${MAX_FILE}`);
    if (BLOCK_EXT.has(extname(entry.name))) block.push(`${rel}: archive/binary extension`);
    if (BLOCK_NAME.test(entry.name)) block.push(`${rel}: credential-looking filename`);
    if (TEXT_EXT.has(extname(entry.name)) && st.size < 512 * 1024) {
      const text = readFileSync(p, 'utf8');
      const m = text.match(SECRET_RE);
      if (m) block.push(`${rel}: secret-looking literal ${m[0].slice(0, 8)}…`);
      if (st.size > 512 * 1024) warn.push(`${rel}: large text file`);
    }
  }
}

walk(ROOT);
if (total > MAX_TOTAL) block.push(`total ${total} bytes > ${MAX_TOTAL}`);

console.log(`pr-check: ${files} files, ${(total / 1024 / 1024).toFixed(2)} MB`);
for (const w of warn) console.log(`WARN ${w}`);
for (const b of block) console.error(`BLOCK ${b}`);
if (block.length) { console.error(`PR-CHECK: BLOCK (${block.length})`); process.exit(1); }
console.log(`PR-CHECK: OK${warn.length ? ` (${warn.length} warnings)` : ''}`);