import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTCOMES,
  ProbabilityError,
  probabilitiesToUnits,
  rollOutcome,
  simulateDistribution,
  validateProbabilities,
} from '../server/roulette.js';

const BASE = { cake: 1, bear: 3, heart: 3, none: 93 };

test('вероятности по умолчанию валидны и дают ровно 100%', () => {
  const clean = validateProbabilities(BASE);
  assert.equal(clean.cake, 1);
  assert.equal(clean.bear, 3);
  assert.equal(clean.heart, 3);
  assert.equal(clean.none, 93);
  assert.equal(OUTCOMES.reduce((a, k) => a + clean[k], 0), 100);
});

test('сумма вероятностей ровно 100 — единицы веса', () => {
  const units = probabilitiesToUnits(BASE);
  assert.equal(units.cake, 10000);
  assert.equal(units.bear, 30000);
  assert.equal(units.heart, 30000);
  assert.equal(units.none, 930000);
  assert.equal(Object.values(units).reduce((a, b) => a + b, 0), 1_000_000);
});

test('сумма не равна 100 — отклоняется', () => {
  assert.throws(() => validateProbabilities({ cake: 1, bear: 3, heart: 3, none: 92 }), ProbabilityError);
  assert.throws(() => validateProbabilities({ cake: 2, bear: 3, heart: 3, none: 93 }), /sum to exactly 100/);
});

test('отрицательные и неизвестные значения отклоняются', () => {
  assert.throws(() => validateProbabilities({ cake: -1, bear: 3, heart: 3, none: 95 }), /negative/);
  assert.throws(() => validateProbabilities({ cake: 1, bear: 3, heart: 3, none: 93, jackpot: 1 }), /Unknown outcomes/);
  assert.throws(() => validateProbabilities({ cake: 1, bear: 3, heart: 3 }), /Missing outcomes/);
  assert.throws(() => validateProbabilities({ cake: 101, bear: 3, heart: 3, none: -4 }), /exceed|negative/);
});

test('дробные вероятности принимаются, если сумма равна 100', () => {
  const clean = validateProbabilities({ cake: 0.5, bear: 2.25, heart: 2.25, none: 95 });
  assert.equal(clean.cake, 0.5);
  assert.equal(Object.values(probabilitiesToUnits(clean)).reduce((a, b) => a + b, 0), 1_000_000);
});

test('исход всегда из известного набора, roll в [0,1)', () => {
  for (let i = 0; i < 5000; i += 1) {
    const r = rollOutcome(BASE);
    assert.ok(OUTCOMES.includes(r.outcome), `unknown outcome ${r.outcome}`);
    assert.ok(r.roll >= 0 && r.roll < 1, `roll out of range: ${r.roll}`);
  }
});

test('распределение 1% / 3% / 3% / 93% на 400 000 спинов', () => {
  const ROLLS = 400_000;
  const dist = simulateDistribution(BASE, ROLLS);
  // 4σ допуск: cake σ≈0.0005, bear σ≈0.000866, none σ≈0.002165
  const tolerance = 4;
  for (const key of OUTCOMES) {
    const expected = BASE[key] / 100;
    const sigma = Math.sqrt((expected * (1 - expected)) / ROLLS);
    const delta = Math.abs(dist[key].share - expected);
    assert.ok(
      delta <= tolerance * sigma,
      `${key}: share=${dist[key].share.toFixed(5)} expected=${expected} delta=${delta.toFixed(5)} > ${(tolerance * sigma).toFixed(5)}`,
    );
  }
  assert.equal(Object.values(dist).reduce((a, d) => a + d.count, 0), ROLLS);
});

test('крайние вероятности: 100% и 0% отрабатывают детерминированно', () => {
  const alwaysCake = { cake: 100, bear: 0, heart: 0, none: 0 };
  for (let i = 0; i < 200; i += 1) assert.equal(rollOutcome(alwaysCake).outcome, 'cake');

  const alwaysNone = { cake: 0, bear: 0, heart: 0, none: 100 };
  for (let i = 0; i < 200; i += 1) assert.equal(rollOutcome(alwaysNone).outcome, 'none');
});

test('границы весов: ровно на границе 1% выбирается cake', () => {
  // cake = 0.000001% -> 1 единица из 1e6
  const p = { cake: 0.0001, bear: 0, heart: 0, none: 99.9999 };
  const units = probabilitiesToUnits(p);
  assert.equal(units.cake, 1);
  assert.equal(Object.values(units).reduce((a, b) => a + b, 0), 1_000_000);
});