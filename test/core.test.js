import { test } from 'node:test';
import assert from 'node:assert/strict';

import { exponentialWithJitter, planWithinCutoff } from '../src/index.js';

test('exponentialWithJitter returns finite delays within [baseMs, capMs]', () => {
  const plan = exponentialWithJitter({ baseMs: 100, capMs: 5000, seed: 42 });
  let prev = NaN;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const d = plan(attempt, prev);
    assert.ok(Number.isFinite(d), `attempt ${attempt} got non-finite ${d}`);
    assert.ok(d >= 0, `attempt ${attempt} got negative ${d}`);
    assert.ok(d <= 5000, `attempt ${attempt} exceeded cap: ${d}`);
    prev = d;
  }
});

test('exponentialWithJitter is deterministic for a fixed seed', () => {
  const p1 = exponentialWithJitter({ baseMs: 10, capMs: 1000, seed: 7 });
  const p2 = exponentialWithJitter({ baseMs: 10, capMs: 1000, seed: 7 });
  let a = NaN, b = NaN;
  for (let i = 1; i <= 10; i++) {
    a = p1(i, a);
    b = p2(i, b);
    assert.equal(a, b);
  }
});

test('first attempt ignores prev and draws from [baseMs, baseMs*3] clamped to cap', () => {
  // With prev=NaN or 0, top = baseMs*3 = 600. All draws must be within [200, 600].
  const plan = exponentialWithJitter({ baseMs: 200, capMs: 10_000, seed: 1 });
  for (let i = 0; i < 100; i++) {
    const d = plan(1, NaN);
    assert.ok(d >= 200 && d <= 600, `draw ${d} outside [200, 600]`);
  }
});

test('delay never exceeds capMs even when prev is huge', () => {
  const plan = exponentialWithJitter({ baseMs: 100, capMs: 1000, seed: 5 });
  for (let i = 0; i < 50; i++) {
    const d = plan(5, 10_000_000);
    assert.ok(d <= 1000, `drew ${d} above cap`);
  }
});

test('baseMs exceeds capMs throws', () => {
  assert.throws(
    () => exponentialWithJitter({ baseMs: 5000, capMs: 100, seed: 1 }),
    RangeError,
  );
});

test('invalid baseMs or capMs throws', () => {
  assert.throws(() => exponentialWithJitter({ baseMs: 0, capMs: 10 }), RangeError);
  assert.throws(() => exponentialWithJitter({ baseMs: -1, capMs: 10 }), RangeError);
  assert.throws(() => exponentialWithJitter({ baseMs: NaN, capMs: 10 }), RangeError);
  assert.throws(() => exponentialWithJitter({ baseMs: 10, capMs: 0 }), RangeError);
});

test('planWithinCutoff returns delays bounded by cutoff when elapsed is zero', () => {
  const plan = exponentialWithJitter({ baseMs: 100, capMs: 10_000, seed: 99 });
  const delays = planWithinCutoff({
    plan,
    cutoffMs: 1000,
    nowMs: () => 0,
    maxAttempts: 50,
  });
  assert.ok(delays.length >= 1);
  // Sum of all but possibly the last must be under 1000.
  for (let i = 0; i < delays.length - 1; i++) {
    const partial = delays.slice(0, i + 1).reduce((a, b) => a + b, 0);
    assert.ok(partial <= 1000, `partial sum ${partial} exceeded cutoff at index ${i}`);
  }
});

test('planWithinCutoff always returns at least one delay', () => {
  const plan = exponentialWithJitter({ baseMs: 500, capMs: 10_000, seed: 3 });
  const delays = planWithinCutoff({
    plan,
    cutoffMs: 1,
    nowMs: () => 0,
    maxAttempts: 10,
  });
  assert.equal(delays.length, 1);
});

test('planWithinCutoff stops adding attempts when elapsed exceeds cutoff', () => {
  // Fake clock advances with each call: 0, 500, 1000, 1001...
  let callCount = 0;
  const nowMs = () => {
    const v = [0, 500, 1000, 1001][callCount] ?? 1002;
    callCount += 1;
    return v;
  };
  const plan = (attempt) => 100; // constant for predictability
  const delays = planWithinCutoff({
    plan,
    cutoffMs: 1000,
    nowMs,
    maxAttempts: 20,
  });
  assert.ok(delays.length >= 1 && delays.length <= 2);
});

test('planWithinCutoff respects maxAttempts even when cutoff is huge', () => {
  const plan = () => 1;
  const delays = planWithinCutoff({
    plan,
    cutoffMs: 1_000_000_000,
    nowMs: () => 0,
    maxAttempts: 3,
  });
  assert.equal(delays.length, 3);
});

test('planWithinCutoff invalid args throw', () => {
  assert.throws(() => planWithinCutoff({ plan: null, cutoffMs: 1000, nowMs: () => 0 }), TypeError);
  assert.throws(() => planWithinCutoff({ plan: () => 1, cutoffMs: -1, nowMs: () => 0 }), RangeError);
  assert.throws(() => planWithinCutoff({ plan: () => 1, cutoffMs: 1000, nowMs: null }), TypeError);
  assert.throws(() => planWithinCutoff({ plan: () => 1, cutoffMs: 1000, nowMs: () => 0, maxAttempts: 0 }), RangeError);
});

test('planWithinCutoff throws when plan returns a non-finite delay', () => {
  const plan = () => NaN;
  assert.throws(
    () => planWithinCutoff({ plan, cutoffMs: 1000, nowMs: () => 0, maxAttempts: 5 }),
    RangeError,
  );
});

test('planWithinCutoff throws when nowMs returns a negative value', () => {
  const plan = () => 100;
  assert.throws(
    () => planWithinCutoff({ plan, cutoffMs: 1000, nowMs: () => -5, maxAttempts: 5 }),
    RangeError,
  );
});
