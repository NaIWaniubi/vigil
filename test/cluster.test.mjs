import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelPool } from '../providers/pool.mjs';

test('pool never exceeds per-channel cap', async () => {
  const pool = new ChannelPool({ concurrency: 10, channels: { a: 2 }, paceMs: 0 });
  let peak = 0;
  let active = 0;
  const worker = async () => {
    for (let i = 0; i < 5; i++) {
      const rel = await pool.acquire('a');
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--; rel();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  assert.ok(peak <= 2, `peak ${peak} exceeded cap 2`);
});

test('pool never exceeds global concurrency', async () => {
  const pool = new ChannelPool({ concurrency: 3, channels: { a: 10, b: 10 }, paceMs: 0 });
  let peak = 0;
  const worker = async (id) => {
    for (let i = 0; i < 4; i++) {
      const rel = await pool.acquire(id);
      peak = Math.max(peak, pool.stats().globalActive);
      await new Promise((r) => setTimeout(r, 5));
      rel();
    }
  };
  await Promise.all([worker('a'), worker('b'), worker('a'), worker('b'), worker('a')]);
  assert.ok(peak <= 3, `global peak ${peak} exceeded 3`);
});

test('pace spacing: consecutive starts on a channel are >= paceMs apart', async () => {
  const pool = new ChannelPool({ concurrency: 10, channels: { a: 10 }, paceMs: 60 });
  const starts = [];
  const worker = async () => {
    for (let i = 0; i < 3; i++) {
      const rel = await pool.acquire('a');
      starts.push(Date.now());
      rel();
    }
  };
  await Promise.all([worker(), worker()]);
  starts.sort((x, y) => x - y);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] - starts[i - 1] >= 55, `gap ${starts[i] - starts[i - 1]} < pace`);
  }
});

test('a pace-blocked acquire resolves without any release (no deadlock)', async () => {
  const pool = new ChannelPool({ concurrency: 5, channels: { a: 5 }, paceMs: 50 });
  const r1 = await pool.acquire('a'); // sets lastStart
  // Second acquire is blocked ONLY by pace (capacity is free). No release will
  // come until it resolves — the timer must wake it.
  const r2 = await pool.acquire('a');
  assert.ok(r2, 'pace-blocked acquire resolved via timer');
  r1(); r2();
});

test('release is idempotent', async () => {
  const pool = new ChannelPool({ concurrency: 2, channels: { a: 1 }, paceMs: 0 });
  const rel = await pool.acquire('a');
  rel(); rel(); rel();
  assert.equal(pool.stats().globalActive, 0);
  assert.equal(pool.stats().channels.a.active, 0);
  const rel2 = await pool.acquire('a');
  assert.ok(rel2, 'slot reusable after idempotent release');
  rel2();
});

test('unknown channel gets the default cap', async () => {
  const pool = new ChannelPool({ concurrency: 10, channels: {}, paceMs: 0 });
  const r1 = await pool.acquire('new');
  const r2 = await pool.acquire('new');
  assert.equal(pool.stats().channels.new.max, 2);
  let third = false;
  pool.acquire('new').then((r) => { third = true; r(); });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(third, false, 'third must wait for a release');
  r1();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(third, true);
  r2();
});

test('stats reflect waiting count', async () => {
  const pool = new ChannelPool({ concurrency: 1, channels: { a: 1 }, paceMs: 0 });
  const r1 = await pool.acquire('a');
  const p2 = pool.acquire('a');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pool.stats().waiting, 1);
  r1();
  const r2 = await p2;
  assert.equal(pool.stats().waiting, 0);
  r2();
});