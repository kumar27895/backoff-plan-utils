/**
 * Core backoff plan logic for backoff-plan-utils.
 *
 * A "plan" is a callable that produces the next delay (in ms) for a given
 * attempt number. Plans are pure functions over (attempt) — no internal state,
 * no wall-clock access — which makes them trivial to unit test deterministically.
 */

/**
 * Convert an exponential base to a plan.
 *
 * We pick exponential-with-decorrelated-jitter as the default because plain
 * exponential backoff produces synchronized retry storms when many clients
 * fail simultaneously. Full decorrelated jitter (setting the delay to a fresh
 * random value in [base, prev*3]) breaks the synchrony without unbounded growth,
 * which a simple +/- additive jitter does not.
 *
 * @param {object} opts
 * @param {number} opts.baseMs — initial delay range upper bound, in milliseconds.
 * @param {number} opts.capMs — per-attempt ceiling, in milliseconds.
 * @param {number} [opts.seed] — deterministic PRNG seed for testing. If omitted, uses Math.random.
 * @returns {(attempt: number, prev: number) => number}
 */
export function exponentialWithJitter({ baseMs, capMs, seed }) {
  if (!Number.isFinite(baseMs) || baseMs <= 0) {
    throw new RangeError('baseMs must be a positive finite number');
  }
  if (!Number.isFinite(capMs) || capMs <= 0) {
    throw new RangeError('capMs must be a positive finite number');
  }
  if (baseMs > capMs) {
    throw new RangeError('baseMs must not exceed capMs');
  }

  const rand = makeRng(seed);

  return function plan(attempt, prev) {
    const a = attempt < 1 ? 1 : attempt;
    // Decorrelated jitter: new delay is uniform in [baseMs, prev*3], clamped to capMs.
    // prev defaults to baseMs so attempt 1 draws from [baseMs, baseMs*3], which
    // is the canonical AWS decorrelated-jitter formulation for the first retry.
    const p = (!Number.isFinite(prev) || prev <= 0) ? baseMs : prev;
    const top = Math.min(p * 3, capMs);
    const low = Math.min(baseMs, top);
    return low + rand() * (top - low);
  };
}

/**
 * Given a plan and an elapsed-ms counter, compute how many attempts fit within
 * a total cutoff. Returns the list of per-attempt delays.
 *
 * The caller supplies `nowMs` (a function returning elapsed ms since the start of
 * the retry sequence) rather than reading Date.now() internally. This is the
 * single injection point that lets us test cutoff behavior without sleeping and
 * without depending on wall-clock scheduling jitter.
 *
 * Interpretation chosen: the cutoff bounds the cumulative delay *before* an
 * attempt — i.e., the sum of delays 1..n must not exceed the cutoff. If the
 * very first delay already exceeds the cutoff, we still return that one delay
 * so the caller gets at least one retry. The cutoff does not bound the work
 * done during the retry itself, only the waiting time.
 *
 * @param {object} opts
 * @param {(attempt: number, prev: number) => number} opts.plan
 * @param {number} opts.cutoffMs
 * @param {() => number} opts.nowMs — monotonic elapsed-ms clock; must be >= 0 at first call.
 * @param {number} [opts.maxAttempts=20] — hard ceiling on attempts regardless of cutoff.
 * @returns {number[]} per-attempt delays in milliseconds
 */
export function planWithinCutoff({ plan, cutoffMs, nowMs, maxAttempts = 20 }) {
  if (typeof plan !== 'function') {
    throw new TypeError('plan must be a function');
  }
  if (!Number.isFinite(cutoffMs) || cutoffMs < 0) {
    throw new RangeError('cutoffMs must be a finite non-negative number');
  }
  if (typeof nowMs !== 'function') {
    throw new TypeError('nowMs must be a function');
  }
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
   throw new RangeError('maxAttempts must be a finite number >= 1');
  }

  const delays = [];
  let prev = NaN;
  let attempt = 1;

  while (attempt <= maxAttempts) {
    const d = plan(attempt, prev);
    if (!Number.isFinite(d) || d < 0) {
      throw new RangeError(`plan returned invalid delay ${d} at attempt ${attempt}`);
    }

    // Elapsed wall time from the caller's clock. This is not sum-of-delays —
    // it accounts for the actual time consumed by work between retries, so a
    // slow operation eats into the retry budget the same way a long sleep does.
    const elapsed = nowMs();
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      throw new RangeError(`nowMs returned invalid value ${elapsed}`);
    }

    const remaining = cutoffMs - elapsed;

    // If we are already out of budget, stop without scheduling this attempt.
    if (attempt > 1 && remaining <= 0) {
      break;
    }

    // Allow at least one attempt even if its delay exceeds the cutoff, so the
    // caller always gets one retry. Subsequent attempts must fit.
    if (attempt > 1 && d > remaining) {
      break;
    }

    delays.push(d);
    prev = d;
    attempt += 1;
  }

  return delays;
}

/**
 * Create a deterministic PRNG from a numeric seed (mulberry32). Used only when
 * the caller wants reproducible jitter — production code leaves `seed` undefined
 * and gets Math.random. We implement our own instead of taking a `rng` callback
 * because (a) keeping the surface area minimal and (b) Math.random's contract
 * (return a float in [0,1)) is simpler to honour than exposing a PRNG interface.
 *
 * @param {number|undefined} seed
 * @returns {() => number}
 */
function makeRng(seed) {
  if (seed === undefined || seed === null) {
    return Math.random;
  }
  if (!Number.isFinite(seed)) {
    throw new RangeError('seed must be a finite number');
  }
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
