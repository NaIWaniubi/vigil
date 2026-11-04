#!/usr/bin/env node
// Emit `export KEY='...'` lines for the LOCAL/RELAY gateways so a run can use
// them without storing secrets in a file. Keys are read from the ZCode config at
// runtime and written only to stdout for `eval`; nothing is persisted and no
// value is logged by this script.
//
// Usage: eval "$(node scripts/load-local-keys.mjs)"

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.VIGIL_ZCODE_CONFIG,
  'E:/myzcode/.zcode/v2/config.json',
  join(homedir(), '.zcode/v2/config.json'),
].filter(Boolean);

const URL_TO_ENV = [
  ['127.0.0.1:3065', 'AGENT2API_API_KEY'],
  ['127.0.0.1:7871', 'OPENCSG_API_KEY'],
  ['127.0.0.1:8010', 'ORCATERM_API_KEY'],
  ['127.0.0.1:3425', 'MAGPIE_API_KEY'],
  ['127.0.0.1:4100', 'TIERFLOW_API_KEY'],
];

const path = CANDIDATES.find((p) => existsSync(p));
if (!path) {
  console.error('# no ZCode config found');
  process.exit(0);
}

const cfg = JSON.parse(readFileSync(path, 'utf8'));
const providers = Object.values(cfg.provider ?? {});
const found = new Map();
for (const p of providers) {
  const url = String(p.baseUrl ?? p.baseURL ?? p.options?.baseURL ?? '');
  const key = p.apiKey ?? p.options?.apiKey ?? p.key;
  if (!key || typeof key !== 'string') continue;
  for (const [needle, envName] of URL_TO_ENV) {
    if (url.includes(needle) && !found.has(envName)) found.set(envName, key);
  }
}

for (const [envName, key] of found) {
  console.log(`export ${envName}='${key.replace(/'/g, `'\\''`)}'`);
}
console.error(`# bridged ${found.size} local gateways: ${[...found.keys()].join(', ')}`);