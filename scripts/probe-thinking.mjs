#!/usr/bin/env node
// Can this relay be told to STOP thinking? A reasoning model that spends 8k
// tokens before every chess move is a 53-second decision; at 26 turns/cell that
// is 23 minutes per cell and the matrix never finishes. Try the vendor knobs.
//
// Variants are sent raw so a rejected parameter is visible as a 400 instead of
// being silently dropped by an adapter.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const key = process.env.MAGPIE_API_KEY;
if (!key) { console.error('MAGPIE_API_KEY not set'); process.exit(1); }

const url = 'http://127.0.0.1:3425/v1/messages';
const model = process.argv[2] ?? 'apigoto-api-apigoto-com/deepseek-flash';
const prompt = 'A 6x6 grid. Vehicle F occupies row 3, columns 0-1, horizontal. Cells (3,2),(3,3) are empty. '
  + 'Legal move: F +2 or F -2. Objective: move F to column 4. Reply with exactly one JSON object: '
  + '{"action":{"type":"move","args":{"id":"F","delta":2}}}';

const variants = [
  ['baseline', {}],
  ['thinking:disabled', { thinking: { type: 'disabled' } }],
  ['reasoning_effort:low', { reasoning_effort: 'low' }],
  ['enable_thinking:false', { enable_thinking: false }],
  ['chat_template_kwargs', { chat_template_kwargs: { thinking: false } }],
];

for (const [name, extra] of variants) {
  const body = { model, max_tokens: 600, temperature: 0, messages: [{ role: 'user', content: prompt }], ...extra };
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* keep raw */ }
    const blocks = j?.content ?? [];
    const out = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const think = blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('');
    console.log(`${name.padEnd(24)} ${res.status} ${((Date.now() - t0) / 1000).toFixed(1)}s `
      + `stop=${j?.stop_reason ?? '?'} out=${j?.usage?.output_tokens ?? '?'} `
      + `text=${out.length} think=${think.length}`);
    if (out) console.log(`  → ${out.slice(0, 120).replace(/\s+/g, ' ')}`);
    if (!res.ok) console.log(`  ! ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
  } catch (e) {
    console.log(`${name.padEnd(24)} ERR ${e.message.slice(0, 80)}`);
  }
}