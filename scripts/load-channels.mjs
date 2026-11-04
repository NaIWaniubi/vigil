#!/usr/bin/env node
// Bridge from the local ZCode provider config to VIGIL's env-var contract.
//
// Keys never touch disk here and are never printed. This script emits `set`
// commands for the current shell only, so a run can use the channels the
// operator already configured without copying secrets into the repo.
//
// Usage (Git Bash):
//   eval "$(node scripts/load-channels.mjs)"
//   node runner.mjs --models deepseek:deepseek-chat --tasks quick --reps 1
//
// Usage (PowerShell):
//   node scripts/load-channels.mjs --powershell | Invoke-Expression

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.VIGIL_ZCODE_CONFIG,
  'E:/myzcode/.zcode/v2/config.json',
  join(homedir(), '.zcode/v2/config.json'),
].filter(Boolean);

// Map a configured provider (matched by base URL) to the env var the registry
// expects. Only official direct endpoints are bridged; relays are skipped so
// they cannot leak into the main leaderboard by accident.
const URL_TO_ENV = [
  ['api.deepseek.com', 'DEEPSEEK_API_KEY'],
  ['token.sensenova.cn', 'SENSENOVA_API_KEY'],
  ['api.stepfun.com/v1', 'STEPFUN_API_KEY'],
  ['open.bigmodel.cn', 'BIGMODEL_API_KEY'],
  ['api-inference.bitdeer.ai', 'BITDEER_API_KEY'],
  ['api.gmi-serving.com', 'GMI_API_KEY'],
  ['openrouter.ai/api/v1', 'OPENROUTER_API_KEY'],
];

const powershell = process.argv.includes('--powershell');
const path = CANDIDATES.find((p) => existsSync(p));
if (!path) {
  console.error('# no ZCode config found; set VIGIL_ZCODE_CONFIG or export keys manually');
  process.exit(0);
}

const cfg = JSON.parse(readFileSync(path, 'utf8'));
const providers = Object.entries(cfg.provider ?? {}).map(([id, v]) => ({ id, ...v }));
const found = new Map();

for (const p of providers) {
  const url = String(p.baseUrl ?? p.baseURL ?? p.options?.baseURL ?? '');
  const key = p.apiKey ?? p.options?.apiKey ?? p.key;
  if (!key || typeof key !== 'string') continue;
  for (const [needle, envName] of URL_TO_ENV) {
    if (url.includes(needle) && !found.has(envName)) found.set(envName, key);
  }
}

if (!found.size) {
  console.error('# config found but no official channel keys matched');
  process.exit(0);
}

for (const [envName, key] of found) {
  // Single-quote for bash, escaping embedded single quotes; PowerShell uses
  // single quotes with doubling. Never echo the value itself.
  if (powershell) {
    console.log(`$env:${envName} = '${key.replace(/'/g, "''")}'`);
  } else {
    console.log(`export ${envName}='${key.replace(/'/g, `'\\''`)}'`);
  }
}
console.error(`# bridged ${found.size} official channels: ${[...found.keys()].join(', ')}`);