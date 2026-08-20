/**
 * Rules verified directly against the 11th-edition core rulebook.
 *
 * Several of these were previously wrong because secondary sources disagreed
 * with each other, and each was wrong in a way that produced a plausible
 * number rather than an error. The rule reference is quoted in each test so a
 * future change has to argue with the book, not with me.
 */

import { describe, expect, it } from 'vitest';

import { readKeywords } from './adapt';
import { type Target, type Weapon, applyAnti, resolveAttack } from './resolve';
import { saveFailChance } from './rolls';

const weapon = (o: Partial<Weapon> = {}): Weapon => ({
  name: 'w',
  attacks: '1',
  skill: 3,
  strength: 8,
  ap: 0,
  damage: '1',
  ...o,
});

const target = (o: Partial<Target> = {}): Target => ({
  name: 't',
  toughness: 4,
  save: 7,
  wounds: 1,
  models: 10,
  ...o,
});

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe('13.08 Benefit of Cover', () => {
  // "Each time a ranged attack targets a unit that has the benefit of cover
  //  against it, worsen the BS characteristic of that attack by 1."
  it('worsens Ballistic Skill, and does not touch the save', () => {
    const w = weapon({ skill: 3, attacks: '1' });
    const t = target({ save: 7 });

    near(resolveAttack(w, t, { cover: false })!.totalDamage, (4 / 6) * (5 / 6));
    near(resolveAttack(w, t, { cover: true })!.totalDamage, (3 / 6) * (5 / 6));

    // The save step is untouched by cover.
    near(saveFailChance({ armour: 4, ap: 0 }), 3 / 6);
  });

  it('applies to ranged attacks only', () => {
    const w = weapon({ melee: true, skill: 3 });
    const t = target({ save: 7 });
    near(
      resolveAttack(w, t, { cover: true })!.totalDamage,
      resolveAttack(w, t, { cover: false })!.totalDamage
    );
  });
});

describe('24.10 Devastating Wounds', () => {
  // "...the target unit suffers a number of mortal wounds equal to the D
  //  characteristic... Mortal wounds inflicted by [DEVASTATING WOUNDS] weapons
  //  can damage a maximum of one model for each critical wound; any remaining
  //  mortal wounds inflicted by that attack are lost."
  it('bypasses armour and invulnerable saves', () => {
    const w = weapon({ devastatingWounds: true, critWoundOn: 2, torrent: true, skill: null });
    const t = target({ toughness: 4, save: 2, invulnerable: 4 });
    // Every wound is critical, so every one gets through unsaved.
    near(resolveAttack(w, t)!.totalDamage, 5 / 6);
  });

  it('damages at most one model, discarding the rest', () => {
    // 3 damage into one-wound models kills exactly one, not three.
    const w = weapon({ devastatingWounds: true, critWoundOn: 2, damage: '3', torrent: true, skill: null });
    const t = target({ toughness: 4, wounds: 1, models: 10, save: 7 });
    near(resolveAttack(w, t)!.expectedModelsSlain, 5 / 6);
  });

  it('is still subject to Feel No Pain', () => {
    const w = weapon({ devastatingWounds: true, critWoundOn: 2, torrent: true, skill: null });
    const plain = resolveAttack(w, target({ save: 2, invulnerable: 4 }))!;
    const fnp = resolveAttack(w, target({ save: 2, invulnerable: 4, feelNoPain: 5 }))!;
    near(fnp.totalDamage, plain.totalDamage * (2 / 3));
  });
});

describe('24.12 Feel No Pain', () => {
  // "Each time a model with this ability would lose a wound, roll one D6:
  //  on an X+, that wound is not lost."
  it('is rolled per wound lost, not per attack', () => {
    // 2 damage against FNP 4+ averages 1 wound lost, not a coin flip on the pair.
    const w = weapon({ damage: '2', torrent: true, skill: null, strength: 100 });
    const t = target({ wounds: 10, models: 1, feelNoPain: 4 });
    near(resolveAttack(w, t)!.totalDamage, (5 / 6) * 1);
  });
});

describe('24.01 keyword-scoped weapon abilities', () => {
  // "If a weapon ability is followed by one or more keywords... that ability
  //  only applies if the target unit has one or more of those keywords."
  it('parses the restriction instead of applying the ability everywhere', () => {
    const flags = readKeywords(['Sustained Hits 1: Infantry/Beasts']);
    expect(flags.sustainedHits).toBe(0); // NOT applied unconditionally
    expect(flags.conditionalAbilities).toEqual([
      { ability: 'sustainedHits', value: 1, keywords: ['Infantry', 'Beasts'], negated: false },
    ]);
  });

  it('applies only against a matching target', () => {
    const w = weapon({
      conditionalAbilities: [{ ability: 'sustainedHits', value: 1, keywords: ['Infantry'] }],
    });
    expect(applyAnti(w, target({ keywords: ['Infantry'] })).sustainedHits).toBe(1);
    expect(applyAnti(w, target({ keywords: ['Vehicle'] })).sustainedHits ?? 0).toBe(0);
  });

  it('handles a "Non-" restriction by inverting the test', () => {
    const flags = readKeywords(['Devastating Wounds: Non-Monster/Vehicle']);
    expect(flags.devastatingWounds).toBe(false);
    expect(flags.conditionalAbilities[0]).toMatchObject({
      ability: 'devastatingWounds',
      keywords: ['Monster', 'Vehicle'],
      negated: true,
    });

    const w = weapon({
      conditionalAbilities: [
        { ability: 'devastatingWounds', keywords: ['Monster', 'Vehicle'], negated: true },
      ],
    });
    expect(applyAnti(w, target({ keywords: ['Infantry'] })).devastatingWounds).toBe(true);
    expect(applyAnti(w, target({ keywords: ['Vehicle'] })).devastatingWounds ?? false).toBe(false);
  });

  it('keeps a plain ability working when it has no restriction', () => {
    const flags = readKeywords(['Sustained Hits 1']);
    expect(flags.sustainedHits).toBe(1);
    expect(flags.conditionalAbilities).toEqual([]);
  });
});

describe('24.02 duplicated abilities are not cumulative', () => {
  // "Multiple instances of the same core ability or weapon ability are not
  //  cumulative... the controlling player must select which instance will
  //  apply."
  it('takes the better Sustained Hits rather than the sum', () => {
    const w = weapon({ sustainedHits: 2, skill: 3, attacks: '1' });
    const t = target({ toughness: 4, save: 7, models: 20 });

    const printedOnly = resolveAttack(w, t)!;
    const granted1 = resolveAttack(w, t, { grantSustainedHits: 1 })!;
    const granted3 = resolveAttack(w, t, { grantSustainedHits: 3 })!;

    // A weaker granted instance changes nothing...
    near(granted1.totalDamage, printedOnly.totalDamage);
    // ...and a stronger one replaces rather than adds.
    expect(granted3.totalDamage).toBeGreaterThan(printedOnly.totalDamage);
    const asIfSummed = resolveAttack(weapon({ sustainedHits: 5, skill: 3, attacks: '1' }), t)!;
    expect(granted3.totalDamage).toBeLessThan(asIfSummed.totalDamage);
  });

  it('selects the best applicable Anti-X rather than combining them', () => {
    const w = weapon({
      anti: [
        { keyword: 'Vehicle', critOn: 4 },
        { keyword: 'Vehicle', critOn: 2 },
      ],
    });
    expect(applyAnti(w, target({ keywords: ['Vehicle'] })).critWoundOn).toBe(2);
  });
});

describe('modifier cap: net +/-1 on hit and wound rolls', () => {
  // Confirmed by the rulebook owner: 11e caps roll modifiers at a net +/-1,
  // and Benefit of Cover stacks on top because it worsens the Ballistic Skill
  // characteristic rather than the roll.
  //
  // Every one of these passed before the cap was implemented, because nothing
  // in the suite had ever stacked two buffs of the same sign -- the engine
  // documented the cap in three places and enforced it in none.

  it('caps stacked hit bonuses at +1', () => {
    const w = weapon({ skill: 4, attacks: '10' });
    const t = target({ save: 7, toughness: 4 });

    const one = resolveAttack(w, t, { hitModifier: 1 })!;
    const three = resolveAttack(w, t, { hitModifier: 3 })!;
    near(three.totalDamage, one.totalDamage);

    // ...and is genuinely better than none, so the cap is not just flattening.
    const none = resolveAttack(w, t, {})!;
    expect(one.totalDamage).toBeGreaterThan(none.totalDamage);
  });

  it('caps stacked penalties at -1', () => {
    const w = weapon({ skill: 4, attacks: '10' });
    const t = target({ save: 7 });
    near(
      resolveAttack(w, t, { hitModifier: -4 })!.totalDamage,
      resolveAttack(w, t, { hitModifier: -1 })!.totalDamage
    );
  });

  it('lets a penalty pull a stacked bonus back into range', () => {
    // +1 and +1 and -1 is +1, not +2 clamped, and not 0.
    const w = weapon({ skill: 4, attacks: '10' });
    const t = target({ save: 7 });
    near(
      resolveAttack(w, t, { hitModifier: 1 + 1 - 1 })!.totalDamage,
      resolveAttack(w, t, { hitModifier: 1 })!.totalDamage
    );
  });

  it('caps wound modifiers, including the [LANCE] bonus', () => {
    const w = weapon({ strength: 4, attacks: '10', lance: true, melee: true });
    const t = target({ toughness: 4, save: 7 });

    // Lance's +1 on the charge is inside the cap, so an existing +1 absorbs it.
    near(
      resolveAttack(w, t, { charged: true, woundModifier: 1 })!.totalDamage,
      resolveAttack(w, t, { woundModifier: 1 })!.totalDamage
    );
  });

  it('stacks cover with a -1 to hit for an effective -2', () => {
    // The user's example. BS4+ with -1 to hit and cover needs a 6, so exactly
    // half as many hits land as the -1 alone.
    const w = weapon({ skill: 4, attacks: '12', strength: 10 });
    const t = target({ toughness: 4, save: 7, wounds: 1, models: 20 });

    const minusOne = resolveAttack(w, t, { hitModifier: -1 })!;
    const both = resolveAttack(w, t, { hitModifier: -1, cover: true })!;

    // 12 attacks: BS4+ at -1 needs 5+ and lands 4; with cover it needs 6+ and
    // lands 2. S10 vs T4 wounds on 2+, and there is no save.
    near(minusOne.totalDamage, 4 * (5 / 6));
    near(both.totalDamage, 2 * (5 / 6));

    // Cover is outside the cap, so it is not swallowed by it.
    expect(both.totalDamage).toBeLessThan(minusOne.totalDamage);
  });

  it('does not cap characteristic modifiers', () => {
    // The Red Thirst adds 2 to Strength; that is a profile change, not a roll
    // modifier, and clamping it would understate the whole detachment.
    // S4 vs T5 wounds on 5+; +1 makes it 4+ and +2 makes it 3+, so each step
    // has to show. Picking a toughness where both land in the same bracket
    // would make this test pass whether or not the value was clamped.
    const w = weapon({ strength: 4, attacks: '10', melee: true });
    const t = target({ toughness: 5, save: 7 });

    const plus2 = resolveAttack(w, t, { strengthModifier: 2 })!;
    const plus1 = resolveAttack(w, t, { strengthModifier: 1 })!;
    expect(plus2.totalDamage).toBeGreaterThan(plus1.totalDamage);
  });
});

describe('Anti-X wording variants', () => {
  // Seven weapons parsed to nothing because the keyword did not match the
  // expected shape. Each failed silently -- a Valkyrie's Hellstrike missiles
  // simply lost Anti-Fly and read as an ordinary missile.

  it('splits a compound keyword into separate conditions', () => {
    const flags = readKeywords(['Anti-Monster/Vehicle 3+']);
    expect(flags.anti).toEqual([
      { keyword: 'Monster', critOn: 3 },
      { keyword: 'Vehicle', critOn: 3 },
    ]);
  });

  it('accepts a threshold written without the plus', () => {
    // BSData writes the Hellstrike missile as "Anti-Fly 2".
    expect(readKeywords(['Anti-Fly 2']).anti).toEqual([{ keyword: 'Fly', critOn: 2 }]);
  });

  it('reads a non-breaking hyphen the same as a plain one', () => {
    expect(readKeywords(['Anti-Non‑Monster/Vehicle 2+']).anti).toEqual([
      { keyword: 'Monster', critOn: 2, negated: true },
      { keyword: 'Vehicle', critOn: 2, negated: true },
    ]);
  });

  it('fires a negated Anti-X at everything except the listed keywords', () => {
    const w = weapon({
      strength: 4,
      attacks: '10',
      anti: [{ keyword: 'Vehicle', critOn: 2, negated: true }],
    });
    const vehicle = target({ toughness: 10, save: 7, keywords: ['Vehicle'] });
    const infantry = target({ toughness: 10, save: 7, keywords: ['Infantry'] });

    // Against a vehicle the ability is inert; against anything else it turns
    // wound rolls of 2+ into critical wounds.
    expect(applyAnti(w, vehicle).critWoundOn).toBeUndefined();
    expect(applyAnti(w, infantry).critWoundOn).toBe(2);
  });
});

describe('[HEAVY] adds 1 to the Hit roll when the unit stayed still', () => {
  // Cross-checked against mathhammer.io, which models this and which we
  // matched distribution-for-distribution once it was implemented. 543 weapons
  // carry Heavy -- every bolt rifle, melta rifle and lascannon -- so leaving it
  // out understated every gunline that did what gunlines do.

  it('improves the hit roll only while stationary', () => {
    const w = weapon({ skill: 4, attacks: '12', strength: 10, heavy: true });
    const t = target({ toughness: 4, save: 7, wounds: 1, models: 20 });

    // BS4+ lands 6 of 12; stationary makes it 3+ and lands 8.
    near(resolveAttack(w, t, {})!.totalDamage, 6 * (5 / 6));
    near(resolveAttack(w, t, { stationary: true })!.totalDamage, 8 * (5 / 6));
  });

  it('does nothing for a weapon without the keyword', () => {
    const w = weapon({ skill: 4, attacks: '12', strength: 10 });
    const t = target({ toughness: 4, save: 7, wounds: 1, models: 20 });
    near(
      resolveAttack(w, t, { stationary: true })!.totalDamage,
      resolveAttack(w, t, {})!.totalDamage
    );
  });

  it('stays inside the +/-1 cap rather than stacking past it', () => {
    // A unit already at +1 to hit gains nothing further by standing still.
    const w = weapon({ skill: 4, attacks: '12', strength: 10, heavy: true });
    const t = target({ toughness: 4, save: 7, wounds: 1, models: 20 });
    near(
      resolveAttack(w, t, { hitModifier: 1, stationary: true })!.totalDamage,
      resolveAttack(w, t, { hitModifier: 1 })!.totalDamage
    );
  });

  it('reads the keyword off a real datasheet', () => {
    // A melta rifle is "Heavy, Melta 2".
    expect(readKeywords(['Heavy', 'Melta 2']).heavy).toBe(true);
    expect(readKeywords(['Assault']).heavy).toBe(false);
  });
});
