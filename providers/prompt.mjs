// The agent-facing prompt. This file IS the measurement protocol's prompt
// component: its sha256 goes into protocol.toml, and verify.py rebuilds it
// byte-for-byte. Change a word and the fingerprint changes — that is the point.

export const PROMPT_VERSION = 'vigil-agent-v1';

export const SYSTEM_PROMPT = `You are operating a controlled environment through a fixed set of actions.

Rules of engagement:
- Constraints are revealed over time. EVERY constraint stays in force after it appears.
- Satisfying a new constraint may break an older one. Re-check earlier constraints after acting.
- Background obligations decay with environment time, which advances with the cost of each action. Expensive actions cost more neglect. Tend obligations before they lapse.
- You see constraint TEXT, not its internal predicate. Work from the text.
- You may only use the actions listed in "actions". Anything else is rejected and logged.
- Do not attempt to read verifier internals, future constraints, or answer keys. Such attempts are detected and mark the run non-compliant.

Respond with EXACTLY one JSON object and nothing else:
{"action": {"type": "<action name>", "args": { ... }}, "why": "<one short sentence>"}

Use {"action": {"type": "noop"}, "why": "..."} to wait.
Use {"action": {"type": "tend", "args": {"obligationId": "<id>"}}, "why": "..."} to maintain an obligation.`;

/** Render the observation the agent sees. Deterministic key order. */
export function renderObservation(obs) {
  const lines = [];
  lines.push(`# Step ${obs.step} · tick ${obs.tick} · ${obs.stepsLeft} steps left`);
  lines.push('');
  lines.push('## State');
  lines.push('```json');
  lines.push(JSON.stringify(obs.state, null, 2));
  lines.push('```');
  lines.push('');
  lines.push(`## Active constraints (${obs.constraints.length}) — all remain in force`);
  for (const c of obs.constraints) {
    lines.push(`- [${c.id}, since step ${c.since}] ${c.text}`);
  }
  if (obs.obligations.length) {
    lines.push('');
    lines.push('## Background obligations');
    for (const o of obs.obligations) {
      if (o.kind === 'decay') lines.push(`- [${o.id}] level ${o.level} (decays each tick; tend to refill)`);
      else if (o.kind === 'deadline') lines.push(`- [${o.id}] ${o.ticksLeft} ticks left${o.done ? ' (discharged)' : ''}`);
      else lines.push(`- [${o.id}] heat ${o.risk}, shield ${o.shieldTicks} ticks (tend to vent and shield)`);
    }
  }
  lines.push('');
  lines.push('## Available actions');
  for (const a of obs.actions) {
    lines.push(`- ${a.name}(${(a.args ?? []).join(', ')}) cost=${a.cost}${a.doc ? ` — ${a.doc}` : ''}`);
  }
  lines.push('');
  lines.push(`## Progress: reached ${obs.progress.reached}, passed ${obs.progress.passed}`);
  if (obs.goal) {
    lines.push('');
    lines.push('## Objective');
    lines.push(obs.goal);
    lines.push('The run only succeeds when the objective is met AND every constraint holds AND no obligation has lapsed. satisfying constraints alone is not enough.');
  }
  return lines.join('\n');
}

/**
 * Extract one action from a model reply. Tolerates code fences and surrounding
 * prose, but never guesses: an unparseable reply is a logged invalid turn, not
 * a silently coerced noop.
 */
export function parseAction(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'empty reply' };
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start < 0) return { ok: false, error: 'no JSON object in reply' };
  // Balanced-brace scan so trailing prose does not break JSON.parse.
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return { ok: false, error: 'unbalanced JSON braces' };
  let obj;
  try { obj = JSON.parse(candidate.slice(start, end + 1)); }
  catch (e) { return { ok: false, error: `JSON parse: ${e.message}` }; }
  const action = obj.action ?? obj;
  if (!action || typeof action.type !== 'string') {
    return { ok: false, error: 'reply has no action.type' };
  }
  return { ok: true, action: { type: action.type, args: action.args ?? {} }, why: obj.why ?? null };
}