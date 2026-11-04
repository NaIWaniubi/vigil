import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  num, bool, str, ref, op, evaluate, holds, reads, validate, canonical, ExprError,
} from '../engine/expr.mjs';

test('literals and refs evaluate', () => {
  assert.equal(evaluate(num(3), {}), 3);
  assert.equal(evaluate(bool(true), {}), true);
  assert.equal(evaluate(str('x'), {}), 'x');
  assert.equal(evaluate(ref('a.b'), { a: { b: 7 } }), 7);
});

test('missing refs are undefined, comparisons with them are false', () => {
  assert.equal(evaluate(ref('nope.deep'), {}), undefined);
  assert.equal(holds(op('gt', ref('nope'), num(1)), {}), false);
  assert.equal(holds(op('eq', ref('nope'), ref('alsoNope')), {}), true, 'undefined === undefined');
});

test('arithmetic guards non-numeric and division by zero', () => {
  assert.equal(evaluate(op('add', num(2), num(3)), {}), 5);
  assert.equal(evaluate(op('add', str('a'), num(3)), {}), undefined);
  assert.equal(evaluate(op('div', num(1), num(0)), {}), undefined);
  assert.equal(evaluate(op('sum', ref('xs')), { xs: [1, 2, 'x', 3] }), 6);
});

test('aggregate and collection operators', () => {
  const s = { xs: [1, 2, 2, 3], obj: { a: 1, b: 2 } };
  assert.equal(evaluate(op('len', ref('xs')), s), 4);
  assert.equal(evaluate(op('len', ref('obj')), s), 2);
  assert.equal(evaluate(op('count', ref('xs'), num(2)), s), 2);
  assert.equal(holds(op('has', ref('obj'), str('a')), s), true);
  assert.equal(holds(op('in', num(2), ref('xs')), s), true);
  assert.equal(holds(op('all', ref('xs'), num(2)), s), false);
  assert.equal(holds(op('any', ref('xs'), num(3)), s), true);
});

test('string operators', () => {
  const s = { name: 'Paul' };
  assert.equal(holds(op('startsWith', ref('name'), str('Pa')), s), true);
  assert.equal(holds(op('matches', ref('name'), str('^P.*l$')), s), true);
  assert.equal(holds(op('matches', ref('name'), str('[')), s), false, 'bad regex is false, not a crash');
  assert.equal(evaluate(op('concat', str('a'), num(1)), s), 'a1');
});

test('reads includes parent containers', () => {
  const r = reads(op('and', op('gt', ref('a.b'), num(1)), op('len', ref('xs'))));
  assert.ok(r.has('a.b'));
  assert.ok(r.has('a'), 'parent of a.b must be in read-set');
  assert.ok(r.has('xs'));
});

test('validate rejects malformed trees', () => {
  assert.throws(() => validate(op('add', num(1))), ExprError);
  assert.throws(() => validate(op('bogus', num(1))), ExprError);
  assert.throws(() => validate({ t: 'ref', path: '' }), ExprError);
  assert.throws(() => validate({ t: 'ref', path: 'a..b' }), ExprError);
  assert.throws(() => validate(num(Infinity)), ExprError);
  assert.throws(() => validate({ t: 'wat' }), ExprError);
});

test('canonical is key-order independent', () => {
  assert.equal(canonical({ b: 1, a: { d: 2, c: 3 } }), canonical({ a: { c: 3, d: 2 }, b: 1 }));
  assert.notEqual(canonical({ a: 1 }), canonical({ a: 2 }));
});