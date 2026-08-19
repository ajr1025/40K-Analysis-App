/**
 * Defensive abilities and conditional weapon keywords.
 *
 * Everything here was found by auditing the dataset rather than by reading the
 * rulebook: each case is something the engine was getting wrong on real units,
 * silently, in a direction that flattered the attacker.
 */

import { describe, expect, it } from 'vitest';

import { meleeLoadout, readDefensiveAbilities, readKeywords, type DataUnit } from './adapt';
import { type Target, type Weapon, applyAnti, resolveAttack } from './resolve';

function unit(abilities: Array<{ name: string; text: string }>): DataUnit {
  return {
    id: 'x',
    name: 'test',
    legends: false,
    models: [],
    weapons: [],
    keywords: [],
    abilities,
    points: [],
    basePoints: null,
  };
}

const weapon = (o: Partial<Weapon> = {}): Weapon => ({
  name: 'w',
  attacks: '1',
  skill: 4,
  strength: 4,
  ap: 0,
  damage: '1',
  ...o,
});

const target = (o: Partial<Target> = {}): Target => ({
  name: 't',
  toughness: 4,
  save: 7,
  wounds: 1,
  models: 1,
  ...o,
});

const near = (actual: number, want: number) => expect(actual).toBeCloseTo(want, 9);

describe('Anti-X only fires against matching targets', () => {
  it('records the keyword rather than lowering the threshold outright', () => {
    const flags = readKeywords(['Anti-Vehicle 4+']);
    expect(flags.critWoundOn).toBe(6); // untouched
    expect(flags.anti).toEqual([{ keyword: 'Vehicle', critOn: 4 }]);
  });

  it('lowers the critical wound threshold against a matching target', () => {
    const w = weapon({ anti: [{ keyword: 'Vehicle', critOn: 4 }] });
    expect(applyAnti(w, target({ keywords: ['Vehicle'] })).critWoundOn).toBe(4);
  });

  it('leaves the threshold alone against a non-matching target', () => {
    const w = weapon({ anti: [{ keyword: 'Vehicle', critOn: 4 }] });
    expect(applyAnti(w, target({ keywords: ['Infantry'] })).critWoundOn ?? 6).toBe(6);
  });

  it('changes the damage only against the keyword it names', () => {
    // The bug this replaces: Anti-Vehicle used to fire into infantry too.
    const w = weapon({ anti: [{ keyword: 'Vehicle', critOn: 2 }], strength: 3, torrent: true, skill: null });
    const vsVehicle = resolveAttack(w, target({ toughness: 10, keywords: ['Vehicle'] }))!;
    const vsInfantry = resolveAttack(w, target({ toughness: 10, keywords: ['Infantry'] }))!;

    expect(vsVehicle.totalDamage).toBeGreaterThan(vsInfantry.totalDamage);
    // S3 vs T10 wounds only on a 6 without Anti.
    expect(vsInfantry.totalDamage).toBeCloseTo(1 / 6, 9);
    // With Anti-Vehicle 2+, everything except a natural 1 is a critical wound.
    expect(vsVehicle.totalDamage).toBeCloseTo(5 / 6, 9);
  });

  it('is case-insensitive about the keyword', () => {
    const w = weapon({ anti: [{ keyword: 'vehicle', critOn: 4 }] });
    expect(applyAnti(w, target({ keywords: ['VEHICLE'] })).critWoundOn).toBe(4);
  });
});

describe('defensive abilities read from rules text', () => {
  it('finds Feel No Pain', () => {
    const d = readDefensiveAbilities(
      unit([{ name: 'Disgustingly Resilient', text: 'Models in this unit have the Feel No Pain 5+ ability.' }])
    );
    expect(d.feelNoPain).toBe(5);
  });

  it('ignores a Feel No Pain that only applies to some attacks', () => {
    // A Psychic-only Feel No Pain must not make the unit look tougher against
    // everything -- the Librarian's Psychic Hood is exactly this case.
    const d = readDefensiveAbilities(
      unit([
        {
          name: 'Psychic Hood',
          text: 'Models in that unit have the Feel No Pain 4+ ability against Psychic Attacks.',
        },
      ])
    );
    expect(d.feelNoPain).toBeNull();
  });

  it('finds an invulnerable save described in prose', () => {
    const d = readDefensiveAbilities(
      unit([{ name: 'Storm Shield', text: 'This model has a 4+ invulnerable save.' }])
    );
    expect(d.invulnerable).toBe(4);
  });

  it('ignores an invulnerable save limited to melee', () => {
    const d = readDefensiveAbilities(
      unit([{ name: 'Parry', text: 'This model has a 4+ invulnerable save against melee attacks.' }])
    );
    expect(d.invulnerable).toBeNull();
  });

  it('finds flat damage reduction', () => {
    const d = readDefensiveAbilities(
      unit([
        {
          name: 'Necrodermis',
          text: 'Each time an attack is allocated to this model, subtract 1 from the Damage characteristic of that attack.',
        },
      ])
    );
    expect(d.damageReduction).toBe(1);
  });

  it('keeps the best of several Feel No Pain abilities', () => {
    const d = readDefensiveAbilities(
      unit([
        { name: 'A', text: 'has the Feel No Pain 6+ ability' },
        { name: 'B', text: 'has the Feel No Pain 4+ ability' },
      ])
    );
    expect(d.feelNoPain).toBe(4);
  });
});

describe('range- and target-dependent weapon keywords', () => {
  const auto = (o: Partial<Weapon> = {}) =>
    weapon({ torrent: true, skill: null, strength: 20, ...o });

  it('adds Blast attacks for every five models in the target', () => {
    // A 10-model unit grants +2 attacks; a 4-model unit grants none.
    const big = resolveAttack(auto({ blast: 1, attacks: '1' }), target({ models: 10, wounds: 1, toughness: 4 }))!;
    const small = resolveAttack(auto({ blast: 1, attacks: '1' }), target({ models: 4, wounds: 1, toughness: 4 }))!;

    near(big.totalDamage, 3 * (5 / 6)); // 1 base + 2 blast
    near(small.totalDamage, 1 * (5 / 6)); // rounds down to no bonus
  });

  it('needs no toggle for Blast, since the target size is already known', () => {
    const withBlast = resolveAttack(auto({ blast: 1, attacks: '2' }), target({ models: 10, wounds: 1, toughness: 4 }))!;
    const without = resolveAttack(auto({ attacks: '2' }), target({ models: 10, wounds: 1, toughness: 4 }))!;
    expect(withBlast.totalDamage).toBeGreaterThan(without.totalDamage);
  });

  it('adds Rapid Fire attacks only within half range', () => {
    const w = auto({ rapidFire: 2, attacks: '1' });
    const t = target({ models: 10, wounds: 1, toughness: 4 });

    near(resolveAttack(w, t, { halfRange: true })!.totalDamage, 3 * (5 / 6));
    near(resolveAttack(w, t, { halfRange: false })!.totalDamage, 1 * (5 / 6));
  });

  it('adds Melta damage only within half range', () => {
    const w = auto({ melta: 2, attacks: '1', damage: '2' });
    const t = target({ models: 5, wounds: 10, toughness: 4 });

    near(resolveAttack(w, t, { halfRange: true })!.totalDamage, (5 / 6) * 4);
    near(resolveAttack(w, t, { halfRange: false })!.totalDamage, (5 / 6) * 2);
  });

  it('applies the Lance wound bonus only on a charge', () => {
    // S4 into T5 wounds on 5+; Lance on the charge improves that to 4+.
    const w = auto({ lance: true, strength: 4, attacks: '1' });
    const t = target({ toughness: 5, models: 5, wounds: 1 });

    near(resolveAttack(w, t, { charged: false })!.totalDamage, 2 / 6);
    near(resolveAttack(w, t, { charged: true })!.totalDamage, 3 / 6);
  });

  it('keeps Lance inside the +/-1 modifier cap', () => {
    // Lance stacks with an existing +1, but the total is still capped at +1.
    const w = auto({ lance: true, strength: 4, attacks: '1' });
    const t = target({ toughness: 5, models: 5, wounds: 1 });

    const lanceOnly = resolveAttack(w, t, { charged: true })!;
    const lancePlusBuff = resolveAttack(w, t, { charged: true, woundModifier: 1 })!;
    near(lancePlusBuff.totalDamage, lanceOnly.totalDamage);
  });
});

describe('Benefit of Cover worsens Ballistic Skill', () => {
  it('worsens the BS characteristic rather than improving the save', () => {
    // BS3+ into cover becomes BS4+: hits drop from 4/6 to 3/6. The save is
    // untouched, which is the 11th edition change from 10th.
    const w = weapon({ skill: 3, attacks: '1', strength: 8 });
    const t = target({ toughness: 4, save: 7, models: 5 });

    near(resolveAttack(w, t, { cover: false })!.totalDamage, (4 / 6) * (5 / 6));
    near(resolveAttack(w, t, { cover: true })!.totalDamage, (3 / 6) * (5 / 6));
  });

  it('stacks with a -1 to hit for an effective -2', () => {
    // The case that matters: a Keeper of Secrets has Mesmerising Form (-1 to
    // the hit roll) and can also have the Benefit of Cover. The roll modifier
    // is capped at -1, but cover worsens the characteristic separately, so a
    // BS3+ attack ends up needing a 5+.
    const w = weapon({ skill: 3, attacks: '1', strength: 8 });
    const t = target({ toughness: 4, save: 7, models: 5 });

    const plain = resolveAttack(w, t, {})!;
    const minusOne = resolveAttack(w, t, { hitModifier: -1 })!;
    const both = resolveAttack(w, t, { hitModifier: -1, cover: true })!;

    near(plain.totalDamage, (4 / 6) * (5 / 6)); // 3+
    near(minusOne.totalDamage, (3 / 6) * (5 / 6)); // effectively 4+
    near(both.totalDamage, (2 / 6) * (5 / 6)); // effectively 5+
    expect(both.totalDamage).toBeLessThan(minusOne.totalDamage);
  });

  it('does not let a stacked penalty stop a natural 6 hitting', () => {
    // Cover plus -1 against BS6+ cannot take hits below the natural 6.
    const w = weapon({ skill: 6, attacks: '1', strength: 8 });
    const t = target({ toughness: 4, save: 7, models: 5 });
    near(resolveAttack(w, t, { hitModifier: -1, cover: true })!.totalDamage, (1 / 6) * (5 / 6));
  });

  it('leaves melee attacks alone', () => {
    // The Benefit of Cover applies to ranged attacks only.
    const w = weapon({ skill: 3, attacks: '1', strength: 8, melee: true });
    const t = target({ toughness: 4, save: 7, models: 5 });
    near(
      resolveAttack(w, t, { cover: true })!.totalDamage,
      resolveAttack(w, t, { cover: false })!.totalDamage
    );
  });

  it('leaves Torrent weapons alone', () => {
    // Torrent hits automatically, so there is no Ballistic Skill to worsen.
    const w = weapon({ torrent: true, skill: null, attacks: '1', strength: 8 });
    const t = target({ toughness: 4, save: 7, models: 5 });
    near(
      resolveAttack(w, t, { cover: true })!.totalDamage,
      resolveAttack(w, t, { cover: false })!.totalDamage
    );
  });

  it('helps an invulnerable-save target, unlike the old save bonus', () => {
    // Against a 4++ facing AP-4, a save bonus was worthless. Worsening BS
    // still helps, which is the point of the change.
    const w = weapon({ skill: 3, ap: 4, attacks: '1', strength: 8 });
    const t = target({ toughness: 4, save: 3, invulnerable: 4, models: 5 });
    expect(resolveAttack(w, t, { cover: true })!.totalDamage).toBeLessThan(
      resolveAttack(w, t, { cover: false })!.totalDamage
    );
  });
});

describe('Extra Attacks weapons swing alongside the chosen one', () => {
  const meleeWeapon = (name: string, attacks: string, keywords: string[] = []) => ({
    name,
    kind: 'melee' as const,
    mode: false,
    range: 'Melee',
    attacks,
    skill: '3+',
    strength: '6',
    ap: '-1',
    damage: '2',
    keywords,
  });

  const withWeapons = (weapons: ReturnType<typeof meleeWeapon>[]): DataUnit => ({
    id: 'x',
    name: 'test',
    legends: false,
    models: [],
    weapons,
    keywords: [],
    abilities: [],
    points: [],
    basePoints: null,
  });

  it('adds every Extra Attacks weapon to the chosen one', () => {
    // The Twin Lance pattern: one ordinary weapon plus two Extra Attacks ones.
    const unit = withWeapons([
      meleeWeapon('XV pulse pistol', '4'),
      meleeWeapon('Fusion eliminator', '1', ['Extra Attacks']),
      meleeWeapon('Ion scattercannon', '3', ['Extra Attacks']),
    ]);

    const loadout = meleeLoadout(unit).map((w) => w.name);
    expect(loadout).toEqual(['XV pulse pistol', 'Fusion eliminator', 'Ion scattercannon']);
  });

  it('picks only one ordinary weapon', () => {
    // Two ordinary weapons are alternatives, so only one may be used.
    const unit = withWeapons([
      meleeWeapon('Chainsword', '5'),
      meleeWeapon('Power fist', '3'),
      meleeWeapon('Hazardous spike', '1', ['Extra Attacks']),
    ]);

    const loadout = meleeLoadout(unit).map((w) => w.name);
    expect(loadout).toHaveLength(2);
    expect(loadout).toContain('Hazardous spike');
    // Defaults to the higher-volume option when none is named.
    expect(loadout).toContain('Chainsword');
  });

  it('honours an explicitly chosen weapon', () => {
    const unit = withWeapons([
      meleeWeapon('Chainsword', '5'),
      meleeWeapon('Power fist', '3'),
      meleeWeapon('Spike', '1', ['Extra Attacks']),
    ]);
    expect(meleeLoadout(unit, 'Power fist').map((w) => w.name)).toEqual(['Power fist', 'Spike']);
  });

  it('works when a unit has only Extra Attacks weapons', () => {
    const unit = withWeapons([meleeWeapon('Spike', '1', ['Extra Attacks'])]);
    expect(meleeLoadout(unit).map((w) => w.name)).toEqual(['Spike']);
  });
});

describe('weapons that roll for Strength', () => {
  it('averages the wound roll over the Strength distribution', () => {
    // An Ork Zzap gun is 2D6 Strength. Against T7 it wounds on anything from
    // 6+ (S2-3) to 2+ (S14), so the result is a blend, not a single threshold.
    const zzap = weapon({ strength: '2D6', torrent: true, skill: null, attacks: '1' });
    const result = resolveAttack(zzap, target({ toughness: 7, models: 5, wounds: 1 }))!;

    // Strictly between the best and worst single-Strength outcomes.
    const worst = resolveAttack(
      weapon({ strength: 2, torrent: true, skill: null, attacks: '1' }),
      target({ toughness: 7, models: 5, wounds: 1 })
    )!;
    const best = resolveAttack(
      weapon({ strength: 14, torrent: true, skill: null, attacks: '1' }),
      target({ toughness: 7, models: 5, wounds: 1 })
    )!;

    expect(result.totalDamage).toBeGreaterThan(worst.totalDamage);
    expect(result.totalDamage).toBeLessThan(best.totalDamage);
  });

  it('matches a fixed Strength when the expression is not random', () => {
    const rolled = resolveAttack(
      weapon({ strength: '8', torrent: true, skill: null }),
      target({ toughness: 4, models: 5 })
    )!;
    const fixed = resolveAttack(
      weapon({ strength: 8, torrent: true, skill: null }),
      target({ toughness: 4, models: 5 })
    )!;
    near(rolled.totalDamage, fixed.totalDamage);
  });
});

describe('damage reduction in the maths', () => {
  it('blunts a big-damage weapon much more than volume fire', () => {
    // The point of Necrodermis: -1 off a D2 weapon halves it, while -1 off a
    // D6 weapon costs proportionally far less.
    const tough = target({ toughness: 11, save: 3, wounds: 16, models: 1, damageReduction: 1 });
    const plain = { ...tough, damageReduction: 0 };

    const smallHits = weapon({ damage: '2', attacks: '6', torrent: true, skill: null, strength: 12 });
    const bigHits = weapon({ damage: '6', attacks: '2', torrent: true, skill: null, strength: 12 });

    const smallLoss =
      1 - resolveAttack(smallHits, tough)!.totalDamage / resolveAttack(smallHits, plain)!.totalDamage;
    const bigLoss =
      1 - resolveAttack(bigHits, tough)!.totalDamage / resolveAttack(bigHits, plain)!.totalDamage;

    expect(smallLoss).toBeGreaterThan(bigLoss);
  });

  it('never reduces an attack below 1 damage', () => {
    const t = target({ toughness: 4, wounds: 10, models: 1, damageReduction: 3 });
    const w = weapon({ damage: '1', attacks: '6', torrent: true, skill: null, strength: 8 });
    // Six auto-hits wounding on 2+, each still doing 1 damage despite -3.
    expect(resolveAttack(w, t)!.totalDamage).toBeCloseTo(6 * (5 / 6), 9);
  });

  it('applies before Feel No Pain rather than after', () => {
    // 2 damage, -1 reduction, then FNP 4+ on the single remaining point.
    const t = target({ toughness: 4, wounds: 10, models: 1, damageReduction: 1, feelNoPain: 4 });
    const w = weapon({ damage: '2', attacks: '1', torrent: true, skill: null, strength: 8 });
    expect(resolveAttack(w, t)!.totalDamage).toBeCloseTo((5 / 6) * 1 * 0.5, 9);
  });
});
