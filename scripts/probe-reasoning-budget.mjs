#!/usr/bin/env node
// Cap the thinking budget instead of the output budget.
//
// Evidence so far (scripts/probe-finish.mjs, 2026-11-06):
//   max_tokens=4096  -> stop=max_tokens, text=0,   28s   unusable
//   max_tokens=16384 -> stop=end_turn,   text=111, 53s   usable, expensive
//   max_tokens=32768 -> stop=max_tokens, text=0,  195s   rambles past any cap
// The model is not broken; it thinks for ~8k tokens on a depth-10 board. If the
// relay honours Anthropic's `thinking.budget_tokens`, the thinking is bounded
// and the text still arrives — that turns 53s into a predictable decision.
//
// Usage:
//   eval "$(node scripts/load-local-keys.mjs)"
//   node scripts/probe-reasoning-budget.mjs --task rush-d10-off-s57

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT, renderObservation } from '../providers/prompt.mjs';
import { RushWorld } from '../tasks/rush/world.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const key = process.env.MAGPIE_API_KEY;
if (!key) { console.error('MAGPIE_API_KEY not set'); process.exit(1); }

const model = arg('model', 'apigoto-api-apigoto-com/deepseek-flash');
const taskId = arg('task', 'rush-d10-off-s57');
const taskPath = join(ROOT, 'runs', 'deep-1', `${taskId}.task.json`);
if (!existsSync(taskPath)) { console.error(`no ${taskPath}`); process.exit(1); }

const bundle = JSON.parse(readFileSync(taskPath, 'utf8'));
const world = RushWorld.create(bundle.task, { seed: 1 });
const observation = renderObservation(world.observe());

const base = {
  model,
  max_tokens: 8192,
  temperature: 0,
  system: SYSTEM_PROMPT,
  messages: [{ role: 'user', content: observation }],
};

const variants = [
  ['no budget (baseline)', {}],
  ['thinking budget 1024', { thinking: { type: 'enabled', budget_tokens: 1024 } }],
  ['thinking budget 2048', { thinking: { type: 'enabled', budget_tokens: 2048 } }],
  ['thinking budget 4096', { thinking: { type: 'enabled', budget_tokens: 4096 } }],
];

console.log(`reasoning-budget probe · ${model} · ${taskId}\n`);
for (const [name, extra] of variants) {
  const t0 = Date.now();
  try {
    const res = await fetch('http://127.0.0.1:3425/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, ...extra }),
      signal: AbortSignal.timeout(240_000),
    });
    const raw = await res.text();
    let j = null;
    try { j = JSON.parse(raw); } catch { /* raw */ }
    const blocks = j?.content ?? [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const think = blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('');
    console.log(`${name.padEnd(22)} ${res.status} ${((Date.now() - t0) / 1000).toFixed(1)}s `
      + `stop=${j?.stop_reason ?? '?'} out=${j?.usage?.output_tokens ?? '?'} text=${text.length} think=${think.length}`);
    if (text) console.log(`  → ${text.slice(0, 100).replace(/\s+/g, ' ')}`);
    if (!res.ok) console.log(`  ! ${raw.slice(0, 180).replace(/\s+/g, ' ')}`);
  } catch (e) {
    console.log(`${name.padEnd(22)} ERR ${e.message.slice(0, 90)}`);
  }
}