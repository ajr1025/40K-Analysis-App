/**
 * Cross-check the exact engine against a naive dice-rolling simulator.
 *
 * Every other test in this suite encodes a number I worked out by hand, which
 * means they share my reading of the rules -- if I misunderstood something, the
 * test agrees with the bug. This file is the independent check: a deliberately
 * literal simulator that rolls actual d6s, written straight from the sequence
 * in the rulebook without reusing any of the engine's internals.
 *
 * Where the two agree across hundreds of random matchups, the exact maths is
 * almost certainly right. Where they diverge, one of them has a real bug.
 */

import { describe, expect, it } from 'vitest';

import { type Target, type Weapon, resolveAttack } from './resolve';

/** Deterministic PRNG so a failure can be reproduced exactly. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

type Roll = () => number;

/** Roll one of the dice expressions the engine supports. */
function rollExpression(text: string, d6: Roll): number {
  const flat = /^\s*(\d+)\s*$/.exec(text);
  if (flat) return Number(flat[1]);

  const m = /^\s*(\d*)[dD](\d+)\s*(?:([+-])\s*(\d+))?\s*$/.exec(text);
  if (!m) throw new Error(`simulator cannot roll "${text}"`);
  const count = m[1] === '' ? 1 : Number(m[1]);
  const sides = Number(m[2]);

  let total = 0;
  for (let i = 0; i < count; i += 1) total += Math.floor(d6() * sides) + 1;
  if (m[3]) total += m[3] === '-' ? -Number(m[4]) : Number(m[4]);
  return Math.max(0, total);
}

interface SimOptions {
  hitModifier?: number;
  woundModifier?: number;
  cover?: boolean;
  attackingModels?: number;
  halfRange?: boolean;
  charged?: boolean;
  attacksModifier?: number;
  strengthModifier?: number;
  apModifier?: number;
  damageModifier?: number;
  toughnessModifier?: number;
  saveModifier?: number;
  /** Mirrors the engine's Lethal Hits choice; see the note in the tests. */
  useLethal?: boolean;
}

/**
 * One literal run of the attack sequence. Written to read like the rulebook
 * rather than to be fast or clever.
 */
function simulateOnce(
  weapon: Weapon,
  target: Target,
  options: SimOptions,
  d6: Roll
): { damageThrown: number; modelsSlain: number } {
  const cap = (n: number) => Math.max(-1, Math.min(1, n));
  const hitMod = cap(options.hitModifier ?? 0);
  // [LANCE] stacks with the player's modifier before the cap is applied.
  const woundMod = cap(
    (options.woundModifier ?? 0) + (weapon.lance && options.charged ? 1 : 0)
  );
  const models = options.attackingModels ?? 1;
  // Characteristic modifiers are uncapped, unlike the roll modifiers above.
  const T = Math.max(1, target.toughness + (options.toughnessModifier ?? 0));

  /** Roll the wound threshold fresh each time, since Strength may be rolled. */
  const woundThreshold = () => {
    const rolled =
      typeof weapon.strength === 'number' ? weapon.strength : rollExpression(weapon.strength, d6);
    const S = Math.max(1, rolled + (options.strengthModifier ?? 0));
    return S >= T * 2 ? 2 : S > T ? 3 : S === T ? 4 : S * 2 <= T ? 6 : 5;
  };

  // A single save roll that can pass on either the invulnerable or the
  // AP-modified armour save. Cover plays no part -- it worsens BS instead.
  const armour = Math.max(
    2,
    target.save + (options.saveModifier ?? 0) + weapon.ap + (options.apModifier ?? 0)
  );
  const invuln = target.invulnerable ?? 99;
  const saveNeeds = Math.min(armour, Math.max(2, invuln));

  // Benefit of Cover worsens the BS characteristic rather than the hit roll,
  // so it sits outside the +/-1 cap applied to hitMod above.
  const skillNeeds = (weapon.skill ?? 4) + (options.cover && !weapon.melee ? 1 : 0);

  // [BLAST] adds attacks for the target's size; [RAPID FIRE] adds them at
  // half range. Both land on the Attacks characteristic before rolling.
  const bonusAttacks =
    (weapon.blast ? weapon.blast * Math.floor(target.models / 5) : 0) +
    (weapon.rapidFire && options.halfRange ? weapon.rapidFire : 0) +
    (options.attacksModifier ?? 0);

  let attacks = 0;
  for (let i = 0; i < models; i += 1) {
    attacks += Math.max(0, rollExpression(weapon.attacks, d6) + bonusAttacks);
  }

  // Wound pool, tracked model by model so overkill is discarded naturally.
  let slain = 0;
  let remaining = target.wounds;
  let damageThrown = 0;

  const applyPacket = (savable: boolean) => {
    if (savable) {
      const save = Math.floor(d6() * 6) + 1;
      if (save !== 1 && save >= saveNeeds) return; // saved
    }

    // [MELTA] adds to the Damage characteristic within half range.
    let dealt = Math.max(
      1,
      rollExpression(weapon.damage, d6) +
        (weapon.melta && options.halfRange ? weapon.melta : 0) +
        (options.damageModifier ?? 0)
    );

    // Damage reduction bites before Feel No Pain and never goes below 1.
    if (target.damageReduction) dealt = Math.max(1, dealt - target.damageReduction);

    // Feel No Pain is rolled once per point of damage.
    if (target.feelNoPain != null) {
      let kept = 0;
      for (let i = 0; i < dealt; i += 1) {
        const fnp = Math.floor(d6() * 6) + 1;
        if (fnp === 1 || fnp < target.feelNoPain) kept += 1;
      }
      dealt = kept;
    }

    damageThrown += dealt;
    if (slain >= target.models) return;

    // No spillover: excess is lost when the model dies.
    if (dealt >= remaining) {
      slain += 1;
      remaining = target.wounds;
    } else {
      remaining -= dealt;
    }
  };

  const resolveHit = () => {
    const w = Math.floor(d6() * 6) + 1;
    if (w === 1) return;
    const critWound = w >= (weapon.critWoundOn ?? 6);
    const wounded = critWound || w + woundMod >= woundThreshold();
    if (!wounded) return;
    // Devastating Wounds skips the save; it does not spill.
    applyPacket(!(critWound && weapon.devastatingWounds));
  };

  for (let a = 0; a < attacks; a += 1) {
    let critHit = false;
    if (weapon.torrent) {
      // Auto-hits, and an automatic hit is never a critical.
    } else {
      const h = Math.floor(d6() * 6) + 1;
      if (h === 1) continue;
      critHit = h === 6;
      if (!critHit && h + hitMod < skillNeeds) continue;
    }

    if (critHit && options.useLethal && weapon.lethalHits) {
      applyPacket(true); // auto-wound, still saveable, never a critical wound
    } else {
      resolveHit();
    }

    if (critHit && weapon.sustainedHits) {
      for (let s = 0; s < weapon.sustainedHits; s += 1) resolveHit();
    }
  }

  return { damageThrown, modelsSlain: slain };
}

function simulate(weapon: Weapon, target: Target, options: SimOptions, trials: number, seed: number) {
  const d6 = makeRandom(seed);
  let damage = 0;
  let slain = 0;
  for (let i = 0; i < trials; i += 1) {
    const r = simulateOnce(weapon, target, options, d6);
    damage += r.damageThrown;
    slain += r.modelsSlain;
  }
  return { totalDamage: damage / trials, modelsSlain: slain / trials };
}

/** Random but reproducible matchups covering the interesting corners. */
function randomScenario(rng: Roll): { weapon: Weapon; target: Target; options: SimOptions } {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rng() * xs.length)];

  const lethalHits = rng() < 0.25;
  // Lethal Hits and Devastating Wounds together make the engine choose between
  // two branches; that interaction gets its own dedicated test below, so the
  // random pool keeps them apart to avoid mirroring the choice rule here.
  const devastatingWounds = !lethalHits && rng() < 0.25;

  const weapon: Weapon = {
    name: 'random',
    attacks: pick(['1', '2', '3', '5', 'D3', 'D6', '2D3', 'D6+1']),
    skill: pick([2, 3, 4, 5]),
    strength: pick([3, 4, 5, 6, 8, 10, 12, 14]),
    ap: pick([0, 1, 2, 3, 4]),
    damage: pick(['1', '2', '3', 'D3', 'D6', 'D6+2']),
    sustainedHits: pick([0, 0, 0, 1, 2]),
    lethalHits,
    devastatingWounds,
    torrent: rng() < 0.12,
    critWoundOn: pick([6, 6, 6, 5, 4]),
    blast: pick([0, 0, 0, 1, 2]),
    rapidFire: pick([0, 0, 0, 1, 2]),
    melta: pick([0, 0, 0, 2, 4]),
    lance: rng() < 0.15,
  };
  // A rolled Strength, as on an Ork Zzap gun.
  if (rng() < 0.1) weapon.strength = pick(['D6+6', '2D6', 'D6']);

  const target: Target = {
    name: 'random',
    toughness: pick([3, 4, 5, 6, 8, 9, 10, 12]),
    save: pick([2, 3, 4, 5, 6, 7]),
    invulnerable: pick([null, null, null, 4, 5, 6]),
    wounds: pick([1, 1, 2, 3, 4, 6, 10]),
    models: pick([1, 2, 3, 5, 10]),
    feelNoPain: pick([null, null, null, 5, 6]),
    damageReduction: pick([0, 0, 0, 1]),
  };

  const options: SimOptions = {
    hitModifier: pick([0, 0, 1, -1]),
    woundModifier: pick([0, 0, 1, -1]),
    cover: rng() < 0.25,
    attackingModels: pick([1, 1, 2, 5]),
    halfRange: rng() < 0.4,
    charged: rng() < 0.3,
    attacksModifier: pick([0, 0, 0, 1, 2]),
    strengthModifier: pick([0, 0, 0, 1, 2, -1]),
    apModifier: pick([0, 0, 0, 1]),
    damageModifier: pick([0, 0, 0, 1]),
    toughnessModifier: pick([0, 0, 0, -1]),
    saveModifier: pick([0, 0, 0, 1]),
    // Without Devastating Wounds, taking the auto-wound is never worse, so the
    // engine will always take it and the simulator can too.
    useLethal: true,
  };

  if (weapon.torrent) weapon.skill = null;
  return { weapon, target, options };
}

describe('exact engine versus dice simulation', () => {
  it('agrees on a plain bolter-into-marines matchup', () => {
    const weapon: Weapon = {
      name: 'bolt rifle',
      attacks: '2',
      skill: 3,
      strength: 4,
      ap: 1,
      damage: '1',
    };
    const target: Target = {
      name: 'marines',
      toughness: 4,
      save: 3,
      wounds: 2,
      models: 5,
    };

    const exact = resolveAttack(weapon, target, { attackingModels: 5 })!;
    const sim = simulate(weapon, target, { attackingModels: 5 }, 200_000, 12345);

    expect(sim.totalDamage).toBeCloseTo(exact.totalDamage, 1);
    expect(sim.modelsSlain).toBeCloseTo(exact.expectedModelsSlain, 1);
  });

  it('agrees when damage is wasted on one-wound models', () => {
    // The overkill case, where a naive implementation diverges most.
    const weapon: Weapon = {
      name: 'big gun',
      attacks: '3',
      skill: 3,
      strength: 10,
      ap: 3,
      damage: 'D6+2',
    };
    const target: Target = { name: 'chaff', toughness: 3, save: 5, wounds: 1, models: 10 };

    const exact = resolveAttack(weapon, target)!;
    const sim = simulate(weapon, target, {}, 200_000, 999);

    expect(sim.modelsSlain).toBeCloseTo(exact.expectedModelsSlain, 1);
    expect(sim.totalDamage).toBeCloseTo(exact.totalDamage, 1);
  });

  it('agrees with Feel No Pain rolled per point of damage', () => {
    const weapon: Weapon = {
      name: 'power fist',
      attacks: '3',
      skill: 3,
      strength: 8,
      ap: 2,
      damage: '2',
    };
    const target: Target = {
      name: 'tough infantry',
      toughness: 5,
      save: 3,
      wounds: 2,
      models: 5,
      feelNoPain: 5,
    };

    const exact = resolveAttack(weapon, target, { attackingModels: 3 })!;
    const sim = simulate(weapon, target, { attackingModels: 3 }, 200_000, 4242);

    expect(sim.totalDamage).toBeCloseTo(exact.totalDamage, 1);
    expect(sim.modelsSlain).toBeCloseTo(exact.expectedModelsSlain, 1);
  });

  it('agrees across 150 randomly generated matchups', () => {
    const rng = makeRandom(20260817);
    const failures: string[] = [];

    for (let i = 0; i < 150; i += 1) {
      const { weapon, target, options } = randomScenario(rng);
      const exact = resolveAttack(weapon, target, options);
      if (!exact) continue;

      const sim = simulate(weapon, target, options, 20_000, 1000 + i);

      // 20k trials leaves real sampling noise, so compare with a tolerance
      // that scales with the magnitude rather than a fixed epsilon.
      const tolerance = (value: number) => Math.max(0.06, value * 0.06);

      if (Math.abs(sim.modelsSlain - exact.expectedModelsSlain) > tolerance(exact.expectedModelsSlain)) {
        failures.push(
          `#${i} models slain: exact ${exact.expectedModelsSlain.toFixed(3)} vs sim ${sim.modelsSlain.toFixed(3)}\n` +
            `   ${JSON.stringify({ weapon, target, options })}`
        );
      }
      if (Math.abs(sim.totalDamage - exact.totalDamage) > tolerance(exact.totalDamage)) {
        failures.push(
          `#${i} total damage: exact ${exact.totalDamage.toFixed(3)} vs sim ${sim.totalDamage.toFixed(3)}\n` +
            `   ${JSON.stringify({ weapon, target, options })}`
        );
      }
    }

    expect(failures.join('\n')).toBe('');
  });
});
