// Protocol adapters. Two wire formats, one internal message shape.
//
// Internal shape: { role: 'system'|'user'|'assistant', content: string }
// Both adapters return { text, usage, finish, raw } and never throw on a
// model-level refusal — a refusal is data, not an error.

const DEFAULT_TIMEOUT = 120_000;

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
  const { model, temperature = 0, maxTokens = 4096, timeoutMs = DEFAULT_TIMEOUT } = opts;
  const body = { model, messages, temperature, max_tokens: maxTokens };
  const json = await postJson(
    `${channel.baseUrl.replace(/\/$/, '')}/chat/completions`,
    { authorization: `Bearer ${channel.key}` },
    body, timeoutMs,
  );
  const choice = json.choices?.[0];
  return {
    text: choice?.message?.content ?? '',
    reasoning: choice?.message?.reasoning_content ?? null,
    usage: {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    finish: choice?.finish_reason ?? 'unknown',
    model: json.model ?? model,
    requestId: json.id ?? null,
  };
}

export async function callAnthropic(channel, messages, opts = {}) {
  const { model, temperature = 0, maxTokens = 4096, timeoutMs = DEFAULT_TIMEOUT } = opts;
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
  const body = { model, messages: turns, max_tokens: maxTokens, temperature };
  if (system) body.system = system;
  const json = await postJson(
    `${channel.baseUrl.replace(/\/$/, '')}/v1/messages`,
    { 'x-api-key': channel.key, 'anthropic-version': '2023-06-01' },
    body, timeoutMs,
  );
  const text = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {
    text,
    reasoning: (json.content ?? []).find((b) => b.type === 'thinking')?.thinking ?? null,
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      cachedTokens: json.usage?.cache_read_input_tokens ?? 0,
    },
    finish: json.stop_reason ?? 'unknown',
    model: json.model ?? model,
    requestId: json.id ?? null,
  };
}

export function call(channel, messages, opts) {
  return channel.protocol === 'anthropic'
    ? callAnthropic(channel, messages, opts)
    : callOpenAI(channel, messages, opts);
}