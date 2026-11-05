#!/usr/bin/env node
// Probe every configured endpoint for a model that actually answers right now.
// Reports latency and the exact model id, so the operator knows what is usable
// without reading config internals or handling keys.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const path = ['E:/myzcode/.zcode/v2/config.json', join(homedir(), '.zcode/v2/config.json')]
  .find((p) => existsSync(p));
if (!path) { console.error('# no config'); process.exit(1); }

const cfg = JSON.parse(readFileSync(path, 'utf8'));
const providers = Object.values(cfg.provider ?? {});
const seen = new Set();
const targets = [];
for (const p of providers) {
  const url = String(p.baseUrl ?? p.baseURL ?? p.options?.baseURL ?? '');
  const key = p.apiKey ?? p.options?.apiKey ?? p.key;
  if (!key || !url || seen.has(url)) continue;
  seen.add(url);
  const m = p.models ?? p.options?.models ?? [];
  const list = Array.isArray(m) ? m : Object.keys(m || {});
  for (const model of list.slice(0, 3)) {
    targets.push({ name: String(p.name ?? p.id).slice(0, 22), url, key, model });
  }
}

const anthropicish = (u) => u.includes('3425') || u.includes('anthropic');

const out = [];
await Promise.all(targets.map(async (t) => {
  const isA = anthropicish(t.url);
  const ep = isA
    ? `${t.url.replace(/\/$/, '')}/v1/messages`
    : `${t.url.replace(/\/$/, '')}/chat/completions`;
  const headers = isA
    ? { 'x-api-key': t.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    : { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' };
  const body = isA
    ? { model: t.model, messages: [{ role: 'user', content: 'Reply OK' }], max_tokens: 20 }
    : { model: t.model, messages: [{ role: 'user', content: 'Reply OK' }], max_tokens: 20 };
  const t0 = Date.now();
  try {
    const res = await fetch(ep, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
    const text = await res.text();
    let content = '';
    let msg = '';
    try {
      const j = JSON.parse(text);
      content = isA ? (j.content ?? []).map((x) => x.text).join('') : j.choices?.[0]?.message?.content ?? '';
      msg = (j.error?.message ?? '').slice(0, 40);
    } catch { msg = 'unparsed'; }
    out.push({ ...t, status: res.status, ok: !!content, ms: Date.now() - t0, msg });
  } catch (e) {
    out.push({ ...t, status: 'ERR', ok: false, ms: 0, msg: e.message.slice(0, 40) });
  }
}));

const live = out.filter((o) => o.ok).sort((a, b) => a.ms - b.ms);
console.log(`probed ${out.length} (endpoint,model) pairs — ${live.length} answering\n`);
console.log('LIVE');
for (const o of live) {
  console.log(`  ${String(o.status).padEnd(4)} ${String(o.ms + 'ms').padEnd(8)} ${o.model.padEnd(30)} ${o.name}`);
}
console.log('\nDEAD (status: reason)');
const byReason = new Map();
for (const o of out.filter((x) => !x.ok)) {
  const k = `${o.status}: ${o.msg}`;
  byReason.set(k, (byReason.get(k) ?? 0) + 1);
}
for (const [k, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}x ${k}`);
}
