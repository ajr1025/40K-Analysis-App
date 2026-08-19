import { describe, expect, it } from 'vitest';

import { type ConditionalBuff, buffApplies, readTargetKeywords, resolveBuffs } from './conditions';
import { type Target, type Weapon, resolveAttack } from './resolve';

const buff = (o: Partial<ConditionalBuff> = {}): ConditionalBuff => ({
  source: 'test',
  scope: 'all',
  requiresTargetKeyword: [],
  modifiers: {},
  summary: '',
  ...o,
});

describe('reading target conditions from rules text', () => {
  it('finds the keywords an ability names', () => {
    // Eradicators, verbatim.
    const { keywords, negated } = readTargetKeywords(
      'Each time a ranged attack made by a model in this unit targets a Monster or Vehicle model, ' +
        'you can re-roll the Hit roll, you can re-roll the Wound roll and you can re-roll the Damage roll.'
    );
    expect(keywords.sort()).toEqual(['Monster', 'Vehicle']);
    expect(negated).toBe(false);
  });

  it('handles an excluding wording', () => {
    const { keywords, negated } = readTargetKeywords(
      'that targets a unit (excluding Monster and Vehicle units), that attack has [SUSTAINED HITS 1]'
    );
    expect(keywords.sort()).toEqual(['Monster', 'Vehicle']);
    expect(negated).toBe(true);
  });

  it('reports no keywords for an unconditional ability', () => {
    expect(readTargetKeywords('each time a model in this unit makes an attack, add 1 to the Hit roll').keywords)
      .toEqual([]);
  });
});

describe('deciding whether a buff applies', () => {
  const antiTank = buff({ requiresTargetKeyword: ['Monster', 'Vehicle'], scope: 'ranged' });

  it('applies against a matching target', () => {
    expect(buffApplies(antiTank, ['Vehicle', 'Imperium'], 'ranged')).toBe(true);
  });

  it('does not apply against a non-matching target', () => {
    expect(buffApplies(antiTank, ['Infantry'], 'ranged')).toBe(false);
  });

  it('respects the melee/ranged scope', () => {
    expect(buffApplies(antiTank, ['Vehicle'], 'melee')).toBe(false);
  });

  it('inverts for an excluding condition', () => {
    const antiInfantry = buff({ requiresTargetKeyword: ['Monster', 'Vehicle'], negated: true });
    expect(antiInfantry.requiresTargetKeyword.length).toBeGreaterThan(0);
    expect(buffApplies(antiInfantry, ['Infantry'], 'ranged')).toBe(true);
    expect(buffApplies(antiInfantry, ['Vehicle'], 'ranged')).toBe(false);
  });

  it('always applies when unconditional', () => {
    expect(buffApplies(buff(), ['anything'], 'melee')).toBe(true);
    expect(buffApplies(buff(), undefined, 'ranged')).toBe(true);
  });

  it('is case-insensitive about keywords', () => {
    expect(buffApplies(antiTank, ['VEHICLE'], 'ranged')).toBe(true);
  });
});

describe('merging the buffs that apply', () => {
  it('sums roll modifiers so the engine can cap the total', () => {
    const { modifiers } = resolveBuffs(
      [
        buff({ modifiers: { hitModifier: 1 } }),
        buff({ modifiers: { hitModifier: 1 } }),
        buff({ modifiers: { hitModifier: -1 } }),
      ],
      [],
      'ranged'
    );
    expect(modifiers.hitModifier).toBe(1);
  });

  it('keeps the strongest reroll', () => {
    const { modifiers } = resolveBuffs(
      [
        buff({ modifiers: { rerollHits: 'ones' } }),
        buff({ modifiers: { rerollHits: 'failures' } }),
      ],
      [],
      'ranged'
    );
    expect(modifiers.rerollHits).toBe('failures');
  });

  it('excludes buffs whose condition is unmet, and reports what applied', () => {
    const buffs = [
      buff({ source: 'Total Obliteration', requiresTargetKeyword: ['Vehicle'], modifiers: { rerollHits: 'failures' } }),
      buff({ source: 'Always on', modifiers: { woundModifier: 1 } }),
    ];

    const vsTank = resolveBuffs(buffs, ['Vehicle'], 'ranged');
    expect(vsTank.applied.map((b) => b.source).sort()).toEqual(['Always on', 'Total Obliteration']);
    expect(vsTank.modifiers.rerollHits).toBe('failures');

    const vsInfantry = resolveBuffs(buffs, ['Infantry'], 'ranged');
    expect(vsInfantry.applied.map((b) => b.source)).toEqual(['Always on']);
    expect(vsInfantry.modifiers.rerollHits).toBeUndefined();
  });
});

describe('rerolling the damage roll', () => {
  const melta = (o: Partial<Weapon> = {}): Weapon => ({
    name: 'Melta rifle',
    attacks: '1',
    skill: 3,
    strength: 9,
    ap: 4,
    damage: 'D6',
    torrent: true,
    ...o,
  });
  const tank = (o: Partial<Target> = {}): Target => ({
    name: 'tank',
    toughness: 9,
    save: 3,
    wounds: 12,
    models: 1,
    keywords: ['Vehicle'],
    ...o,
  });

  it('raises the damage of a variable-damage weapon', () => {
    const plain = resolveAttack(melta(), tank())!;
    const rerolled = resolveAttack(melta(), tank(), { rerollDamage: true })!;
    expect(rerolled.totalDamage).toBeGreaterThan(plain.totalDamage);
  });

  it('rerolls the outcomes a player would actually reroll', () => {
    // D6 damage: keeping 4-6 and rerolling 1-3 gives 4.25 average, up from 3.5.
    const t = tank({ wounds: 40 });
    const plain = resolveAttack(melta({ attacks: '1' }), t)!;
    const rerolled = resolveAttack(melta({ attacks: '1' }), t, { rerollDamage: true })!;
    const ratio = rerolled.totalDamage / plain.totalDamage;
    expect(ratio).toBeCloseTo(4.25 / 3.5, 4);
  });

  it('leaves fixed damage alone', () => {
    const flat = melta({ damage: '2' });
    const t = tank();
    expect(resolveAttack(flat, t, { rerollDamage: true })!.totalDamage).toBeCloseTo(
      resolveAttack(flat, t)!.totalDamage,
      9
    );
  });

  it('never lowers the damage', () => {
    for (const d of ['1', '2', 'D3', 'D6', 'D6+2', '2D6']) {
      const w = melta({ damage: d });
      const t = tank({ wounds: 60 });
      expect(resolveAttack(w, t, { rerollDamage: true })!.totalDamage).toBeGreaterThanOrEqual(
        resolveAttack(w, t)!.totalDamage - 1e-9
      );
    }
  });

  it('models the Eradicator case end to end', () => {
    // Total Obliteration: reroll hits, wounds and damage — but only against a
    // Monster or Vehicle. Against infantry none of it applies.
    const obliteration: ConditionalBuff[] = [
      {
        source: 'Total Obliteration',
        scope: 'ranged',
        requiresTargetKeyword: ['Monster', 'Vehicle'],
        modifiers: { rerollHits: 'failures', rerollWounds: 'failures', rerollDamage: true },
        summary: 'reroll hits, wounds and damage',
      },
    ];

    const rifle = melta({ torrent: false, skill: 3 });
    const vehicle = tank();
    const infantry = tank({ toughness: 4, save: 3, wounds: 2, models: 5, keywords: ['Infantry'] });

    const vsTank = resolveAttack(rifle, vehicle, {
      attackingModels: 3,
      ...resolveBuffs(obliteration, vehicle.keywords, 'ranged').modifiers,
    })!;
    const vsTankPlain = resolveAttack(rifle, vehicle, { attackingModels: 3 })!;

    const vsInf = resolveAttack(rifle, infantry, {
      attackingModels: 3,
      ...resolveBuffs(obliteration, infantry.keywords, 'ranged').modifiers,
    })!;
    const vsInfPlain = resolveAttack(rifle, infantry, { attackingModels: 3 })!;

    // A large gain where the ability applies...
    expect(vsTank.totalDamage / vsTankPlain.totalDamage).toBeGreaterThan(1.5);
    // ...and none at all where it does not.
    expect(vsInf.totalDamage).toBeCloseTo(vsInfPlain.totalDamage, 9);
  });
});
