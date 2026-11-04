import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, estimateCost, priceOf, UnknownPriceError, BudgetExceededError } from '../providers/ledger.mjs';
import { parseAction, renderObservation, SYSTEM_PROMPT, PROMPT_VERSION } from '../providers/prompt.mjs';
import { CHANNELS, available, officialChannels, resolveChannel } from '../providers/registry.mjs';
import { World, num, ref, op } from '../engine/index.mjs';

test('cost is integer micro-USD and unknown prices block spending', () => {
  const c = estimateCost('deepseek-chat', 1000, 500);
  assert.ok(Number.isInteger(c));
  assert.equal(c, 490);
  assert.throws(() => priceOf('mystery-model'), UnknownPriceError);
});

test('ledger reserves before spending and settles actual usage', () => {
  const l = new Ledger({ limitMicros: 1000 });
  l.reserve({ id: 'a', model: 'deepseek-chat', maxInputTokens: 1000, maxOutputTokens: 500 });
  assert.equal(l.totals().outstandingReservations, 1);
  l.settle({ id: 'a', model: 'deepseek-chat', inputTokens: 800, outputTokens: 200 });
  const t = l.totals();
  assert.equal(t.calls, 1);
  assert.equal(t.outstandingReservations, 0);
  assert.equal(t.spentMicros, estimateCost('deepseek-chat', 800, 200));
});

test('budget cannot be exceeded by reservations', () => {
  const l = new Ledger({ limitMicros: 100 });
  assert.throws(() => l.reserve({ id: 'x', model: 'deepseek-chat', maxInputTokens: 1e6, maxOutputTokens: 1e6 }), BudgetExceededError);
});

test('failed calls are released, never charged', () => {
  const l = new Ledger({ limitMicros: 10_000 });
  l.reserve({ id: 'f', model: 'deepseek-chat', maxInputTokens: 100, maxOutputTokens: 100 });
  l.release('f', 'HTTP 500');
  assert.equal(l.totals().spentMicros, 0);
  assert.equal(l.totals().calls, 0);
});

test('ledger replays from disk without double counting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-ledger-'));
  const path = join(dir, 'ledger.jsonl');
  try {
    const a = new Ledger({ path, limitMicros: 10_000 });
    a.reserve({ id: 'p', model: 'deepseek-chat', maxInputTokens: 500, maxOutputTokens: 500 });
    a.settle({ id: 'p', model: 'deepseek-chat', inputTokens: 400, outputTokens: 100 });
    const b = new Ledger({ path, limitMicros: 10_000 });
    assert.equal(b.totals().spentMicros, a.totals().spentMicros);
    assert.equal(b.totals().calls, 1);
    assert.equal(b.totals().outstandingReservations, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseAction accepts bare JSON, fenced JSON, and prose-wrapped JSON', () => {
  const want = { type: 'set', args: { path: 'a.b', value: 3 } };
  for (const text of [
    '{"action":{"type":"set","args":{"path":"a.b","value":3}}}',
    '```json\n{"action":{"type":"set","args":{"path":"a.b","value":3}}}\n```',
    'Sure! Here you go:\n{"action":{"type":"set","args":{"path":"a.b","value":3}}}\nHope that helps.',
  ]) {
    const r = parseAction(text);
    assert.equal(r.ok, true, text);
    assert.deepEqual(r.action, want);
  }
});

test('parseAction handles braces inside strings', () => {
  const r = parseAction('{"action":{"type":"set","args":{"path":"x","value":"a}b{c"}},"why":"}{"}');
  assert.equal(r.ok, true);
  assert.equal(r.action.args.value, 'a}b{c');
});

test('parseAction rejects malformed replies without guessing', () => {
  for (const text of ['', 'no json here', '{"action":', '{"why":"no action"}', '{"action":{"args":{}}}']) {
    assert.equal(parseAction(text).ok, false, text);
  }
});

test('prompt renders constraints as text and hides predicates', () => {
  const w = new World({
    id: 'p', maxSteps: 10, initialState: { a: { level: 0 } },
    constraints: [{ id: 'c1', revealAt: 0, text: 'a.level must be at least 5.', predicate: op('ge', ref('a.level'), num(5)) }],
  });
  const rendered = renderObservation(w.observe());
  assert.ok(rendered.includes('a.level must be at least 5.'));
  assert.ok(!rendered.includes('predicate'));
  assert.ok(rendered.includes('Available actions'));
  assert.ok(rendered.includes('reached 1, passed 0'));
});

test('system prompt is versioned and non-empty', () => {
  assert.match(PROMPT_VERSION, /^vigil-agent-v\d+$/);
  assert.ok(SYSTEM_PROMPT.length > 200);
  assert.ok(SYSTEM_PROMPT.includes('EVERY constraint stays in force'));
});

test('registry tags tiers and never exposes keys', () => {
  for (const c of CHANNELS) {
    assert.ok(['official', 'relay', 'local'].includes(c.tier));
    assert.ok(c.keyEnv.endsWith('_API_KEY'));
  }
  const none = available({});
  assert.equal(none.length, 0);
  const some = available({ DEEPSEEK_API_KEY: 'x' });
  assert.ok(some.some((c) => c.id === 'deepseek'));
  assert.ok(!JSON.stringify(some).includes('"key"'));
  assert.throws(() => resolveChannel('deepseek', {}), /needs env DEEPSEEK_API_KEY/);
  assert.throws(() => resolveChannel('nope', {}), /unknown channel/);
});

test('official channels exclude local gateways', () => {
  const env = { DEEPSEEK_API_KEY: 'x', MAGPIE_API_KEY: 'y' };
  const off = officialChannels(env);
  assert.ok(off.some((c) => c.id === 'deepseek'));
  assert.ok(!off.some((c) => c.tier === 'local'));
});