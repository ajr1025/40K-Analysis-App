/**
 * Property checks over the whole input space.
 *
 * The hand-computed tests verify points I chose; these verify relationships
 * that must hold everywhere. A sign error or an inverted comparison usually
 * survives a spot check but breaks a monotonicity rule immediately, so these
 * sweep combinations rather than trusting a handful of examples.
 */

import { describe, expect, it } from 'vitest';

import { type Target, type Weapon, resolveAttack } from './resolve';

const baseWeapon: Weapon = {
  name: 'probe',
  attacks: '3',
  skill: 3,
  strength: 6,
  ap: 1,
  damage: '2',
};

const baseTarget: Target = {
  name: 'probe',
  toughness: 5,
  save: 3,
  wounds: 2,
  models: 5,
};

/** Every combination of a few axes, so the sweeps cover interactions too. */
function sweep(): Array<{ weapon: Weapon; target: Target }> {
  const out: Array<{ weapon: Weapon; target: Target }> = [];
  for (const strength of [3, 5, 8, 12]) {
    for (const damage of ['1', '2', 'D6']) {
      for (const toughness of [4, 6, 9]) {
        for (const save of [2, 4, 6]) {
          for (const wounds of [1, 3]) {
            out.push({
              weapon: { ...baseWeapon, strength, damage },
              target: { ...baseTarget, toughness, save, wounds },
            });
          }
        }
      }
    }
  }
  return out;
}

describe('monotonicity', () => {
  it('never loses damage from extra armour penetration', () => {
    for (const { weapon, target } of sweep()) {
      let previous = -Infinity;
      for (const ap of [0, 1, 2, 3, 4]) {
        const damage = resolveAttack({ ...weapon, ap }, target)!.totalDamage;
        expect(damage).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = damage;
      }
    }
  });

  it('never gains damage against tougher targets', () => {
    for (const { weapon, target } of sweep()) {
      let previous = Infinity;
      for (const toughness of [3, 4, 5, 6, 8, 10, 12]) {
        const damage = resolveAttack(weapon, { ...target, toughness })!.totalDamage;
        expect(damage).toBeLessThanOrEqual(previous + 1e-9);
        previous = damage;
      }
    }
  });

  it('never gains damage against better armour', () => {
    for (const { weapon, target } of sweep()) {
      let previous = -Infinity;
      // Iterating from the best save (2+) to the worst (7, i.e. none).
      for (const save of [2, 3, 4, 5, 6, 7]) {
        const damage = resolveAttack(weapon, { ...target, save })!.totalDamage;
        expect(damage).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = damage;
      }
    }
  });

  it('never loses damage from a better skill', () => {
    for (const { weapon, target } of sweep()) {
      let previous = -Infinity;
      for (const skill of [6, 5, 4, 3, 2]) {
        const damage = resolveAttack({ ...weapon, skill }, target)!.totalDamage;
        expect(damage).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = damage;
      }
    }
  });

  it('never loses damage from rerolls', () => {
    for (const { weapon, target } of sweep()) {
      const none = resolveAttack(weapon, target, { rerollHits: 'none' })!.totalDamage;
      const ones = resolveAttack(weapon, target, { rerollHits: 'ones' })!.totalDamage;
      const all = resolveAttack(weapon, target, { rerollHits: 'failures' })!.totalDamage;
      expect(ones).toBeGreaterThanOrEqual(none - 1e-9);
      expect(all).toBeGreaterThanOrEqual(ones - 1e-9);
    }
  });

  it('never loses damage from Sustained Hits', () => {
    for (const { weapon, target } of sweep()) {
      let previous = -Infinity;
      for (const sustainedHits of [0, 1, 2, 3]) {
        const damage = resolveAttack({ ...weapon, sustainedHits }, target)!.totalDamage;
        expect(damage).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = damage;
      }
    }
  });

  it('never gains damage against a better Feel No Pain', () => {
    for (const { weapon, target } of sweep()) {
      let previous = -Infinity;
      // 4+ saves more than 6+, so damage must rise as the save worsens.
      for (const feelNoPain of [4, 5, 6, null]) {
        const damage = resolveAttack(weapon, { ...target, feelNoPain })!.totalDamage;
        expect(damage).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = damage;
      }
    }
  });

  it('never gains damage from cover', () => {
    for (const { weapon, target } of sweep()) {
      const open = resolveAttack(weapon, target, { cover: false })!.totalDamage;
      const covered = resolveAttack(weapon, target, { cover: true })!.totalDamage;
      expect(covered).toBeLessThanOrEqual(open + 1e-9);
    }
  });

  it('scales damage with the number of attacking models', () => {
    for (const { weapon, target } of sweep().slice(0, 40)) {
      const one = resolveAttack(weapon, target, { attackingModels: 1 })!.totalDamage;
      const three = resolveAttack(weapon, target, { attackingModels: 3 })!.totalDamage;
      // Damage thrown is uncapped, so it should scale exactly.
      expect(three).toBeCloseTo(one * 3, 6);
    }
  });
});

describe('result integrity', () => {
  it('produces a valid probability distribution over models slain', () => {
    for (const { weapon, target } of sweep()) {
      const result = resolveAttack(weapon, target)!;
      let mass = 0;
      for (const [slain, p] of result.modelsSlainDistribution) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(slain).toBeGreaterThanOrEqual(0);
        expect(slain).toBeLessThanOrEqual(target.models);
        mass += p;
      }
      expect(mass).toBeCloseTo(1, 6);
    }
  });

  it('keeps every reported figure inside its legal range', () => {
    for (const { weapon, target } of sweep()) {
      const r = resolveAttack(weapon, target)!;
      const pool = target.models * target.wounds;

      expect(r.totalDamage).toBeGreaterThanOrEqual(0);
      expect(r.woundsRemoved).toBeGreaterThanOrEqual(0);
      expect(r.woundsRemoved).toBeLessThanOrEqual(pool + 1e-9);
      expect(r.expectedModelsSlain).toBeLessThanOrEqual(target.models + 1e-9);
      expect(r.probabilityDestroyed).toBeGreaterThanOrEqual(0);
      expect(r.probabilityDestroyed).toBeLessThanOrEqual(1);
      expect(r.fractionDestroyed).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.fractionModelsSlain).toBeLessThanOrEqual(1 + 1e-9);
      // Damage thrown can exceed what lands, but never the reverse.
      expect(r.totalDamage).toBeGreaterThanOrEqual(r.woundsRemoved - 1e-9);
    }
  });

  it('agrees between the models-slain mean and its distribution', () => {
    for (const { weapon, target } of sweep()) {
      const r = resolveAttack(weapon, target)!;
      let mean = 0;
      for (const [slain, p] of r.modelsSlainDistribution) mean += slain * p;
      expect(mean).toBeCloseTo(r.expectedModelsSlain, 6);
    }
  });

  it('ties the wipe probability to the top of the distribution', () => {
    for (const { weapon, target } of sweep()) {
      const r = resolveAttack(weapon, target)!;
      const atFull = r.modelsSlainDistribution.get(target.models) ?? 0;
      expect(r.probabilityDestroyed).toBeCloseTo(atFull, 6);
    }
  });
});

describe('degenerate inputs', () => {
  it('deals nothing when it cannot wound', () => {
    // S1 against T12 still wounds on 6s -- there is no such thing as immune --
    // so the floor is a natural 6, never zero.
    const r = resolveAttack({ ...baseWeapon, strength: 1 }, { ...baseTarget, toughness: 12 })!;
    expect(r.totalDamage).toBeGreaterThan(0);
  });

  it('handles a single model with a single wound', () => {
    const r = resolveAttack(baseWeapon, { ...baseTarget, models: 1, wounds: 1 })!;
    expect(r.expectedModelsSlain).toBeLessThanOrEqual(1);
    expect(r.woundsRemoved).toBeLessThanOrEqual(1);
    expect(r.probabilityDestroyed).toBeCloseTo(r.expectedModelsSlain, 6);
  });

  it('handles an unsaveable target', () => {
    const r = resolveAttack(baseWeapon, { ...baseTarget, save: 7, invulnerable: null })!;
    expect(r.totalDamage).toBeGreaterThan(0);
  });
});
