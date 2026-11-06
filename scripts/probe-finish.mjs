#!/usr/bin/env node
// One-call probe: does this channel return a SCOREABLE action, or does it burn
// the whole output budget and stop on the cap?
//
// Why it exists: `runs/deep-1` showed 25 of 29 calls settling at exactly 4096
// output tokens. That is either a model that thinks through the cap or a relay
// that fills it. The runner already refuses to score a truncated reply
// (`finish === 'length'`), so if this probe reports `max_tokens`, the channel
// cannot produce a single scoreable cell and no amount of concurrency helps.
//
// It sends the REAL prompt and the REAL first observation of a real task, at a
// sweep of maxTokens values, and prints what comes back. No results are written.
//
// Usage:
//   eval "$(node scripts/load-channels.mjs)"
//   node scripts/probe-finish.mjs --model magpie-local:apigoto-api-apigoto-com/deepseek-flash --task rush-d10-off-s57
//   node scripts/probe-finish.mjs --model ... --ticks 256,512,4096

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChannel } from '../providers/registry.mjs';
import { call } from '../providers/protocols.mjs';
import { SYSTEM_PROMPT, renderObservation, parseAction } from '../providers/prompt.mjs';
import { RushWorld } from '../tasks/rush/world.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const target = arg('model', 'magpie-local:apigoto-api-apigoto-com/deepseek-flash');
const taskId = arg('task', 'rush-d10-off-s57');
const ticks = String(arg('ticks', '4096')).split(',').map(Number);
const taskPath = join(ROOT, 'runs', 'deep-1', `${taskId}.task.json`);
if (!existsSync(taskPath)) {
  console.error(`no task file at ${taskPath} — run a cluster once, or pass --task <id>`);
  process.exit(1);
}

const [channelId, ...rest] = target.split(':');
const model = rest.join(':');
const channel = resolveChannel(channelId);

const bundle = JSON.parse(readFileSync(taskPath, 'utf8'));
const world = RushWorld.create(bundle.task, { seed: 1 });
const observation = renderObservation(world.observe());
const messages = [
  { role: 'system', content: SYSTEM_PROMPT },
  { role: 'user', content: observation },
];

console.log(`probe · ${target} · ${taskId} · prompt ${observation.length} chars\n`);
for (const maxTokens of ticks) {
  const t0 = Date.now();
  let reply;
  try {
    reply = await call(channel, messages, { model, temperature: 0, maxTokens });
  } catch (e) {
    console.log(`max_tokens=${String(maxTokens).padStart(5)}  ERROR  ${e.message.slice(0, 90)}`);
    continue;
  }
  const parsed = parseAction(reply.text);
  const truncated = reply.finish === 'length' || reply.finish === 'max_tokens';
  const head = reply.text.slice(0, 80).replace(/\s+/g, ' ');
  console.log(
    `max_tokens=${String(maxTokens).padStart(5)}  finish=${String(reply.finish).padEnd(12)}`
    + ` out=${String(reply.usage.outputTokens).padStart(5)} in=${String(reply.usage.inputTokens).padStart(5)}`
    + ` ${(Date.now() - t0) / 1000}s  ${truncated ? 'TRUNCATED' : parsed.ok ? `action=${parsed.action.type}` : `unparsed:${parsed.error}`}`,
  );
  console.log(`             text[${reply.text.length}]: ${head}${reply.text.length > 80 ? '…' : ''}`);
  if (reply.reasoning) console.log(`             reasoning[${reply.reasoning.length}]`);
}