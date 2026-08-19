import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DataAbility, DataUnit } from './adapt';
import { buffsFor, readLeaderEffects } from './leaders';

function leader(...abilities: Array<[string, string]>): DataUnit {
  return {
    id: 'x',
    name: 'test leader',
    legends: false,
    models: [],
    weapons: [],
    keywords: [],
    abilities: abilities.map(([name, text]): DataAbility => ({ name, text })),
    points: [],
    basePoints: null,
  };
}

describe('reading leader abilities', () => {
  it('reads a granted Sustained Hits', () => {
    // Librarian in Terminator Armour, verbatim.
    const effects = readLeaderEffects(
      leader([
        'Veil of Time',
        'While this model is leading a unit, weapons equipped by models in that unit have the [SUSTAINED HITS 1] ability.',
      ])
    );
    expect(effects.buffs).toHaveLength(1);
    expect(effects.buffs[0].modifiers.grantSustainedHits).toBe(1);
    expect(effects.buffs[0].scope).toBe('all');
  });

  it('reads a melee-scoped wound reroll as rerolling failures', () => {
    // Adrax Agatone, verbatim. A leader granting "re-roll the Wound roll" is
    // taken to mean rerolling failures; throwing back a success to fish for a
    // critical is a deliberate play the user opts into, not an assumption.
    const effects = readLeaderEffects(
      leader([
        'Unto the Anvil',
        'While this model is leading a unit, each time a model in that unit makes a melee attack, you can re-roll the Wound roll.',
      ])
    );
    expect(effects.buffs[0].scope).toBe('melee');
    expect(effects.buffs[0].modifiers.rerollWounds).toBe('failures');
  });

  it('applies a melee buff to melee only', () => {
    const effects = readLeaderEffects(
      leader([
        'Unto the Anvil',
        'While this model is leading a unit, each time a model in that unit makes a melee attack, you can re-roll the Wound roll.',
      ])
    );
    expect(buffsFor(effects, 'melee').rerollWounds).toBe('failures');
    expect(buffsFor(effects, 'ranged').rerollWounds).toBeUndefined();
  });

  it('applies a ranged-scoped buff to shooting only', () => {
    const effects = readLeaderEffects(
      leader([
        'Fire Discipline',
        'While the bearer is leading a unit, ranged weapons equipped by models in that unit have the [SUSTAINED HITS 1] ability.',
      ])
    );
    expect(buffsFor(effects, 'ranged').grantSustainedHits).toBe(1);
    expect(buffsFor(effects, 'melee').grantSustainedHits).toBeUndefined();
  });

  it('reads roll and characteristic modifiers', () => {
    const effects = readLeaderEffects(
      leader(
        ['A', 'While this model is leading a unit, each time a model in that unit makes an attack, add 1 to the Hit roll.'],
        ['B', 'While this model is leading a unit, add 1 to the Strength characteristic of melee weapons equipped by models in that unit.'],
        ['C', 'While this model is leading a unit, improve the Armour Penetration characteristic of melee weapons in that unit by 1.']
      )
    );
    const merged = buffsFor(effects, 'melee');
    expect(merged.hitModifier).toBe(1);
    expect(merged.strengthModifier).toBe(1);
    expect(merged.apModifier).toBe(1);
  });

  it('sums stacked hit modifiers so the engine can cap the total', () => {
    // Two +1s must arrive as +2; capping is the engine's job, not the
    // parser's, otherwise a later -1 could not bring it back into range.
    const effects = readLeaderEffects(
      leader(
        ['A', 'While this model is leading a unit, each time a model in that unit makes an attack, add 1 to the Hit roll.'],
        ['B', 'While this model is leading a unit, models in that unit add 1 to the Hit roll.']
      )
    );
    expect(buffsFor(effects, 'melee').hitModifier).toBe(2);
  });

  it('keeps the stronger of two rerolls', () => {
    const effects = readLeaderEffects(
      leader(
        ['A', 'While this model is leading a unit, models in that unit can re-roll a Hit roll of 1.'],
        ['B', 'While this model is leading a unit, models in that unit can re-roll the Hit roll.']
      )
    );
    expect(buffsFor(effects, 'melee').rerollHits).toBe('failures');
  });

  it('ignores abilities that are not conditional on leading', () => {
    const effects = readLeaderEffects(
      leader([
        'Lord of the Pyroclasts',
        'While an enemy unit is within Engagement Range of this model, halve the Objective Control characteristic of models in that enemy unit.',
      ])
    );
    expect(effects.buffs).toEqual([]);
    expect(effects.unparsed).toEqual([]);
  });

  it('reports an unmodellable leading ability rather than dropping it', () => {
    const effects = readLeaderEffects(
      leader([
        'Strange Aura',
        'While this model is leading a unit, models in that unit do something the parser has never seen before.',
      ])
    );
    expect(effects.buffs).toEqual([]);
    expect(effects.unparsed.map((a) => a.name)).toEqual(['Strange Aura']);
  });

  it('does not report non-damage abilities as gaps', () => {
    // Fights First changes when you swing, not how hard.
    const effects = readLeaderEffects(
      leader(['Tempormortis', 'While this model is leading a unit, that unit has the Fights First ability.'])
    );
    expect(effects.buffs).toEqual([]);
    expect(effects.unparsed).toEqual([]);
  });
});

const DATA = join(process.cwd(), 'public', 'data');
const hasData = existsSync(join(DATA, 'index.json'));
const describeWithData = hasData ? describe : describe.skip;

describeWithData('leader abilities across the real roster', () => {
  const manifest = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8')) as {
    factions: Array<{ slug: string }>;
  };
  const units: DataUnit[] = [];
  for (const { slug } of manifest.factions) {
    const path = join(DATA, `${slug}.json`);
    if (existsSync(path)) units.push(...JSON.parse(readFileSync(path, 'utf8')).units);
  }

  it('reads the two leaders used as worked examples', () => {
    const librarian = units.find((u) => u.name === 'Librarian in Terminator Armour')!;
    expect(buffsFor(readLeaderEffects(librarian), 'ranged').grantSustainedHits).toBe(1);

    const adrax = units.find((u) => u.name === 'Adrax Agatone')!;
    const melee = buffsFor(readLeaderEffects(adrax), 'melee');
    expect(melee.rerollWounds).toBe('failures');
    expect(buffsFor(readLeaderEffects(adrax), 'ranged').rerollWounds).toBeUndefined();
  });

  it('never assumes a leader lets you reroll successful wounds', () => {
    // Fishing for criticals changes the number, so it must only ever be a
    // choice the user makes, never something inferred from a datasheet.
    for (const unit of units) {
      for (const buff of readLeaderEffects(unit).buffs) {
        expect(buff.modifiers.rerollWounds).not.toBe('fishing');
        expect(buff.modifiers.rerollHits).not.toBe('fishing');
      }
    }
  });

  it('parses most damage-affecting leader abilities', () => {
    let parsed = 0;
    let unparsed = 0;
    for (const unit of units) {
      const effects = readLeaderEffects(unit);
      parsed += effects.buffs.length;
      unparsed += effects.unparsed.length;
    }
    const coverage = parsed / (parsed + unparsed);
    // Reported so a regression is visible. This will never be 100% -- the
    // remaining tail is one-off wordings, and each is surfaced to the user as
    // an unmodelled note rather than silently ignored.
    console.log(
      `\nleader buffs: ${parsed} parsed, ${unparsed} unmodelled ` +
        `(${(coverage * 100).toFixed(0)}% coverage)\n`
    );
    expect(coverage).toBeGreaterThan(0.8);
  });

  it('does not mistake a defensive ability for an attacker buff', () => {
    // Stealth reads "that unit has the benefit of cover", which looks like a
    // leading-conditional buff but is defender-side and already covered by the
    // cover toggle. Counting it here would both mis-score and drown the real
    // gaps in noise.
    const stealthy = units.filter((u) =>
      u.abilities.some((a) => /^stealth$/i.test(a.name))
    );
    expect(stealthy.length).toBeGreaterThan(50);
    for (const unit of stealthy) {
      const effects = readLeaderEffects(unit);
      expect(effects.unparsed.some((a) => /^stealth$/i.test(a.name))).toBe(false);
    }
  });
});
