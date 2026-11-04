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
    models: ['auto/qwen3.8-flash', 'auto/glm-5.1', 'auto/minimax-m3'], keyEnv: 'MAGPIE_API_KEY', timeoutMs: 300000 },
  // Local multi-model gateways used for the exploratory leaderboard. Tagged
  // `relay` so they never enter the official main track, but they expose distinct
  // model families (Gemini / Qwen / GLM) for discrimination analysis.
  { id: 'agent2api-local', baseUrl: 'http://127.0.0.1:3065/v1', protocol: 'openai', tier: 'relay',
    models: ['gemini-3-flash-preview', 'gpt-5.6-luna', 'minimax-code/MiniMax-M3.1-Flash'], keyEnv: 'AGENT2API_API_KEY' },
  { id: 'opencsg-local', baseUrl: 'http://127.0.0.1:7871/v1', protocol: 'openai', tier: 'relay',
    models: ['qwen3.8-max', 'deepseek-v4-pro', 'glm-5.3-flash'], keyEnv: 'OPENCSG_API_KEY', maxTokens: 16384, timeoutMs: 240000 },
  { id: 'orcaterm-local', baseUrl: 'http://127.0.0.1:8010/v1', protocol: 'openai', tier: 'relay',
    models: ['glm-5.3', 'kimi-k3', 'deepseek-v4-pro'], keyEnv: 'ORCATERM_API_KEY' },
];

export function resolveChannel(id, env = process.env) {
  const ch = CHANNELS.find((c) => c.id === id);
  if (!ch) throw new Error(`unknown channel: ${id}`);
  const key = env[ch.keyEnv];
  if (!key) throw new Error(`channel ${id} needs env ${ch.keyEnv}`);
  return { ...ch, key };
}

/** Which channels are actually usable right now (key present). */
export function available(env = process.env) {
  return CHANNELS.filter((c) => !!env[c.keyEnv]).map((c) => ({
    id: c.id, protocol: c.protocol, tier: c.tier, models: c.models,
  }));
}

/** Channels admissible to the main leaderboard. */
export function officialChannels(env = process.env) {
  return available(env).filter((c) => c.tier === 'official');
}