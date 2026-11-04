#!/usr/bin/env node
// VIGIL cluster runner. Parallel cells across multiple model channels with
// per-channel concurrency caps, rate limiting, resume, and a global budget gate.
//
// Reuses runner.mjs's runCell/runDryCell and the same results.jsonl format, so
// cluster output is interchangeable with serial output and verify/aggregate work
// unchanged. The difference is throughput: many cells in flight, bounded per
// channel so a rate-limited endpoint is not hammered.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runCell, runDryCell, cellKey, loadDone } from '../runner.mjs';
import { generate, grid, taskFingerprint } from '../tasks/core/generate.mjs';
import { generateSwe, MODULES } from '../tasks/swe/generate.mjs';
import { rushConfigs, generateRushFromConfig } from '../tasks/rush/load.mjs';
import { resolveChannel, officialChannels, CHANNELS } from '../providers/registry.mjs';
import { Ledger } from '../providers/ledger.mjs';
import { ChannelPool } from '../providers/pool.mjs';
import { SYSTEM_PROMPT, PROMPT_VERSION } from '../providers/prompt.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function parseArgs(argv) {
  const a = {
    reps: 3, out: null, resume: false, dryRun: false, budgetUsd: 50,
    tasks: 'grid', models: [], family: 'rush', concurrency: 6, paceMs: 300,
    limit: null, seedOffset: 0, channelCaps: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--reps') a.reps = Number(argv[++i]);
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--resume') a.resume = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--budget-usd') a.budgetUsd = Number(argv[++i]);
    else if (k === '--tasks') a.tasks = argv[++i];
    else if (k === '--models') a.models = argv[++i].split(',');
    else if (k === '--family') a.family = argv[++i];
    else if (k === '--concurrency') a.concurrency = Number(argv[++i]);
    else if (k === '--pace-ms') a.paceMs = Number(argv[++i]);
    else if (k === '--limit') a.limit = Number(argv[++i]);
    else if (k === '--seed-offset') a.seedOffset = Number(argv[++i]);
    else if (k === '--cap') { const [id, n] = argv[++i].split('='); a.channelCaps[id] = Number(n); }
    else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error(`unknown arg: ${k}`);
  }
  return a;
}

const HELP = `VIGIL cluster runner (parallel)

  node scripts/cluster.mjs --models deepseek:deepseek-chat,sensenova:glm-5.3 --family rush --reps 3
  node scripts/cluster.mjs --dry-run --family both --concurrency 8 --limit 6

Options
  --models <ch:model,...>  channel:model pairs (default: available official)
  --family rush|core|swe|both   task family (default rush — the hard one)
  --tasks grid|quick       core/swe grid size
  --reps <n>               repetitions per cell (default 3)
  --concurrency <n>        global max in-flight cells (default 6)
  --pace-ms <n>            min ms between starts per channel (default 300)
  --cap <id=n>             per-channel in-flight cap (repeatable)
  --budget-usd <n>         hard spend cap (default 50)
  --out <dir>              output dir
  --resume                 skip cells already in results.jsonl
  --dry-run                reference policy, no API spend
  --limit <n>              only first n task configs
`;

function buildWork(args) {
  const work = [];
  if (args.family === 'rush' || args.family === 'both') {
    const cfgs = rushConfigs({ obligations: ['off', 'decay', 'deadline'], limit: args.limit });
    for (const cfg of cfgs) work.push({ family: 'rush', cfg });
  }
  if (args.family === 'core' || args.family === 'both') {
    const all = args.tasks === 'quick' ? grid({ seeds: [1, 2], depths: [6, 12] }) : grid({ seeds: [1, 2, 3, 4, 5], depths: [6, 12, 18, 24] });
    const cfgs = args.limit ? all.slice(0, args.limit) : all;
    for (const cfg of cfgs) work.push({ family: 'core', cfg });
  }
  if (args.family === 'swe' || args.family === 'both') {
    for (let moduleIndex = 0; moduleIndex < MODULES.length; moduleIndex++) {
      for (const obligation of ['off', 'deadline', 'decay']) {
        for (const seed of [1, 2, 3]) work.push({ family: 'swe', cfg: { moduleIndex, depth: 5, obligation, seed } });
      }
    }
  }
  return work;
}

function makeTask(item) {
  if (item.family === 'rush') return generateRushFromConfig(item.cfg);
  if (item.family === 'swe') return generateSwe(item.cfg);
  return generate(item.cfg);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = args.out ? resolve(args.out) : join(ROOT, 'runs', `cluster-${stamp}`);
  mkdirSync(out, { recursive: true });
  const resultsPath = join(out, 'results.jsonl');
  const done = args.resume ? loadDone(resultsPath) : new Set();

  let targets;
  if (args.dryRun) {
    targets = [{ channel: null, model: 'greedy-reference' }];
  } else if (args.models.length) {
    targets = args.models.map((spec) => {
      const [chId, ...rest] = spec.split(':');
      const model = rest.join(':');
      if (!model) throw new Error(`--models entry needs channel:model, got ${spec}`);
      return { channel: resolveChannel(chId), model };
    });
  } else {
    const avail = officialChannels();
    if (!avail.length) throw new Error('no official channels have keys; use --dry-run or set env keys');
    targets = avail.flatMap((c) => c.models.map((m) => ({ channel: resolveChannel(c.id), model: m })));
  }

  const ledger = new Ledger({ path: join(out, 'ledger.jsonl'), limitMicros: Math.round(args.budgetUsd * 1e6) });
  const caps = { deepseek: 2, 'deepseek-anthropic': 2, sensenova: 2, 'sensenova-kimi': 1, bigmodel: 2, ...args.channelCaps };
  const pool = new ChannelPool({ concurrency: args.concurrency, channels: caps, paceMs: args.paceMs });

  const work = buildWork(args);
  const protocol = {
    promptVersion: PROMPT_VERSION,
    promptSha256: createHash('sha256').update(SYSTEM_PROMPT).digest('hex'),
    engineVersion: '0.2.0',
    runner: 'cluster',
    concurrency: args.concurrency,
    paceMs: args.paceMs,
    temperature: 0,
    maxTokens: 4096,
    reps: args.reps,
    family: args.family,
    targets: targets.map((t) => ({ channel: t.channel?.id ?? 'dry', model: t.model, tier: t.channel?.tier ?? 'reference' })),
    channels: CHANNELS.map((c) => ({ id: c.id, baseUrl: c.baseUrl, protocol: c.protocol, tier: c.tier })),
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(out, 'protocol.json'), `${JSON.stringify(protocol, null, 2)}\n`);

  // Expand to cells, skipping done.
  const cells = [];
  for (const item of work) {
    const { task, oracle } = makeTask(item);
    const fingerprint = createHash('sha256').update(taskFingerprint(task)).digest('hex');
    writeFileSync(join(out, `${task.id}.task.json`), JSON.stringify({ task, oracle, fingerprint }, null, 2));
    for (const { channel, model } of targets) {
      for (let rep = 1; rep <= args.reps; rep++) {
        if (done.has(cellKey(task.id, model, rep))) continue;
        cells.push({ item, task, fingerprint, channel, model, rep });
      }
    }
  }

  // Interleave cells round-robin across tasks so a stuck/hard task does not
  // monopolise all workers while easier tasks wait. Without this, the first
  // task's reps x models fill every worker and the run appears frozen on one
  // puzzle. Sort by (rep, model-index, task-index) to spread tasks across time.
  const modelOrder = new Map(targets.map((t, i) => [t.model, i]));
  cells.sort((a, b) => {
    const ai = work.indexOf(a.item), bi = work.indexOf(b.item);
    return (a.rep - b.rep)
      || (modelOrder.get(a.model) - modelOrder.get(b.model))
      || (ai - bi);
  });
  // Now reorder so consecutive cells are different tasks: bucket by task and
  // round-robin pull. Keeps resume keying intact (order-independent).
  const byTask = new Map();
  for (const c of cells) {
    if (!byTask.has(c.task.id)) byTask.set(c.task.id, []);
    byTask.get(c.task.id).push(c);
  }
  const queues = [...byTask.values()];
  const interleaved = [];
  let added = true;
  while (added) {
    added = false;
    for (const q of queues) {
      if (q.length) { interleaved.push(q.shift()); added = true; }
    }
  }
  cells.length = 0;
  cells.push(...interleaved);

  const total = cells.length;
  console.log(`vigil cluster · ${work.length} tasks x ${targets.length} models x ${args.reps} reps`);
  console.log(`cells to run: ${total} (skipped ${done.size}) · concurrency ${args.concurrency} · pace ${args.paceMs}ms`);
  console.log(`out=${out}${args.dryRun ? ' (DRY RUN)' : ''}`);

  let finished = 0;
  let errors = 0;
  let stopped = false;
  let stopReason = null;
  const stop = (reason) => { if (!stopped) { stopped = true; stopReason = reason; console.error(`\nSTOP: ${reason}`); } };
  process.on('SIGINT', () => stop('SIGINT'));

  const launch = async (cell) => {
    const { item, task, fingerprint, channel, model, rep } = cell;
    const channelId = channel?.id ?? 'dry';
    const release = await pool.acquire(channelId);
    try {
      if (stopped) return;
      // Budget gate: refuse to start a cell we cannot afford.
      if (!args.dryRun) {
        try {
          ledger.reserve({ id: `probe:${task.id}:${model}:${rep}`, model, maxInputTokens: 1000, maxOutputTokens: 100 });
          ledger.release(`probe:${task.id}:${model}:${rep}`, 'probe');
        } catch (e) {
          stop(`budget exhausted: ${e.message}`);
          return;
        }
      }
      const seed = (item.cfg.seed ?? 1) + args.seedOffset + rep * 1000;
      let result;
      try {
        result = args.dryRun
          ? await runDryCell({ task, seed })
          : await runCell({ task, seed, channel, model, ledger, paceMs: args.paceMs });
      } catch (e) {
        // An unpriced model is a configuration gap, not a reason to halt the
        // whole cluster. Record the cell as an error and keep going; the budget
        // gate only stops the run on genuine exhaustion.
        result = { status: 'error', error: { message: e.message }, profile: null, records: [], turns: [] };
      }
      const row = {
        taskId: task.id, config: item.cfg, family: item.family, model, channel: channelId,
        tier: channel?.tier ?? 'reference', rep, seed, fingerprint,
        ...result, at: new Date().toISOString(),
      };
      appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
      finished++;
      if (result.status === 'error') errors++;
      if (finished % 10 === 0 || finished === total) {
        const t = ledger.totals();
        console.log(`  ${finished}/${total} · ${errors} err · $${t.spentUsd.toFixed(4)} · ${t.calls} calls · active ${pool.stats().globalActive}`);
      }
    } finally {
      release();
    }
  };

  // Worker loop: pull cells until exhausted or stopped. A worker must never die
  // silently on an unexpected throw — that would strand the pool and stall the
  // whole run. Catch, log, and continue.
  let cursor = 0;
  const worker = async (wid) => {
    while (!stopped && cursor < cells.length) {
      const cell = cells[cursor++];
      try {
        await launch(cell);
      } catch (e) {
        console.error(`worker ${wid} cell ${cell.task.id}/${cell.model} threw: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: args.concurrency }, (_, i) => worker(i)));

  const summary = {
    finishedAt: new Date().toISOString(),
    cells: finished, errors, stopped, stopReason,
    ledger: ledger.totals(),
    protocolSha256: protocol.promptSha256,
  };
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nCLUSTER: ${finished} cells, ${errors} errors${stopped ? ` (stopped: ${stopReason})` : ''}`);
  console.log(`spend: $${summary.ledger.spentUsd.toFixed(4)} across ${summary.ledger.calls} calls`);
}

main().catch((e) => { console.error(`CLUSTER: FAIL — ${e.message}`); process.exit(1); });