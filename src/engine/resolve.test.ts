import { describe, expect, it } from 'vitest';

import { expected, parseDice } from './dice';
import { capModifier, roll, saveFailChance, woundTarget } from './rolls';
import {
  type Target,
  type Weapon,
  pointsDestroyed,
  pointsEfficiency,
  resolveAttack,
} from './resolve';

/** A weapon that only varies in the ways a given test cares about. */
function weapon(overrides: Partial<Weapon> = {}): Weapon {
  return {
    name: 'test weapon',
    attacks: '1',
    skill: 4,
    strength: 4,
    ap: 0,
    damage: '1',
    ...overrides,
  };
}

/** A single one-wound model with no save, so probabilities stay legible. */
function target(overrides: Partial<Target> = {}): Target {
  return {
    name: 'test target',
    toughness: 4,
    save: 7, // unsaveable
    wounds: 1,
    models: 1,
    ...overrides,
  };
}

const near = (actual: number, want: number) => expect(actual).toBeCloseTo(want, 9);

describe('dice parsing', () => {
  it('reads flat and dice characteristics', () => {
    near(expected(parseDice('4')!), 4);
    near(expected(parseDice('D6')!), 3.5);
    near(expected(parseDice('D3')!), 2);
    near(expected(parseDice('2D6')!), 7);
    near(expected(parseDice('D6+2')!), 5.5);
  });

  it('returns null for characteristics it cannot model', () => {
    // Datasheets use these for profile-dependent values; scoring them as zero
    // would quietly understate a weapon instead of flagging it.
    expect(parseDice('*')).toBeNull();
    expect(parseDice('N/A')).toBeNull();
    expect(parseDice('-')).toBeNull();
    expect(parseDice(null)).toBeNull();
  });
});

describe('roll mechanics', () => {
  it('treats a natural 1 as a failure regardless of modifiers', () => {
    // 2+ with +1 would arithmetically succeed on every face, but a 1 never does.
    near(roll({ target: 2, modifier: 1 }).pass, 5 / 6);
  });

  it('treats a natural 6 as a critical that always passes', () => {
    // Needing 7+ is impossible, yet a 6 still lands.
    near(roll({ target: 6, modifier: -1 }).pass, 1 / 6);
    near(roll({ target: 6, modifier: -1 }).crit, 1 / 6);
  });

  it('caps net modifiers at +/-1', () => {
    expect(capModifier(3)).toBe(1);
    expect(capModifier(-3)).toBe(-1);
    near(roll({ target: 4, modifier: 3 }).pass, roll({ target: 4, modifier: 1 }).pass);
  });

  it('splits criticals out of the pass probability', () => {
    const r = roll({ target: 4 });
    near(r.crit, 1 / 6); // only a natural 6
    near(r.normal, 2 / 6); // 4 and 5
    near(r.pass, 3 / 6);
  });

  it('lowers the critical threshold for Anti- style abilities', () => {
    const r = roll({ target: 4, critOn: 5 });
    near(r.crit, 2 / 6); // 5 and 6
    near(r.normal, 1 / 6); // only 4
  });

  it('rerolls ones and failures correctly', () => {
    // Reroll 1s: 1/6 of the mass is rolled again at the same 1/2 pass rate.
    near(roll({ target: 4, reroll: 'ones' }).pass, 1 / 2 + (1 / 6) * (1 / 2));
    // Reroll failures: the whole failing half is rolled again.
    near(roll({ target: 4, reroll: 'failures' }).pass, 1 / 2 + (1 / 2) * (1 / 2));
  });

  it('uses the 11th edition strength versus toughness table', () => {
    expect(woundTarget(8, 4)).toBe(2); // double or more
    expect(woundTarget(5, 4)).toBe(3); // greater
    expect(woundTarget(4, 4)).toBe(4); // equal
    expect(woundTarget(3, 4)).toBe(5); // less
    expect(woundTarget(2, 4)).toBe(6); // half or less
  });
});

describe('saving throws', () => {
  it('applies armour penetration', () => {
    near(saveFailChance({ armour: 3, ap: 0 }), 2 / 6); // saves on 3,4,5,6
    near(saveFailChance({ armour: 3, ap: 1 }), 3 / 6); // now needs 4+
    near(saveFailChance({ armour: 3, ap: 4 }), 1); // pushed off the table
  });

  it('falls back to the invulnerable save once AP overtakes armour', () => {
    // A 4++ is unaffected by AP, so a heavily-penetrating hit still faces it.
    near(saveFailChance({ armour: 3, invulnerable: 4, ap: 4 }), 3 / 6);
  });

  it('does not involve cover at all', () => {
    // In 11th edition the Benefit of Cover worsens the attacker's Ballistic
    // Skill instead of improving this save, so nothing here should change.
    near(saveFailChance({ armour: 4, ap: 0 }), 3 / 6);
    near(saveFailChance({ armour: 7, invulnerable: 5, ap: 0 }), 4 / 6);
  });
});

describe('the attack sequence', () => {
  it('multiplies the three rolls for the simplest case', () => {
    // BS4+ (1/2) x S4 vs T4 (1/2) x no save (1) x 1 damage.
    const result = resolveAttack(weapon(), target())!;
    near(result.totalDamage, 0.25);
    near(result.expectedModelsSlain, 0.25);
  });

  it('accounts for the save', () => {
    // ... x 3+ save failing 1/3 of the time.
    const result = resolveAttack(weapon(), target({ save: 3 }))!;
    near(result.totalDamage, 0.5 * 0.5 * (1 / 3));
  });

  it('scales with the number of attacking models', () => {
    const result = resolveAttack(weapon({ attacks: '2' }), target({ models: 10, wounds: 1 }), {
      attackingModels: 5,
    })!;
    // 10 attacks x 1/2 x 1/2 = 2.5 unsaved wounds into 1-wound models.
    near(result.totalDamage, 2.5);
    near(result.expectedModelsSlain, 2.5);
  });

  it('auto-hits with Torrent', () => {
    const result = resolveAttack(weapon({ torrent: true, skill: null }), target())!;
    near(result.totalDamage, 0.5); // hit step removed entirely
  });
});

describe('critical hit abilities', () => {
  it('generates extra hits with Sustained Hits', () => {
    // BS4+: normal hit 2/6 -> 1 hit, crit 1/6 -> 2 hits. 4/6 hits, each
    // wounding on 4+ against a saveless target. The squad is deliberately
    // large so no sustained hit is wasted on an already-dead model.
    const result = resolveAttack(weapon({ sustainedHits: 1 }), target({ models: 10 }))!;
    near(result.totalDamage, (4 / 6) * 0.5);
  });

  it('keeps throwing damage past what a destroyed unit can absorb', () => {
    // The Sustained Hits mechanic is unconditional -- the extra hits are
    // generated and roll to wound as normal, whatever the target is. Against a
    // lone one-wound model the unit runs out of things to lose, so the wounds
    // actually removed saturate at the chance of landing *any* hit, while the
    // damage thrown keeps counting. The gap between the two is the overkill.
    const result = resolveAttack(weapon({ sustainedHits: 1 }), target({ models: 1 }))!;
    const pNoLanding = 3 / 6 + (2 / 6) * 0.5 + (1 / 6) * 0.5 ** 2;

    near(result.woundsRemoved, 1 - pNoLanding);
    near(result.totalDamage, (4 / 6) * 0.5);
    expect(result.totalDamage).toBeGreaterThan(result.woundsRemoved);
  });

  it('skips the wound roll with Lethal Hits', () => {
    // Crit hits (1/6) wound automatically; normal hits (2/6) still roll 4+.
    const result = resolveAttack(weapon({ lethalHits: true }), target())!;
    near(result.totalDamage, 1 / 6 + (2 / 6) * 0.5);
  });

  it('turns critical wounds into unsaveable mortal wounds with Devastating Wounds', () => {
    // Against a 2+ save, the 1/6 critical wounds bypass it entirely while
    // ordinary wounds almost always get saved.
    const result = resolveAttack(
      weapon({ devastatingWounds: true }),
      target({ save: 2, models: 10 })
    )!;
    const pHit = 0.5;
    const pCritWound = 1 / 6;
    const pNormalWound = 0.5 - pCritWound;
    const pFailSave = 1 / 6; // a 2+ save fails only on a natural 1
    near(result.totalDamage, pHit * (pCritWound + pNormalWound * pFailSave));
  });

  it('does not spill a Devastating Wound across models', () => {
    // A 2-damage devastating hit into one-wound models kills one model and
    // wastes the second point. Skipping the save makes it land more often, not
    // spread further -- so against a saveless target it is worth nothing extra.
    const devastating = resolveAttack(
      weapon({
        damage: '2',
        torrent: true,
        skill: null,
        strength: 10,
        devastatingWounds: true,
        critWoundOn: 2,
      }),
      target({ toughness: 5, wounds: 1, models: 10, save: 7 })
    )!;
    const plain = resolveAttack(
      weapon({ damage: '2', torrent: true, skill: null, strength: 10 }),
      target({ toughness: 5, wounds: 1, models: 10, save: 7 })
    )!;

    // Every wound is critical and unsaveable, but each still kills exactly one
    // one-wound model -- never two.
    near(devastating.expectedModelsSlain, 5 / 6);
    near(plain.expectedModelsSlain, 5 / 6);
  });

  it('lets Devastating Wounds bypass a save that would otherwise hold', () => {
    // The benefit is ignoring the save, so it shows up against a 2+ armour and
    // a 4++ invulnerable -- not as extra spread.
    const devastating = resolveAttack(
      weapon({ devastatingWounds: true, critWoundOn: 2, torrent: true, skill: null, strength: 10 }),
      target({ toughness: 5, save: 2, invulnerable: 4, models: 10 })
    )!;
    const plain = resolveAttack(
      weapon({ critWoundOn: 2, torrent: true, skill: null, strength: 10 }),
      target({ toughness: 5, save: 2, invulnerable: 4, models: 10 })
    )!;

    near(devastating.totalDamage, 5 / 6); // every wound lands, unsaveable
    expect(devastating.totalDamage).toBeGreaterThan(plain.totalDamage);
  });

  it('prefers Devastating Wounds over Lethal Hits when it throws more damage', () => {
    // With a 2+ save, auto-wounding into a save that almost always holds is
    // worse than fishing for the save-bypassing critical wound.
    const both = resolveAttack(
      weapon({ lethalHits: true, devastatingWounds: true }),
      target({ save: 2, models: 10 })
    )!;
    const devOnly = resolveAttack(
      weapon({ devastatingWounds: true }),
      target({ save: 2, models: 10 })
    )!;
    near(both.totalDamage, devOnly.totalDamage);
  });

  it('still applies Feel No Pain to mortal wounds', () => {
    // Mortal wounds ignore armour and invulnerable saves but not Feel No Pain.
    const withFnp = resolveAttack(
      weapon({ devastatingWounds: true, critWoundOn: 2, torrent: true, skill: null, strength: 10 }),
      target({ toughness: 5, save: 2, invulnerable: 4, models: 10, feelNoPain: 5 })
    )!;
    const withoutFnp = resolveAttack(
      weapon({ devastatingWounds: true, critWoundOn: 2, torrent: true, skill: null, strength: 10 }),
      target({ toughness: 5, save: 2, invulnerable: 4, models: 10 })
    )!;
    near(withFnp.totalDamage, withoutFnp.totalDamage * (2 / 3));
  });
});

describe('feel no pain', () => {
  it('discards wounds before they are lost', () => {
    // FNP 5+ stops 1/3 of wounds, so 2/3 of each point of damage sticks.
    const result = resolveAttack(weapon(), target({ feelNoPain: 5 }))!;
    near(result.totalDamage, 0.25 * (2 / 3));
  });

  it('rolls per wound rather than per attack', () => {
    // 2 damage against FNP 4+ (half stick) averages 1 wound lost, not a
    // coin flip on the whole packet.
    const result = resolveAttack(
      weapon({ damage: '2', torrent: true, skill: null, strength: 100 }),
      target({ feelNoPain: 4, wounds: 10, models: 1 })
    )!;
    // Auto-hit, wounds on 2+ (5/6), then 2 damage x 1/2 kept.
    near(result.totalDamage, (5 / 6) * 1);
  });

  it('lets a Feel No Pain model survive a hit that should have killed it', () => {
    // A 2-wound model with FNP 6+ taking 2 damage: each point is rolled for
    // separately, so a single 6 leaves the model alive on one wound. It
    // therefore soaks more failed saves than its wound count implies.
    const withFnp = resolveAttack(
      weapon({ damage: '2', torrent: true, skill: null, strength: 100 }),
      target({ wounds: 2, models: 1, feelNoPain: 6 })
    )!;
    const withoutFnp = resolveAttack(
      weapon({ damage: '2', torrent: true, skill: null, strength: 100 }),
      target({ wounds: 2, models: 1 })
    )!;
    // Without FNP the model dies whenever the attack wounds (5/6). With FNP
    // 6+ it survives whenever either point of damage is ignored.
    near(withoutFnp.expectedModelsSlain, 5 / 6);
    near(withFnp.expectedModelsSlain, (5 / 6) * (5 / 6) ** 2);
    expect(withFnp.expectedModelsSlain).toBeLessThan(withoutFnp.expectedModelsSlain);
  });
});

describe('overkill', () => {
  it('wastes excess damage instead of spilling it to the next model', () => {
    // One 6-damage hit into five 1-wound models kills exactly one model.
    // Dividing total damage by wounds-per-model would claim five.
    const result = resolveAttack(
      weapon({ damage: '6', torrent: true, skill: null, strength: 10 }),
      target({ toughness: 5, wounds: 1, models: 5 })
    )!;
    near(result.expectedModelsSlain, 5 / 6); // just the wound roll
    expect(result.expectedModelsSlain).toBeLessThan(1);
  });

  it('caps wounds removed at the unit but lets total damage run past it', () => {
    // 20 shots of 6 damage into two one-wound models. The unit can only lose
    // two wounds, but the attack throws vastly more than that -- and seeing
    // the gap is the point: it says "massively overkill", not "exactly lethal".
    const result = resolveAttack(
      weapon({ attacks: '20', damage: '6', torrent: true, skill: null, strength: 20 }),
      target({ toughness: 4, wounds: 1, models: 2 })
    )!;
    expect(result.woundsRemoved).toBeLessThanOrEqual(2);
    expect(result.expectedModelsSlain).toBeLessThanOrEqual(2);
    expect(result.totalDamage).toBeGreaterThan(50);
    expect(result.overkillRatio).toBeGreaterThan(25);
    expect(result.probabilityDestroyed).toBeGreaterThan(0.99);
  });

  it('counts wasted overkill as wasted in the wounds-removed figure', () => {
    // One 6-damage hit into a 1-wound model removes one wound, not six --
    // while total damage still reports the full six it threw.
    const result = resolveAttack(
      weapon({ damage: '6', torrent: true, skill: null, strength: 10 }),
      target({ toughness: 5, wounds: 1, models: 5 })
    )!;
    near(result.woundsRemoved, 5 / 6);
    near(result.totalDamage, (5 / 6) * 6);
  });

  it('reports a confidence level for wiping the unit', () => {
    // Enough shots to be near-certain against a small squad, and clearly not
    // certain against a big one.
    const smallSquad = resolveAttack(
      weapon({ attacks: '10', torrent: true, skill: null, strength: 10 }),
      target({ toughness: 4, wounds: 1, models: 2, save: 7 })
    )!;
    const bigSquad = resolveAttack(
      weapon({ attacks: '10', torrent: true, skill: null, strength: 10 }),
      target({ toughness: 4, wounds: 1, models: 20, save: 7 })
    )!;
    expect(smallSquad.probabilityDestroyed).toBeGreaterThan(0.9);
    expect(bigSquad.probabilityDestroyed).toBeLessThan(0.01);
  });

  it('reports partial progress against a single tough model', () => {
    // Chipping a 10-wound vehicle kills nothing, but it is not zero progress.
    // Scoring by models slain alone would hide the damage entirely.
    const result = resolveAttack(
      weapon({ attacks: '4', damage: '2', torrent: true, skill: null, strength: 9 }),
      target({ toughness: 9, save: 3, wounds: 10, models: 1 })
    )!;
    expect(result.expectedModelsSlain).toBeLessThan(0.05);
    expect(result.fractionDestroyed).toBeGreaterThan(0.05);
    expect(result.fractionModelsSlain).toBeLessThan(result.fractionDestroyed);
  });

  it('rewards matching damage to the target profile', () => {
    // Against 2-wound models, D2 damage is fully used while D1 is not enough
    // to kill outright -- the engine should rank them accordingly.
    const twoDamage = resolveAttack(
      weapon({ attacks: '4', damage: '2', torrent: true, skill: null, strength: 8 }),
      target({ toughness: 4, wounds: 2, models: 5 })
    )!;
    const oneDamage = resolveAttack(
      weapon({ attacks: '4', damage: '1', torrent: true, skill: null, strength: 8 }),
      target({ toughness: 4, wounds: 2, models: 5 })
    )!;
    expect(twoDamage.expectedModelsSlain).toBeGreaterThan(oneDamage.expectedModelsSlain);
  });
});

describe('points-trade efficiency', () => {
  it('scores wiping a unit as the ratio of its points to yours', () => {
    // Wipe a 100-point unit with a 90-point unit: 100/90 = 1.11.
    const wipe = resolveAttack(
      weapon({ attacks: '20', torrent: true, skill: null, strength: 20 }),
      target({ toughness: 4, wounds: 1, models: 5, save: 7 })
    )!;
    const defender = target({ toughness: 4, wounds: 1, models: 5, save: 7 });

    // Twenty auto-hitting, auto-wounding shots into five one-wound models.
    // Convolving that many attacks accumulates a little float drift, hence the
    // looser tolerance here than elsewhere.
    expect(wipe.expectedModelsSlain).toBeCloseTo(5, 8);
    expect(pointsEfficiency(wipe, defender, 100, 90)).toBeCloseTo(100 / 90, 6);
  });

  it('scales linearly with the share of the unit killed', () => {
    // Killing half a 100-point unit with a 100-point unit is a 50% trade.
    const defender = target({ toughness: 4, wounds: 1, models: 10, save: 7 });
    const half = resolveAttack(
      weapon({ attacks: '10', torrent: true, skill: null, strength: 4 }),
      defender
    )!;
    near(half.expectedModelsSlain, 5); // 10 auto-hits wounding on 4+
    expect(pointsEfficiency(half, defender, 100, 100)).toBeCloseTo(0.5, 6);
  });

  it('values a chance to kill a single-model unit in expectation', () => {
    // A 30% chance of killing a 200-point vehicle is worth 60 points.
    const vehicle = target({ toughness: 9, wounds: 1, models: 1, save: 7 });
    const result = resolveAttack(
      weapon({ attacks: '1', torrent: true, skill: null, strength: 4 }),
      vehicle
    )!;
    // S4 is half or less of T9, so it wounds on 6+ -- a 1/6 chance to kill it.
    near(result.expectedModelsSlain, 1 / 6);
    expect(pointsDestroyed(result, vehicle, 200)).toBeCloseTo(200 / 6, 6);
  });

  it('rewards killing an expensive target over a cheap one', () => {
    const cheap = target({ toughness: 4, wounds: 1, models: 5, save: 7 });
    const result = resolveAttack(
      weapon({ attacks: '20', torrent: true, skill: null, strength: 20 }),
      cheap
    )!;
    expect(pointsEfficiency(result, cheap, 200, 100)).toBeGreaterThan(
      pointsEfficiency(result, cheap, 60, 100)
    );
  });
});

describe('unmodellable profiles', () => {
  it('returns null rather than scoring a "*" characteristic as zero', () => {
    expect(resolveAttack(weapon({ damage: '*' }), target())).toBeNull();
    expect(resolveAttack(weapon({ attacks: 'N/A' }), target())).toBeNull();
  });
});
