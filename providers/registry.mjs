// Provider registry. Keys come from environment variables ONLY.
//
// SoTALab's leaderboard essay: "评测设置不透明——例如一方使用检索与工具而另一方
// 没有——会直接破坏可比性". So every channel is tagged with its tier, and the
// main leaderboard admits `official` only. Relay results are kept but published
// separately and labelled, never mixed into the headline comparison.

export const TIERS = ['official', 'relay', 'local'];

/** @typedef {{id:string,baseUrl:string,protocol:'openai'|'anthropic',tier:string,models:string[],keyEnv:string,temperature?:number}} Channel */

/** @type {Channel[]} */
export const CHANNELS = [
  { id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai', tier: 'official',
    models: ['deepseek-chat', 'deepseek-reasoner'], keyEnv: 'DEEPSEEK_API_KEY' },
  { id: 'deepseek-anthropic', baseUrl: 'https://api.deepseek.com/anthropic', protocol: 'anthropic', tier: 'official',
    models: ['deepseek-chat', 'deepseek-reasoner'], keyEnv: 'DEEPSEEK_API_KEY' },
  { id: 'sensenova', baseUrl: 'https://token.sensenova.cn/v1', protocol: 'openai', tier: 'official',
    models: ['deepseek-v4-flash', 'glm-5.3'], keyEnv: 'SENSENOVA_API_KEY' },
  // kimi-k3 rejects temperature != 1; pin it so the protocol stays comparable.
  { id: 'sensenova-kimi', baseUrl: 'https://token.sensenova.cn/v1', protocol: 'openai', tier: 'official',
    models: ['kimi-k3'], keyEnv: 'SENSENOVA_API_KEY', temperature: 1 },
  { id: 'stepfun', baseUrl: 'https://api.stepfun.com/v1', protocol: 'openai', tier: 'official',
    models: ['step-3.7-flash', 'step-5-preview'], keyEnv: 'STEPFUN_API_KEY' },
  { id: 'bigmodel', baseUrl: 'https://open.bigmodel.cn/api/anthropic', protocol: 'anthropic', tier: 'official',
    models: ['glm-5.3', 'glm-5.3-flash'], keyEnv: 'BIGMODEL_API_KEY' },
  { id: 'bitdeer', baseUrl: 'https://api-inference.bitdeer.ai/v1', protocol: 'openai', tier: 'official',
    models: ['deepseek-ai/DeepSeek-V4.1', 'zai-org/GLM-5.3', 'moonshotai/Kimi-K3'], keyEnv: 'BITDEER_API_KEY' },
  { id: 'gmi', baseUrl: 'https://api.gmi-serving.com/v1', protocol: 'openai', tier: 'official',
    models: ['MiniMaxAI/MiniMax-M3'], keyEnv: 'GMI_API_KEY' },
  { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai', tier: 'official',
    models: ['deepseek/deepseek-chat', 'moonshotai/kimi-k3'], keyEnv: 'OPENROUTER_API_KEY' },
  // Local gateways are convenient for development but are NOT official channels.
  { id: 'magpie-local', baseUrl: 'http://127.0.0.1:3425', protocol: 'anthropic', tier: 'local',
    models: ['apigoto-api-apigoto-com/deepseek-flash',
             'auto/qwen3.8-flash', 'auto/glm-5.1', 'auto/minimax-m3',
             'agent2api/auto', 'agent2api/deepseek-v4-flash', 'agent2api/MiniMax-M3.1-Flash'],
    // `deepseek-flash` here is a REASONING model behind an Anthropic-protocol
    // relay. Measured 2026-11-06 on rush-d10-off-s57: it emits a `thinking`
    // block and NO text until the thought finishes; the thought is 4k-22k
    // tokens with high variance for the SAME prompt. At the default 4096 it
    // returns text='' and stop_reason=max_tokens on essentially every call.
    // 16384 is the smallest cap observed to yield an action (7929 tokens, 53s).
    // `thinking.budget_tokens` is accepted but IGNORED by this relay: asking for
    // 1024 produced 17897. Evidence: docs/CHANNELS.md §6.
    keyEnv: 'MAGPIE_API_KEY', maxTokens: 16384, timeoutMs: 300000 },
  // Local multi-model gateways used for the exploratory leaderboard. Tagged
  // `relay` so they never enter the official main track, but they expose distinct
  // model families (Gemini / Qwen / GLM) for discrimination analysis.
  { id: 'agent2api-local', baseUrl: 'http://127.0.0.1:3065/v1', protocol: 'openai', tier: 'relay',
    models: ['glm-5.3-flash', 'gpt-6-luna', 'gemini-3-flash-preview',
             'minimax-code/MiniMax-M3.1-Flash', 'deepseek-v4.1-flash'],
    // Backend swap, measured 2026-11-06: `deepseek-v4.1-flash` was the 1.00x,
    // 84-output-token arm in docs/powered-run on 11-05. It now returns a
    // thinking block and no text at 512, and a valid action at 16384
    // (2380 output, 19s). `glm-5.3-flash` OVERRUNS the cap (asked 512, got 1536)
    // and timed out at 8192. Same model id, different model behind it — the
    // instability docs/CHANNELS.md §6 records, one day later.
    keyEnv: 'AGENT2API_API_KEY', maxTokens: 16384, timeoutMs: 240000 },
  { id: 'opencsg-local', baseUrl: 'http://127.0.0.1:7871/v1', protocol: 'openai', tier: 'relay',
    models: ['qwen3.8-max', 'deepseek-v4-pro', 'glm-5.3-flash'], keyEnv: 'OPENCSG_API_KEY', maxTokens: 16384, timeoutMs: 240000 },
  { id: 'orcaterm-local', baseUrl: 'http://127.0.0.1:8010/v1', protocol: 'openai', tier: 'relay',
    models: ['glm-5.3', 'kimi-k3', 'deepseek-v4-pro'], keyEnv: 'ORCATERM_API_KEY' },
];

export const CUSTOM_CHANNEL_ID = 'custom';

/**
 * A channel defined entirely by environment variables, so pointing the harness
 * at your own endpoint needs no source edit. Before this existed, an external
 * tester found that adoption required editing CHANNELS *and* the price table.
 *
 *   VIGIL_BASE_URL=https://my.endpoint/v1
 *   VIGIL_MODELS=my-model            (comma-separated; VIGIL_MODEL also works)
 *   VIGIL_API_KEY=sk-...             (omit with VIGIL_ALLOW_NO_KEY=1 for local)
 *   VIGIL_PROTOCOL=openai|anthropic  (default openai)
 *   VIGIL_MAX_TOKENS=16384           (optional; reasoning models need this)
 *   VIGIL_PRICE_IN=0.3 VIGIL_PRICE_OUT=0.5   (USD per 1M tokens; see ledger.mjs)
 */
export function customChannel(env = process.env) {
  const baseUrl = env.VIGIL_BASE_URL;
  if (!baseUrl) return null;
  const models = String(env.VIGIL_MODELS ?? env.VIGIL_MODEL ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!models.length) {
    throw new Error('VIGIL_BASE_URL is set but VIGIL_MODELS/VIGIL_MODEL names no model');
  }
  return {
    id: env.VIGIL_CHANNEL_ID ?? CUSTOM_CHANNEL_ID,
    baseUrl,
    protocol: env.VIGIL_PROTOCOL ?? 'openai',
    tier: env.VIGIL_TIER ?? 'custom',
    models,
    keyEnv: 'VIGIL_API_KEY',
    ...(env.VIGIL_MAX_TOKENS ? { maxTokens: Number(env.VIGIL_MAX_TOKENS) } : {}),
    ...(env.VIGIL_HARD_MAX_TOKENS ? { hardMaxTokens: Number(env.VIGIL_HARD_MAX_TOKENS) } : {}),
    timeoutMs: env.VIGIL_TIMEOUT_MS ? Number(env.VIGIL_TIMEOUT_MS) : 300000,
  };
}

/** Built-in channels plus the env-defined one, if any. */
export function allChannels(env = process.env) {
  const custom = customChannel(env);
  return custom ? [...CHANNELS, custom] : CHANNELS;
}

export function resolveChannel(id, env = process.env) {
  const list = allChannels(env);
  const ch = list.find((c) => c.id === id);
  if (!ch) {
    const hint = env.VIGIL_BASE_URL ? '' : ' (set VIGIL_BASE_URL to define a custom channel)';
    throw new Error(`unknown channel: ${id}${hint}`);
  }
  const key = env[ch.keyEnv];
  if (!key && !(ch.tier === 'custom' && env.VIGIL_ALLOW_NO_KEY)) {
    throw new Error(`channel ${id} needs env ${ch.keyEnv}`);
  }
  return { ...ch, key: key ?? '' };
}

/** Which channels are actually usable right now (key present). */
export function available(env = process.env) {
  return allChannels(env).filter((c) => !!env[c.keyEnv] || (c.tier === 'custom' && env.VIGIL_ALLOW_NO_KEY)).map((c) => ({
    id: c.id, protocol: c.protocol, tier: c.tier, models: c.models,
  }));
}

/** Channels admissible to the main leaderboard. */
export function officialChannels(env = process.env) {
  return available(env).filter((c) => c.tier === 'official');
}