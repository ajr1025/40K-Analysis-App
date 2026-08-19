/**
 * The modifier surface: everything a player can change about a matchup.
 *
 * The important distinction under test is which modifiers are capped. The
 * +/-1 cap governs *dice rolls*, not *characteristics* -- so "add 2 to the
 * Strength characteristic" applies in full while "+1 to hit" twice does not.
 * Getting that backwards silently mis-scores a large share of faction rules.
 */

import { describe, expect, it } from 'vitest';

import { type Target, type Weapon, resolveAttack } from './resolve';

const weapon = (o: Partial<Weapon> = {}): Weapon => ({
  name: 'w',
  attacks: '1',
  skill: 3,
  strength: 4,
  ap: 0,
  damage: '1',
  torrent: true,
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

const near = (actual: number, want: number) => expect(actual).toBeCloseTo(want, 9);
const damageOf = (w: Partial<Weapon>, t: Partial<Target>, m = {}) =>
  resolveAttack(weapon(w), target(t), m)!.totalDamage;

describe('attacker characteristic modifiers are not capped', () => {
  it('adds attacks', () => {
    // Auto-hitting, wounding on 4+: each attack is worth 1/2 a wound.
    near(damageOf({ attacks: '2' }, {}, { attacksModifier: 2 }), 4 * 0.5);
  });

  it('adds strength beyond the +/-1 roll cap', () => {
    // S4 into T4 wounds on 4+; +2 Strength makes it S6, wounding on 3+.
    near(damageOf({}, {}, { strengthModifier: 0 }), 3 / 6);
    near(damageOf({}, {}, { strengthModifier: 2 }), 4 / 6);
    // And +4 reaches double Toughness, wounding on 2+.
    near(damageOf({}, {}, { strengthModifier: 4 }), 5 / 6);
  });

  it('improves armour penetration', () => {
    // Auto-hitting, wounding on 4+ (3/6). A 3+ save fails 2/6; AP-1 pushes it
    // to 4+, failing 3/6.
    near(damageOf({}, { save: 3 }, {}), (3 / 6) * (2 / 6));
    near(damageOf({}, { save: 3 }, { apModifier: 1 }), (3 / 6) * (3 / 6));
  });

  it('adds damage', () => {
    near(damageOf({ damage: '1' }, { wounds: 10, models: 1 }, { damageModifier: 2 }), (3 / 6) * 3);
  });

  it('never reduces damage below 1', () => {
    near(damageOf({ damage: '1' }, { wounds: 10, models: 1 }, { damageModifier: -5 }), (3 / 6) * 1);
  });
});

describe('defender characteristic modifiers', () => {
  it('worsens toughness', () => {
    // Death Guard's Afflicted: -1 Toughness turns T4 into T3, so an S4 weapon
    // goes from wounding on 4+ to wounding on 3+.
    near(damageOf({}, {}, {}), 3 / 6);
    near(damageOf({}, {}, { toughnessModifier: -1 }), 4 / 6);
  });

  it('never lets toughness fall below 1', () => {
    const result = resolveAttack(weapon(), target({ toughness: 1 }), { toughnessModifier: -5 })!;
    expect(result.totalDamage).toBeGreaterThan(0);
    expect(Number.isFinite(result.totalDamage)).toBe(true);
  });

  it('worsens the armour save', () => {
    // Rattlejoint Ague worsens the Save characteristic by 1: a 3+ that failed
    // 2/6 of the time becomes a 4+ failing 3/6.
    near(damageOf({}, { save: 3 }, {}), (3 / 6) * (2 / 6));
    near(damageOf({}, { save: 3 }, { saveModifier: 1 }), (3 / 6) * (3 / 6));
  });

  it('overrides the invulnerable save', () => {
    // Granting a 4++ against an AP-4 weapon that would otherwise ignore armour.
    const without = damageOf({ ap: 4 }, { save: 3 }, {});
    const withInvuln = damageOf({ ap: 4 }, { save: 3 }, { invulnerable: 4 });
    expect(withInvuln).toBeLessThan(without);
    near(withInvuln, (3 / 6) * (3 / 6));
  });

  it('overrides Feel No Pain in both directions', () => {
    near(damageOf({}, { feelNoPain: 5 }, {}), (3 / 6) * (2 / 3));
    // Removing it entirely.
    near(damageOf({}, { feelNoPain: 5 }, { feelNoPain: null }), 3 / 6);
    // Granting it to a unit that has none.
    near(damageOf({}, {}, { feelNoPain: 4 }), (3 / 6) * 0.5);
  });

  it('overrides damage reduction', () => {
    near(damageOf({ damage: '3' }, { wounds: 10, models: 1 }, { damageReduction: 1 }), (3 / 6) * 2);
  });

  it('overrides the target unit size', () => {
    // Scoring against a 20-model blob rather than the default squad.
    const result = resolveAttack(weapon({ attacks: '30' }), target({ models: 10 }), {
      targetModels: 20,
    })!;
    expect(result.expectedModelsSlain).toBeGreaterThan(10);
  });
});

describe('abilities granted by leaders and stratagems', () => {
  it('grants Sustained Hits', () => {
    // Not a Torrent weapon, since automatic hits are never critical.
    const w = weapon({ torrent: false, skill: 3, attacks: '1' });
    const base = resolveAttack(w, target(), {})!;
    const granted = resolveAttack(w, target(), { grantSustainedHits: 1 })!;
    // BS3+: 3/6 normal hits plus 1/6 criticals, each critical now worth two.
    near(base.totalDamage, (4 / 6) * (3 / 6));
    near(granted.totalDamage, (5 / 6) * (3 / 6));
  });

  it('does not stack a granted Sustained Hits onto a printed one', () => {
    // Core rule 24.02: duplicated weapon abilities are not cumulative — the
    // player selects one instance. An earlier version of this test asserted
    // the opposite, which the rulebook contradicts.
    const w = weapon({ torrent: false, skill: 3, sustainedHits: 1 });
    const printed = resolveAttack(w, target(), {})!;
    const sameAgain = resolveAttack(w, target(), { grantSustainedHits: 1 })!;
    const stronger = resolveAttack(w, target(), { grantSustainedHits: 2 })!;

    near(sameAgain.totalDamage, printed.totalDamage);
    expect(stronger.totalDamage).toBeGreaterThan(printed.totalDamage);
  });

  it('grants Lethal Hits', () => {
    // Against a 2+ save the auto-wound is not worth much, but against a
    // hard-to-wound target it is: S4 into T8 wounds on 6s without it.
    const w = weapon({ torrent: false, skill: 3, strength: 4 });
    const t = target({ toughness: 8 });
    expect(resolveAttack(w, t, { grantLethalHits: true })!.totalDamage).toBeGreaterThan(
      resolveAttack(w, t, {})!.totalDamage
    );
  });

  it('grants Devastating Wounds', () => {
    const t = target({ save: 2 });
    expect(resolveAttack(weapon(), t, { grantDevastatingWounds: true })!.totalDamage).toBeGreaterThan(
      resolveAttack(weapon(), t, {})!.totalDamage
    );
  });

  it('grants Twin-linked', () => {
    // Rerolling failed wounds: a 4+ becomes 1/2 + 1/2 x 1/2.
    near(damageOf({}, {}, {}), 3 / 6);
    near(damageOf({}, {}, { grantTwinLinked: true }), 3 / 6 + (3 / 6) * (3 / 6));
  });

  it('grants Ignores Cover, cancelling the BS penalty', () => {
    const w = weapon({ torrent: false, skill: 3 });
    const t = target();
    near(resolveAttack(w, t, { cover: true })!.totalDamage, (3 / 6) * (3 / 6));
    near(
      resolveAttack(w, t, { cover: true, grantIgnoresCover: true })!.totalDamage,
      (4 / 6) * (3 / 6)
    );
  });

  it('honours Ignores Cover printed on the weapon', () => {
    const w = weapon({ torrent: false, skill: 3, ignoresCover: true });
    near(
      resolveAttack(w, target(), { cover: true })!.totalDamage,
      resolveAttack(w, target(), { cover: false })!.totalDamage
    );
  });

  it('lowers the critical hit threshold', () => {
    // "Critical hits on 5+" doubles the rate criticals trigger at.
    const w = weapon({ torrent: false, skill: 3, sustainedHits: 1 });
    const base = resolveAttack(w, target(), {})!;
    const fives = resolveAttack(w, target(), { critHitOn: 5 })!;
    expect(fives.totalDamage).toBeGreaterThan(base.totalDamage);
  });
});

describe('full wound rerolls can fish for criticals', () => {
  it('is never worse than rerolling only failures', () => {
    // "You can re-roll the Wound roll" permits throwing back a successful
    // non-critical wound. The engine tries both and keeps the better, so it
    // can only ever match or beat a failures-only reroll.
    const w = weapon({ devastatingWounds: true, strength: 4 });
    const t = target({ save: 2 });

    const failures = resolveAttack(w, t, { rerollWounds: 'failures' })!;
    const fishing = resolveAttack(w, t, { rerollWounds: 'fishing' })!;
    expect(fishing.totalDamage).toBeGreaterThanOrEqual(failures.totalDamage - 1e-9);
  });

  it('actually pays off when criticals bypass a strong save', () => {
    // With a 2+ save, an ordinary wound is nearly worthless while a critical
    // ignores the save entirely, so fishing wins.
    const w = weapon({ devastatingWounds: true, strength: 4 });
    const t = target({ save: 2 });
    expect(resolveAttack(w, t, { rerollWounds: 'fishing' })!.totalDamage).toBeGreaterThan(
      resolveAttack(w, t, { rerollWounds: 'failures' })!.totalDamage
    );
  });

  it('declines to fish when ordinary wounds already get through', () => {
    // Against a saveless target a normal wound is as good as a critical, so
    // throwing back successes would only lose damage. The engine should not.
    const w = weapon({ devastatingWounds: true, strength: 4 });
    const t = target({ save: 7 });
    near(
      resolveAttack(w, t, { rerollWounds: 'fishing' })!.totalDamage,
      resolveAttack(w, t, { rerollWounds: 'failures' })!.totalDamage
    );
  });
});

describe('roll modifiers stay capped while characteristics do not', () => {
  it('caps stacked hit modifiers at +1', () => {
    const w = weapon({ torrent: false, skill: 4 });
    near(
      resolveAttack(w, target(), { hitModifier: 3 })!.totalDamage,
      resolveAttack(w, target(), { hitModifier: 1 })!.totalDamage
    );
  });

  it('does not cap stacked strength', () => {
    // +4 Strength must not behave like +1.
    expect(damageOf({}, {}, { strengthModifier: 4 })).toBeGreaterThan(
      damageOf({}, {}, { strengthModifier: 1 })
    );
  });

  it('lets cover stack past the cap because it changes the characteristic', () => {
    const w = weapon({ torrent: false, skill: 3 });
    const t = target();
    const capped = resolveAttack(w, t, { hitModifier: -3 })!;
    const withCover = resolveAttack(w, t, { hitModifier: -3, cover: true })!;
    expect(withCover.totalDamage).toBeLessThan(capped.totalDamage);
  });
});
