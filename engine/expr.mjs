// Expression AST for constraints, obligations and goals.
//
// Constraints ship as DATA, never as functions. That is what makes a task
// serialisable, hashable into MANIFEST.sha256, and inspectable by the agent
// without giving it the evaluator's own code. `reads()` is the static read-set
// used by attribution: it tells us which state cells a predicate depends on,
// so a violation can be blamed on the action that actually touched them.

export const num = (v) => ({ t: 'num', v });
export const bool = (v) => ({ t: 'bool', v });
export const str = (v) => ({ t: 'str', v });
export const ref = (path) => ({ t: 'ref', path });
export const op = (name, ...args) => ({ t: 'op', name, args });

const ARITY = {
  add: 2, sub: 2, mul: 2, div: 2, mod: 2, pow: 2, neg: 1, abs: 1,
  min: -1, max: -1, sum: 1, len: 1, floor: 1, ceil: 1, round: 1,
  eq: 2, ne: 2, lt: 2, le: 2, gt: 2, ge: 2,
  and: -1, or: -1, not: 1, ite: 3,
  in: 2, has: 2, count: 2, all: 2, any: 2,
  concat: -1, upper: 1, lower: 1, matches: 2, startsWith: 2, endsWith: 2,
};

export class ExprError extends Error {}

function arityOk(name, n) {
  const a = ARITY[name];
  if (a === undefined) throw new ExprError(`unknown operator: ${name}`);
  if (a === -1) return n >= 1;
  return n === a;
}

/** Validate shape without a state. Throws ExprError on malformed trees. */
export function validate(e) {
  if (e === null || typeof e !== 'object') throw new ExprError('expression must be an object');
  switch (e.t) {
    case 'num':
      if (typeof e.v !== 'number' || !Number.isFinite(e.v)) throw new ExprError('num must be finite');
      return;
    case 'bool':
      if (typeof e.v !== 'boolean') throw new ExprError('bool must be boolean');
      return;
    case 'str':
      if (typeof e.v !== 'string') throw new ExprError('str must be string');
      return;
    case 'ref':
      assertSafePath(e.path);
      return;
    case 'op': {
      if (!Array.isArray(e.args)) throw new ExprError(`op ${e.name} needs args array`);
      if (!arityOk(e.name, e.args.length)) {
        throw new ExprError(`op ${e.name} got ${e.args.length} args`);
      }
      for (const a of e.args) validate(a);
      return;
    }
    default:
      throw new ExprError(`unknown expression node: ${e.t}`);
  }
}

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** Reject paths that could reach the prototype chain. */
export function assertSafePath(path) {
  if (typeof path !== 'string' || !path) throw new ExprError('path must be a non-empty string');
  for (const seg of path.split('.')) {
    if (seg.length === 0) throw new ExprError(`bad path: ${path}`);
    if (FORBIDDEN_SEGMENTS.has(seg)) throw new ExprError(`forbidden path segment: ${seg}`);
  }
  return path;
}

export function resolvePath(state, path) {
  let cur = state;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    // Own properties only: `cur[seg]` would walk into Object.prototype, so a
    // missing ref could resolve to an inherited value and make a constraint
    // pass for the wrong reason.
    if (!Object.hasOwn(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Evaluate against a state. Missing refs are `undefined`, and comparisons
 * involving undefined are false rather than throwing: an agent that deletes a
 * cell should fail the constraint, not crash the harness.
 */
export function evaluate(e, state) {
  switch (e.t) {
    case 'num': case 'bool': case 'str': return e.v;
    case 'ref': return resolvePath(state, e.path);
    case 'op': return applyOp(e.name, e.args.map((a) => evaluate(a, state)));
    default: throw new ExprError(`unknown expression node: ${e.t}`);
  }
}

function numeric(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function applyOp(name, a) {
  switch (name) {
    case 'add': return numeric(a[0]) && numeric(a[1]) ? a[0] + a[1] : undefined;
    case 'sub': return numeric(a[0]) && numeric(a[1]) ? a[0] - a[1] : undefined;
    case 'mul': return numeric(a[0]) && numeric(a[1]) ? a[0] * a[1] : undefined;
    case 'div': return numeric(a[0]) && numeric(a[1]) && a[1] !== 0 ? a[0] / a[1] : undefined;
    case 'mod': return numeric(a[0]) && numeric(a[1]) && a[1] !== 0 ? a[0] % a[1] : undefined;
    case 'pow': return numeric(a[0]) && numeric(a[1]) ? a[0] ** a[1] : undefined;
    case 'neg': return numeric(a[0]) ? -a[0] : undefined;
    case 'abs': return numeric(a[0]) ? Math.abs(a[0]) : undefined;
    case 'floor': return numeric(a[0]) ? Math.floor(a[0]) : undefined;
    case 'ceil': return numeric(a[0]) ? Math.ceil(a[0]) : undefined;
    case 'round': return numeric(a[0]) ? Math.round(a[0]) : undefined;
    case 'min': { const xs = a.filter(numeric); return xs.length ? Math.min(...xs) : undefined; }
    case 'max': { const xs = a.filter(numeric); return xs.length ? Math.max(...xs) : undefined; }
    case 'sum': return Array.isArray(a[0]) ? a[0].filter(numeric).reduce((s, x) => s + x, 0) : undefined;
    case 'len':
      if (Array.isArray(a[0]) || typeof a[0] === 'string') return a[0].length;
      if (a[0] && typeof a[0] === 'object') return Object.keys(a[0]).length;
      return undefined;
    case 'eq': return a[0] === a[1];
    case 'ne': return a[0] !== a[1];
    case 'lt': return numeric(a[0]) && numeric(a[1]) ? a[0] < a[1] : false;
    case 'le': return numeric(a[0]) && numeric(a[1]) ? a[0] <= a[1] : false;
    case 'gt': return numeric(a[0]) && numeric(a[1]) ? a[0] > a[1] : false;
    case 'ge': return numeric(a[0]) && numeric(a[1]) ? a[0] >= a[1] : false;
    case 'and': return a.every((x) => x === true);
    case 'or': return a.some((x) => x === true);
    case 'not': return a[0] !== true;
    case 'ite': return a[0] === true ? a[1] : a[2];
    case 'in': return Array.isArray(a[1]) ? a[1].includes(a[0]) : false;
    case 'has':
      if (Array.isArray(a[0])) return a[0].includes(a[1]);
      if (a[0] && typeof a[0] === 'object') return Object.hasOwn(a[0], String(a[1]));
      return false;
    case 'count': return Array.isArray(a[0]) ? a[0].filter((x) => x === a[1]).length : undefined;
    case 'all': return Array.isArray(a[0]) ? a[0].every((x) => x === a[1]) : false;
    case 'any': return Array.isArray(a[0]) ? a[0].some((x) => x === a[1]) : false;
    case 'concat': return a.map((x) => String(x ?? '')).join('');
    case 'upper': return typeof a[0] === 'string' ? a[0].toUpperCase() : undefined;
    case 'lower': return typeof a[0] === 'string' ? a[0].toLowerCase() : undefined;
    case 'matches':
      if (typeof a[0] !== 'string' || typeof a[1] !== 'string') return false;
      try { return new RegExp(a[1]).test(a[0]); } catch { return false; }
    case 'startsWith': return typeof a[0] === 'string' && typeof a[1] === 'string' ? a[0].startsWith(a[1]) : false;
    case 'endsWith': return typeof a[0] === 'string' && typeof a[1] === 'string' ? a[0].endsWith(a[1]) : false;
    default: throw new ExprError(`unknown operator: ${name}`);
  }
}

/** True when the predicate holds. Non-boolean results count as failure. */
export function holds(e, state) {
  return evaluate(e, state) === true;
}

/**
 * Static read-set: every `ref` path, plus the parent container of any path
 * (writing a sibling key changes `len(obj)` / `has(obj,k)`).
 * Conservative by design — attribution would rather over-blame than miss.
 */
export function reads(e, out = new Set()) {
  if (!e || typeof e !== 'object') return out;
  if (e.t === 'ref') {
    out.add(e.path);
    const i = e.path.lastIndexOf('.');
    if (i > 0) out.add(e.path.slice(0, i));
    return out;
  }
  if (e.t === 'op') for (const a of e.args) reads(a, out);
  return out;
}

/** Stable stringify: object keys sorted, so hashes do not depend on key order. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}