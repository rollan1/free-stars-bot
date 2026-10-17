import crypto from 'node:crypto';

/** Order of the wheel segments. Also the order used by the cumulative roll. */
export const OUTCOMES = ['cake', 'bear', 'heart', 'none'];

export const GIFTS = {
  bear: { id: 'bear', emoji: '🧸', title: 'Мишка', image: '/assets/bear.png' },
  heart: { id: 'heart', emoji: '❤️', title: 'Сердце', image: '/assets/heart.png' },
  cake: { id: 'cake', emoji: '🎂', title: 'Торт «Мерцание»', image: '/assets/cake.png' },
};

export const OUTCOME_META = {
  ...GIFTS,
  none: { id: 'none', emoji: '🍃', title: 'Ничего', image: null },
};

export const TOTAL_PERCENT = 100;
/** 1% -> 10000, so 100% -> 1_000_000 discrete units. */
const UNITS_PER_PERCENT = 10_000;
const TOTAL_UNITS = TOTAL_PERCENT * UNITS_PER_PERCENT;
const EPSILON = 1e-6;

export class ProbabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProbabilityError';
    this.status = 400;
  }
}

/**
 * Validates a probability set: only known keys, non-negative, and summing to exactly 100.
 */
export function validateProbabilities(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProbabilityError('Probabilities must be an object');
  }
  const keys = Object.keys(input);
  const unknown = keys.filter((k) => !OUTCOMES.includes(k));
  if (unknown.length) throw new ProbabilityError(`Unknown outcomes: ${unknown.join(', ')}`);
  const missing = OUTCOMES.filter((k) => !keys.includes(k));
  if (missing.length) throw new ProbabilityError(`Missing outcomes: ${missing.join(', ')}`);

  const clean = {};
  for (const key of OUTCOMES) {
    const raw = input[key];
    const value = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ProbabilityError(`"${key}" must be a finite number`);
    }
    if (value < 0) throw new ProbabilityError(`"${key}" must not be negative`);
    if (value > TOTAL_PERCENT) throw new ProbabilityError(`"${key}" must not exceed ${TOTAL_PERCENT}`);
    clean[key] = value;
  }

  const sum = OUTCOMES.reduce((acc, k) => acc + clean[k], 0);
  if (Math.abs(sum - TOTAL_PERCENT) > EPSILON) {
    throw new ProbabilityError(`Probabilities must sum to exactly ${TOTAL_PERCENT}, got ${round(sum, 6)}`);
  }
  return clean;
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function probabilitiesToUnits(probabilities) {
  const units = {};
  for (const key of OUTCOMES) units[key] = Math.round(probabilities[key] * UNITS_PER_PERCENT);
  return units;
}

/** Cryptographically secure integer in [0, max). */
function randomUnit(max) {
  return crypto.randomInt(0, max);
}

/**
 * Server-side result of one normal spin.
 * The random value is produced only here — the client never picks the outcome.
 */
export function rollOutcome(probabilities) {
  const units = probabilitiesToUnits(probabilities);
  const unitTotal = OUTCOMES.reduce((acc, k) => acc + units[k], 0);
  if (Math.abs(unitTotal - TOTAL_UNITS) > 1) {
    throw new ProbabilityError(`Probabilities do not resolve to ${TOTAL_UNITS} units (got ${unitTotal})`);
  }
  const point = randomUnit(TOTAL_UNITS);
  let acc = 0;
  for (const key of OUTCOMES) {
    acc += units[key];
    if (point < acc) return { outcome: key, roll: round(point / TOTAL_UNITS, 6) };
  }
  // Unreachable while probabilities sum to 100, but never return a wrong prize by accident.
  return { outcome: 'none', roll: round(point / TOTAL_UNITS, 6) };
}

/** Runs `rolls` rolls and returns the observed distribution. Used by the test suite. */
export function simulateDistribution(probabilities, rolls, pick = rollOutcome) {
  const counts = Object.fromEntries(OUTCOMES.map((k) => [k, 0]));
  for (let i = 0; i < rolls; i += 1) counts[pick(probabilities).outcome] += 1;
  return Object.fromEntries(
    OUTCOMES.map((k) => [k, { count: counts[k], share: counts[k] / rolls, expected: probabilities[k] / 100 }]),
  );
}