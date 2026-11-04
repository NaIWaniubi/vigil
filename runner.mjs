#!/usr/bin/env node
// VIGIL runner. task x model x rep, append-only results, resumable.
//
// Discipline borrowed from SoTALab's rst-hle: a call failure, a truncation or a
// budget exhaustion is NEVER scored as a wrong answer. It is recorded as
// status=error and excluded from the capability profile, so infrastructure
// flakiness cannot masquerade as model weakness.

import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { World } from './engine/index.mjs';
import { generate, grid, taskFingerprint } from './tasks/index.mjs';
import { resolveChannel, officialChannels, CHANNELS } from './providers/registry.mjs';
import { call } from './providers/protocols.mjs';
import { Ledger, estimateCost } from './providers/ledger.mjs';
import { SYSTEM_PROMPT, PROMPT_VERSION, renderObservation, parseAction } from './providers/prompt.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

function parseArgs(argv) {
  const a = { reps: 3, out: null, resume: false, dryRun: false, maxTurns: null, budgetUsd: 50, tasks: 'grid', models: [], seedOffset: 0, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--reps') a.reps = Number(argv[++i]);
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--resume') a.resume = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--max-turns') a.maxTurns = Number(argv[++i]);
    else if (k === '--budget-usd') a.budgetUsd = Number(argv[++i]);
    else if (k === '--tasks') a.tasks = argv[++i];
    else if (k === '--models') a.models = argv[++i].split(',');
    else if (k === '--seed-offset') a.seedOffset = Number(argv[++i]);
    else if (k === '--limit') a.limit = Number(argv[++i]);
    else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error(`unknown arg: ${k}`);
  }
  return a;
}

const HELP = `VIGIL runner

  node runner.mjs --models deepseek:deepseek-chat,bitdeer:zai-org/GLM-5.3 --reps 3
  node runner.mjs --dry-run                  # no API calls, uses the greedy policy
  node runner.mjs --resume --out runs/x      # skip already-recorded cells

Options
  --models <ch:model,...>   channel:model pairs (default: all available official)
  --tasks grid|quick        task set (default grid: 160 configs)
  --reps <n>                repetitions per cell (default 3)
  --out <dir>               output dir (default runs/<timestamp>)
  --resume                  skip cells already in results.jsonl
  --dry-run                 run the greedy reference policy, no API spend
  --budget-usd <n>          hard spend cap (default 50)
  --max-turns <n>           override per-task turn cap
  --limit <n>               only the first n task configs (smoke tests)
`;

function cellKey(taskId, model, rep) { return `${taskId}|${model}|${rep}`; }

function loadDone(path) {
  const done = new Set();
  if (!existsSync(path)) return done;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      done.add(cellKey(r.taskId, r.model, r.rep));
    } catch { /* a torn last line is expected after a crash; ignore it */ }
  }
  return done;
}

/** One full trajectory against a live model. */
async function runCell({ task, seed, channel, model, ledger, maxTurns }) {
  const world = new World(task, { seed });
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  const turns = [];
  const cap = maxTurns ?? task.maxSteps;
  let status = 'completed';
  let error = null;

  while (!world.done && turns.length < cap) {
    const obs = world.observe();
    const userText = renderObservation(obs);
    messages.push({ role: 'user', content: userText });
    const callId = `${task.id}:${model}:${seed}:t${turns.length}`;
    let reply;
    try {
      ledger.reserve({ id: callId, model, maxInputTokens: 32_000, maxOutputTokens: 4096 });
      reply = await call(channel, messages, { model, temperature: 0, maxTokens: 4096 });
      ledger.settle({ id: callId, model, ...reply.usage });
    } catch (e) {
      ledger.release(callId, e.message);
      status = 'error';
      error = { message: e.message, status: e.status ?? null, atTurn: turns.length };
      break;
    }
    messages.push({ role: 'assistant', content: reply.text });
    const parsed = parseAction(reply.text);
    if (!parsed.ok) {
      turns.push({ turn: turns.length, ok: false, error: parsed.error, finish: reply.finish, usage: reply.usage });
      // An unparseable reply is an invalid action, not a harness error. Feed the
      // error back so the model can recover; the world logs it as invalid.
      messages.push({ role: 'user', content: `Your reply was not a valid action: ${parsed.error}. Respond with exactly one JSON object.` });
      continue;
    }
    if (reply.finish === 'length') {
      // Truncation is infrastructure, not capability. Record and stop the cell.
      turns.push({ turn: turns.length, ok: false, error: 'truncated', finish: reply.finish, usage: reply.usage });
      status = 'truncated';
      break;
    }
    const result = world.step(parsed.action);
    turns.push({
      turn: turns.length, ok: result.ok, action: parsed.action, why: parsed.why,
      error: result.error ?? null, tick: world.tick, finish: reply.finish, usage: reply.usage,
    });
  }

  const profile = world.profile();
  if (turns.length >= cap && !world.done) status = 'turn_cap';
  return {
    status, error, profile,
    terminal: profile.terminal,
    records: world.records,
    actionLog: world.actionLog,
    turns,
    promptVersion: PROMPT_VERSION,
  };
}

/** Dry-run uses the greedy reference policy so the pipeline is testable offline. */
async function runDryCell({ task, seed }) {
  const { greedy } = await import('./tasks/index.mjs');
  const world = greedy(task, { seed });
  return {
    status: 'completed', error: null, profile: world.profile(),
    terminal: world.profile().terminal, records: world.records,
    actionLog: world.actionLog, turns: [], promptVersion: PROMPT_VERSION, dryRun: true,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = args.out ? resolve(args.out) : join(ROOT, 'runs', stamp);
  mkdirSync(out, { recursive: true });
  const resultsPath = join(out, 'results.jsonl');
  const done = args.resume ? loadDone(resultsPath) : new Set();

  const allConfigs = args.tasks === 'quick'
    ? grid({ seeds: [1, 2], depths: [6, 12] })
    : grid({ seeds: [1, 2, 3, 4, 5], depths: [6, 12, 18, 24] });
  const configs = args.limit ? allConfigs.slice(0, args.limit) : allConfigs;

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
    if (!avail.length) throw new Error('no official channels have keys set; use --dry-run or set env keys');
    targets = avail.flatMap((c) => c.models.map((m) => ({ channel: resolveChannel(c.id), model: m })));
  }

  const ledger = new Ledger({ path: join(out, 'ledger.jsonl'), limitMicros: Math.round(args.budgetUsd * 1e6) });

  const protocol = {
    promptVersion: PROMPT_VERSION,
    promptSha256: createHash('sha256').update(SYSTEM_PROMPT).digest('hex'),
    engineVersion: '0.1.0',
    temperature: 0,
    maxTokens: 4096,
    reps: args.reps,
    taskGrid: args.tasks,
    targets: targets.map((t) => ({ channel: t.channel?.id ?? 'dry', model: t.model, tier: t.channel?.tier ?? 'reference' })),
    channels: CHANNELS.map((c) => ({ id: c.id, baseUrl: c.baseUrl, protocol: c.protocol, tier: c.tier })),
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(out, 'protocol.json'), `${JSON.stringify(protocol, null, 2)}\n`);

  const totalCells = configs.length * targets.length * args.reps;
  console.log(`vigil run · ${configs.length} tasks x ${targets.length} models x ${args.reps} reps = ${totalCells} cells`);
  console.log(`out=${out}${args.dryRun ? ' (DRY RUN, no API spend)' : ''}`);
  if (done.size) console.log(`resume: ${done.size} cells already recorded`);

  let finished = 0;
  let skipped = 0;
  let errors = 0;
  for (const cfg of configs) {
    const { task, oracle } = generate(cfg);
    const fingerprint = createHash('sha256').update(taskFingerprint(task)).digest('hex');
    writeFileSync(join(out, `${task.id}.task.json`), JSON.stringify({ task, oracle, fingerprint }, null, 2));
    for (const { channel, model } of targets) {
      for (let rep = 1; rep <= args.reps; rep++) {
        const key = cellKey(task.id, model, rep);
        if (done.has(key)) { skipped++; continue; }
        const seed = cfg.seed + args.seedOffset + rep * 1000;
        let result;
        try {
          result = args.dryRun
            ? await runDryCell({ task, seed })
            : await runCell({ task, seed, channel, model, ledger, maxTurns: args.maxTurns });
        } catch (e) {
          result = { status: 'error', error: { message: e.message }, profile: null, records: [], turns: [] };
        }
        const row = {
          taskId: task.id, config: cfg, model, channel: channel?.id ?? 'dry',
          tier: channel?.tier ?? 'reference', rep, seed, fingerprint,
          ...result, at: new Date().toISOString(),
        };
        appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
        finished++;
        if (result.status === 'error') errors++;
        if (finished % 25 === 0 || finished === totalCells - skipped) {
          const t = ledger.totals();
          console.log(`  ${finished}/${totalCells - skipped} cells · ${errors} errors · $${t.spentUsd.toFixed(4)} · ${t.calls} calls`);
        }
      }
    }
  }

  const summary = {
    finishedAt: new Date().toISOString(),
    cells: finished, skipped, errors,
    ledger: ledger.totals(),
    protocolSha256: protocol.promptSha256,
  };
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nRUN: ${finished} cells, ${skipped} skipped, ${errors} errors`);
  console.log(`spend: $${summary.ledger.spentUsd.toFixed(4)} across ${summary.ledger.calls} calls`);
}

main().catch((e) => { console.error(`RUNNER: FAIL — ${e.message}`); process.exit(1); });