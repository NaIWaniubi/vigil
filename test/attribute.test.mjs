import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffPaths, touches, classifyViolation, summariseAttribution } from '../engine/attribute.mjs';
import { ref, op, num } from '../engine/expr.mjs';

test('diffPaths finds leaf changes and treats arrays as leaves', () => {
  const a = { x: 1, nest: { y: 2, z: 3 }, arr: [1, 2] };
  const b = { x: 9, nest: { y: 2, z: 4 }, arr: [1, 2, 3] };
  assert.deepEqual(diffPaths(a, b).sort(), ['arr', 'nest.z', 'x']);
});

test('diffPaths reports added and removed keys', () => {
  assert.deepEqual(diffPaths({ a: 1 }, { b: 2 }).sort(), ['a', 'b']);
  assert.deepEqual(diffPaths({}, {}), []);
});

test('diffPaths handles type changes without throwing', () => {
  assert.deepEqual(diffPaths({ a: { b: 1 } }, { a: 5 }), ['a']);
  assert.deepEqual(diffPaths({ a: null }, { a: { b: 1 } }), ['a']);
});

test('touches is bidirectional on prefix relations', () => {
  const rs = new Set(['tank.level', 'tank']);
  assert.ok(touches('tank.level', rs));
  assert.ok(touches('tank', rs), 'replacing the container affects the leaf');
  assert.ok(touches('tank.level.deep', rs), 'leaf write affects a constraint reading the parent');
  assert.ok(!touches('pipe.open', rs));
});

test('classifyViolation covers all five classes', () => {
  const c = { id: 'c', predicate: op('gt', ref('a.b'), num(0)) };
  const readSet = new Set(['a.b', 'a']);
  const base = { constraint: c, readSet };
  assert.equal(classifyViolation({ ...base, wasHolding: true, justRevealed: false, changed: ['a.b'] }), 'broke');
  assert.equal(classifyViolation({ ...base, wasHolding: true, justRevealed: false, changed: ['other'] }), 'collateral');
  assert.equal(classifyViolation({ ...base, wasHolding: false, justRevealed: true, changed: [] }), 'revealed');
  assert.equal(classifyViolation({ ...base, wasHolding: false, justRevealed: false, changed: ['other'] }), 'neglected');
  assert.equal(classifyViolation({ ...base, wasHolding: false, justRevealed: false, changed: ['a.b'] }), 'regressed');
});

test('summariseAttribution separates constraint failures from obligation deaths', () => {
  const records = [
    { constraintId: 'c1', class: 'broke', ageInSteps: 3 },
    { constraintId: 'c1', class: 'neglected', ageInSteps: 8 },
    { constraintId: 'c2', class: 'revealed', ageInSteps: 0 },
    { obligationId: 'paul', class: 'obligation_lapsed', ageInSteps: 12 },
  ];
  const s = summariseAttribution(records);
  assert.equal(s.total, 4);
  assert.equal(s.constraintViolations, 3);
  assert.equal(s.obligationDeaths, 1);
  assert.equal(s.byClass.broke, 1);
  assert.equal(s.byConstraint.c1, 2);
  assert.equal(s.oldestViolatedConstraintAge, 12);
  assert.equal(s.meanViolationAge, (3 + 8 + 0) / 3);
});