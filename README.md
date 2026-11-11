# backoff-plan-utils

Retry plans with decorrelated jitter, bounded by a total cutoff time. Pure functions over the attempt number — no timers, no side effects, no wall-clock reads inside the library.

## Usage

```js
import { exponentialWithJitter, planWithinCutoff } from 'backoff-plan-utils';

const plan = exponentialWithJitter({ baseMs: 100, capMs: 5000, seed: 42 });
// `plan(attempt, prevDelayMs)` returns the next delay in milliseconds.

const fakeElapsed = (() => { let t = 0; return () => (t = t + 0); })();
const delays = planWithinCutoff({
  plan,
  cutoffMs: 1000,
  nowMs: fakeElapsed,
  maxAttempts: 10,
});
// delays: number[] — e.g. [283, 521, 196] — use them to schedule sleeps between retries.
```

## Why

Plain exponential backoff without jitter causes synchronized retry storms: every client that failed at the same instant retries at the same cadence, hammering a recovering service in lockstep. This library implements **decorrelated jitter** (the AWS-recommended variant): each delay is uniform in `[baseMs, prev * 3]`, clamped to `capMs`. The first attempt draws from `[baseMs, baseMs * 3]`. This breaks synchrony without unbounded growth, which additive `+/-` jitter does not achieve.

The `planWithinCutoff` wrapper bounds the total wait time spent in retries. It takes a `nowMs` callback returning elapsed ms since the start of the retry sequence — not a sum of produced delays, the actual elapsed wall time — so that slow work between retries eats into the retry budget exactly like a long sleep does. **You supply the clock** so tests are deterministic; pass `Date.now() - startTime` in production code.

## Edge cases

- **At least one retry.** If the first computed delay already exceeds `cutoffMs`, `planWithinCutoff` still returns that single delay. The cutoff bounds *scheduling*, not the right to retry at least once.
- **Eligibility is checked at scheduling time.** `planWithinCutoff` stops adding a delay when `nowMs()` reports the cutoff has already been exceeded, even if the plan itself would have produced a small delay.
- **`baseMs` must not exceed `capMs`.** If you pass `baseMs > capMs`, `exponentialWithJitter` throws immediately rather than silently clamping.
- **Seeded PRNG only for testing.** Omit `seed` in production to use `Math.random`. The seeded generator is mulberry32, chosen for small size and adequate statistical quality for jitter; it is not cryptographically secure and does not claim to be.

## Exports

| Name | Signature |
|---|---|
| `exponentialWithJitter` | `({ baseMs, capMs, seed? }) => (attempt: number, prev: number) => number` |
| `planWithinCutoff` | `({ plan, cutoffMs, nowMs, maxAttempts? }) => number[]` |

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

