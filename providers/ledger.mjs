// Cost ledger. Every paid call is reserved, then settled with actual usage.
//
// SoTALab: "时间、Token 和人工干预都应计入交付成本". The ledger is what makes the
// cost curve auditable rather than estimated. Design follows the approval-gate
// discipline of studio/packages/generationGateway (MIT, HBAI-Ltd): integer
// micro-units, reserve-before-call, settle-after, no silent overruns.
//
// Persistence is append-only JSONL so a run can be interrupted and resumed
// without double-spending, and so a reader can replay the accounting.

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// USD per 1M tokens, micro-USD per token. Unknown prices BLOCK the call rather
// than guessing — an unpriced model cannot appear on a cost-comparable board.
export const PRICES = {
  'deepseek-chat': { in: 0.28, out: 0.42 },
  'deepseek-reasoner': { in: 0.28, out: 0.42 },
  'step-3.7-flash': { in: 0.2, out: 0.8 },
  'step-5-preview': { in: 1.0, out: 4.0 },
  'glm-5.3': { in: 0.6, out: 2.2 },
  'glm-5.3-flash': { in: 0.1, out: 0.4 },
  'deepseek-ai/DeepSeek-V4.1': { in: 0.3, out: 0.5 },
  'zai-org/GLM-5.3': { in: 0.6, out: 2.2 },
  'moonshotai/Kimi-K3': { in: 0.6, out: 2.5 },
  'moonshotai/kimi-k3': { in: 0.6, out: 2.5 },
  'MiniMaxAI/MiniMax-M3': { in: 0.3, out: 1.2 },
  'deepseek/deepseek-chat': { in: 0.28, out: 0.42 },
  'kimi-k3': { in: 0.6, out: 2.5 },
  'deepseek-v4-flash': { in: 0.3, out: 0.5 },
  'glm-5.3': { in: 0.6, out: 2.2 },
  // Exploratory relay models (local gateways). Prices are public list rates;
  // relay runs are tagged separately and never enter the official main track.
  'qwen3.8-max': { in: 1.2, out: 4.8 },
  'qwen3.8-flash': { in: 0.2, out: 0.8 },
  'deepseek-v4-pro': { in: 0.6, out: 1.2 },
  'gemini-3-flash-preview': { in: 0.3, out: 1.2 },
  'gpt-5.6-luna': { in: 2.0, out: 8.0 },
  'minimax-code/MiniMax-M3.1-Flash': { in: 0.3, out: 1.2 },
  'glm-5.3-flash': { in: 0.1, out: 0.4 },
  'auto/qwen3.8-flash': { in: 0.2, out: 0.8 },
  'auto/glm-5.1': { in: 0.6, out: 2.2 },
  'auto/minimax-m3': { in: 0.3, out: 1.2 },
  'auto/qwen3.8-max': { in: 1.2, out: 4.8 },
};

export class UnknownPriceError extends Error {
  constructor(model) { super(`no price for model ${model}; refusing to spend`); this.model = model; }
}
export class BudgetExceededError extends Error {
  constructor(limit, spent) { super(`budget ${limit} microUSD exhausted (spent ${spent})`); }
}

const micros = (usdPerMillion) => usdPerMillion; // USD/1e6 tokens == microUSD/token

export function priceOf(model) {
  const p = PRICES[model];
  if (!p) throw new UnknownPriceError(model);
  return { inMicros: micros(p.in), outMicros: micros(p.out) };
}

export function estimateCost(model, inputTokens, outputTokens) {
  const p = priceOf(model);
  return Math.ceil(inputTokens * p.inMicros + outputTokens * p.outMicros);
}

export class Ledger {
  constructor({ path = null, limitMicros = Infinity } = {}) {
    this.path = path;
    this.limitMicros = limitMicros;
    this.entries = [];
    this.reserved = new Map();
    this.spentMicros = 0;
    if (path && existsSync(path)) this.#replay();
    else if (path) mkdirSync(dirname(path), { recursive: true });
  }

  #replay() {
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      this.entries.push(e);
      if (e.type === 'settle') this.spentMicros += e.micros;
      if (e.type === 'reserve') this.reserved.set(e.id, e);
      if (e.type === 'settle' || e.type === 'release') this.reserved.delete(e.id);
    }
  }

  #append(e) {
    this.entries.push(e);
    if (this.path) appendFileSync(this.path, `${JSON.stringify(e)}\n`);
  }

  /** Reserve an upper bound before spending. Throws if the budget cannot hold it. */
  reserve({ id, model, maxInputTokens, maxOutputTokens }) {
    const micros = estimateCost(model, maxInputTokens, maxOutputTokens);
    const committed = [...this.reserved.values()].reduce((s, r) => s + r.micros, 0);
    if (this.spentMicros + committed + micros > this.limitMicros) {
      throw new BudgetExceededError(this.limitMicros, this.spentMicros + committed);
    }
    const entry = { type: 'reserve', id, model, micros, at: Date.now() };
    this.reserved.set(id, entry);
    this.#append(entry);
    return micros;
  }

  /** Settle with actual usage. Releases the unused part of the reservation. */
  settle({ id, model, inputTokens, outputTokens, cachedTokens = 0 }) {
    if (!this.reserved.has(id)) throw new Error(`settle without reserve: ${id}`);
    const micros = estimateCost(model, inputTokens, outputTokens);
    this.reserved.delete(id);
    this.spentMicros += micros;
    const entry = { type: 'settle', id, model, inputTokens, outputTokens, cachedTokens, micros, at: Date.now() };
    this.#append(entry);
    return micros;
  }

  /** Release a reservation when the call failed. Failed calls are not charged. */
  release(id, reason) {
    if (!this.reserved.has(id)) return;
    this.reserved.delete(id);
    this.#append({ type: 'release', id, reason, at: Date.now() });
  }

  totals() {
    const settled = this.entries.filter((e) => e.type === 'settle');
    return {
      calls: settled.length,
      spentMicros: this.spentMicros,
      spentUsd: this.spentMicros / 1e6,
      inputTokens: settled.reduce((s, e) => s + e.inputTokens, 0),
      outputTokens: settled.reduce((s, e) => s + e.outputTokens, 0),
      outstandingReservations: this.reserved.size,
    };
  }
}