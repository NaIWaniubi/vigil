// Protocol adapters. Two wire formats, one internal message shape.
//
// Internal shape: { role: 'system'|'user'|'assistant', content: string }
// Both adapters return { text, usage, finish, raw } and never throw on a
// model-level refusal — a refusal is data, not an error.

const DEFAULT_TIMEOUT = 120_000;
const MAX_RETRIES = 4;

/**
 * One truncation vocabulary for both wire formats.
 *
 * OpenAI says `length`; Anthropic says `max_tokens`. The runner keys its
 * "never score a truncated reply" rule on the string `length`, so before this
 * normaliser an Anthropic-protocol relay that filled its output budget looked
 * like a completed answer. Probe evidence (2026-11-06): magpie-local reported
 * `max_tokens` on 25/29 calls while the runner counted them as ordinary turns.
 */
export function normaliseFinish(finish) {
  if (finish === 'max_tokens') return 'length';
  return finish ?? 'unknown';
}

export const isTruncated = (finish) => finish === 'length';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry transient failures only. 429 (rate limit) and 5xx are infrastructure,
 * not capability: retrying with backoff keeps them out of the capability
 * profile. 402 (quota exhausted) and 4xx are terminal — no amount of waiting
 * fixes an unpaid bill.
 */
async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e.status ?? 0;
      const transient = status === 429 || status >= 500;
      if (!transient || attempt === MAX_RETRIES) throw e;
      const backoff = Math.min(30_000, 2000 * 2 ** attempt);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

async function postJson(url, headers, body, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json ?? { _unparsed: text };
}

export async function callOpenAI(channel, messages, opts = {}) {
  const { model, temperature = 0, maxTokens = channel.maxTokens ?? 4096, timeoutMs = channel.timeoutMs ?? DEFAULT_TIMEOUT } = opts;
  const body = { model, messages, temperature, max_tokens: maxTokens };
  const json = await withRetry(() => postJson(
    `${channel.baseUrl.replace(/\/$/, '')}/chat/completions`,
    { authorization: `Bearer ${channel.key}` },
    body, timeoutMs,
  ), `${channel.id}:${model}`);
  const choice = json.choices?.[0];
  return {
    text: choice?.message?.content ?? '',
    reasoning: choice?.message?.reasoning_content ?? null,
    usage: {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    finish: normaliseFinish(choice?.finish_reason),
    model: json.model ?? model,
    requestId: json.id ?? null,
  };
}

export async function callAnthropic(channel, messages, opts = {}) {
  const { model, temperature = 0, maxTokens = channel.maxTokens ?? 4096, timeoutMs = channel.timeoutMs ?? DEFAULT_TIMEOUT } = opts;
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
  const body = { model, messages: turns, max_tokens: maxTokens, temperature };
  if (system) body.system = system;
  const json = await withRetry(() => postJson(
    `${channel.baseUrl.replace(/\/$/, '')}/v1/messages`,
    { 'x-api-key': channel.key, 'anthropic-version': '2023-06-01' },
    body, timeoutMs,
  ), `${channel.id}:${model}`);
  const text = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {
    text,
    reasoning: (json.content ?? []).find((b) => b.type === 'thinking')?.thinking ?? null,
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      cachedTokens: json.usage?.cache_read_input_tokens ?? 0,
    },
    finish: normaliseFinish(json.stop_reason),
    model: json.model ?? model,
    requestId: json.id ?? null,
  };
}

export function call(channel, messages, opts) {
  return channel.protocol === 'anthropic'
    ? callAnthropic(channel, messages, opts)
    : callOpenAI(channel, messages, opts);
}