import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DataAbility, DataUnit } from './adapt';
import { resolveBuffs } from './conditions';
import { automaticBuffs, optionalBuffs, readSelfBuffs } from './selfbuffs';

function withAbilities(...abilities: Array<[string, string]>): DataUnit {
  return {
    id: 'x', name: 'test', legends: false, models: [], weapons: [], keywords: [],
    abilities: abilities.map(([name, text]): DataAbility => ({ name, text })),
    points: [], basePoints: null,
  };
}

describe('reading a unit\'s own abilities', () => {
  it('reads the "attack made by a model in this unit" phrasing', () => {
    // Eradicators, verbatim. An earlier parser only matched the other word
    // order and returned nothing at all for this unit.
    const { buffs } = readSelfBuffs(
      withAbilities([
        'Total Obliteration',
        'Each time a ranged attack made by a model in this unit targets a Monster or Vehicle model, ' +
          'you can re-roll the Hit roll, you can re-roll the Wound roll and you can re-roll the Damage roll.',
      ])
    );

    expect(buffs).toHaveLength(1);
    expect(buffs[0].modifiers).toMatchObject({
      rerollHits: 'failures',
      rerollWounds: 'failures',
      rerollDamage: true,
    });
    expect(buffs[0].requiresTargetKeyword.sort()).toEqual(['Monster', 'Vehicle']);
    expect(buffs[0].scope).toBe('ranged');
    expect(buffs[0].trigger).toBe('target-keyword');
  });

  it('reads the "a model in this unit makes an attack" phrasing', () => {
    const { buffs } = readSelfBuffs(
      withAbilities([
        'Guided by Fate',
        'Each time a model in this unit makes an attack, you can re-roll the Hit roll and you can re-roll the Wound roll.',
      ])
    );
    expect(buffs[0].modifiers).toMatchObject({ rerollHits: 'failures', rerollWounds: 'failures' });
    expect(buffs[0].trigger).toBe('always');
  });

  it('reads the +2 A shorthand', () => {
    // Intercessors' Hail of Bolts doubles a bolt rifle's attacks.
    const { buffs } = readSelfBuffs(
      withAbilities([
        'Hail of Bolts',
        "In your Shooting phase, when this unit is selected to shoot, select up to one visible enemy unit. " +
          "While making those attacks, this unit's Bolt Rifle attacks that targeted that enemy unit have +2 A",
      ])
    );
    expect(buffs[0].modifiers.attacksModifier).toBe(2);
    // It needs the player to nominate a unit, so it is not automatic.
    expect(buffs[0].trigger).toBe('situational');
  });

  it('marks a half-range ability as needing a toggle', () => {
    // Dire Avengers' Bladestorm.
    const { buffs } = readSelfBuffs(
      withAbilities([
        'Bladestorm',
        'Ranged weapons equipped by models in this unit have the [Sustained Hits 1] ability while targeting an enemy unit within half range.',
      ])
    );
    expect(buffs[0].modifiers.grantSustainedHits).toBe(1);
    expect(buffs[0].trigger).toBe('half-range');
    expect(optionalBuffs(buffs)).toHaveLength(1);
    expect(automaticBuffs(buffs)).toHaveLength(0);
  });

  it('separates automatic buffs from ones needing a toggle', () => {
    const { buffs } = readSelfBuffs(
      withAbilities(
        ['Auto', 'Each time a model in this unit makes an attack, add 1 to the Wound roll.'],
        ['Conditional', 'Each time a model in this unit makes an attack that targets a Vehicle unit, you can re-roll the Hit roll.'],
        ['Toggle', 'Once per battle, each time a model in this unit makes an attack, add 1 to the Hit roll.']
      )
    );
    expect(automaticBuffs(buffs).map((b) => b.source).sort()).toEqual(['Auto', 'Conditional']);
    expect(optionalBuffs(buffs).map((b) => b.source)).toEqual(['Toggle']);
  });

  it('ignores army-wide rules that sit on every datasheet', () => {
    const { buffs } = readSelfBuffs(
      withAbilities([
        'Oath of Moment',
        'Each time a model in this unit makes an attack that targets your Oath of Moment target, you can re-roll the Hit roll.',
      ])
    );
    expect(buffs).toEqual([]);
  });

  it('reports an unmodellable ability rather than dropping it', () => {
    const { buffs, unparsed } = readSelfBuffs(
      withAbilities([
        'Strange Geometry',
        'Each time a model in this unit makes an attack, something happens that this parser has never seen.',
      ])
    );
    expect(buffs).toEqual([]);
    expect(unparsed.map((a) => a.name)).toEqual(['Strange Geometry']);
  });

  it('does not report non-damage abilities as gaps', () => {
    const { unparsed } = readSelfBuffs(
      withAbilities(['Swift', 'Each time a model in this unit makes an attack, it is eligible to Fall Back.'])
    );
    expect(unparsed).toEqual([]);
  });
});

const DATA = join(process.cwd(), 'public', 'data');
const hasData = existsSync(join(DATA, 'index.json'));
const describeWithData = hasData ? describe : describe.skip;

describeWithData('self-buffs across the real roster', () => {
  const manifest = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8')) as {
    factions: Array<{ slug: string }>;
  };
  const units: DataUnit[] = [];
  for (const { slug } of manifest.factions) {
    const p = join(DATA, `${slug}.json`);
    if (existsSync(p)) units.push(...JSON.parse(readFileSync(p, 'utf8')).units);
  }
  const find = (n: string) => units.find((u) => u.name === n)!;

  it('reads the two units used as worked examples', () => {
    const erad = readSelfBuffs(find('Eradicator Squad'));
    const total = erad.buffs.find((b) => /total obliteration/i.test(b.source))!;
    expect(total.modifiers.rerollDamage).toBe(true);
    expect(total.requiresTargetKeyword.sort()).toEqual(['Monster', 'Vehicle']);

    const fire = readSelfBuffs(find('Fire Dragons'));
    const assured = fire.buffs.find((b) => /assured destruction/i.test(b.source))!;
    expect(assured.modifiers.rerollDamage).toBe(true);
  });

  it('applies a conditional buff only against a matching target', () => {
    const erad = readSelfBuffs(find('Eradicator Squad'));
    const vsTank = resolveBuffs(erad.buffs, ['Vehicle'], 'ranged');
    const vsInfantry = resolveBuffs(erad.buffs, ['Infantry'], 'ranged');

    expect(vsTank.modifiers.rerollDamage).toBe(true);
    expect(vsInfantry.modifiers.rerollDamage).toBeUndefined();
  });

  it('parses a solid share of the roster and reports the rest', () => {
    let parsed = 0;
    let unparsed = 0;
    for (const unit of units) {
      const s = readSelfBuffs(unit);
      parsed += s.buffs.length;
      unparsed += s.unparsed.length;
    }
    const coverage = parsed / (parsed + unparsed);
    console.log(
      `\nself-buffs: ${parsed} parsed, ${unparsed} unmodelled (${(coverage * 100).toFixed(0)}% coverage)\n`
    );
    expect(parsed).toBeGreaterThan(800);
    expect(coverage).toBeGreaterThan(0.85);
  });

  it('does not mistake death or deployment abilities for attack buffs', () => {
    // Deadly Demise fires when a model is destroyed and Deep Strike is
    // deployment; both match the "models in this unit" phrasing. Left in,
    // they were 90% of the unmodelled list and buried the real gaps.
    for (const unit of units) {
      const { buffs, unparsed } = readSelfBuffs(unit);
      for (const b of buffs) {
        expect(b.source).not.toMatch(/^(deadly demise|deep strike)/i);
      }
      for (const a of unparsed) {
        expect(a.name).not.toMatch(/^(deadly demise|deep strike)/i);
      }
    }
  });

  it('never silently assumes a situational ability is active', () => {
    // A half-range or once-per-battle buff must not end up in the automatic
    // set, or every unit holding one is overrated everywhere.
    for (const unit of units) {
      for (const buff of automaticBuffs(readSelfBuffs(unit).buffs)) {
        expect(buff.trigger === 'always' || buff.trigger === 'target-keyword').toBe(true);
      }
    }
  });
});
