/**
 * The app's own path, end to end.
 *
 * Every other suite hands the engine a `Target` it built itself. That is what
 * let the modifier defaults erase every target's characteristics for a whole
 * build without a single test noticing: 300 of them passed while the app
 * resolved every squad in the game as one model and stripped every
 * invulnerable save.
 *
 * So these go the way the app goes — real datasheet, `makeAttacker` /
 * `makeTarget`, the real `defaultModifiers()` — and assert against numbers a
 * player could check by hand.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DataUnit } from '../engine/adapt';
import { defaultModifiers } from '../data/modifier-controls';
import type { Modifiers } from '../engine/resolve';
import type { Faction } from './data';
import { attackerContext, computeCell, makeAttacker, makeTarget } from './board';

const DATA = join(process.cwd(), 'public', 'data');
const hasData = existsSync(join(DATA, 'index.json'));
const describeWithData = hasData ? describe : describe.skip;

function faction(slug: string): Faction {
  return JSON.parse(readFileSync(join(DATA, `${slug}.json`), 'utf8'));
}

function unit(f: Faction, name: string): DataUnit {
  const found = f.units.find((u) => u.name === name);
  if (!found) throw new Error(`missing unit: ${name}`);
  return found;
}

/** Exactly what the app starts with. */
function appModifiers(): Modifiers {
  return { ...defaultModifiers(), halfRange: true };
}

describeWithData('the board as the app drives it', () => {
  const marines = faction('adeptus-astartes-space-marines');
  const guard = faction('astra-militarum');

  const cell = (attackerName: string, targetName: string, targetFaction = guard) => {
    const attacker = makeAttacker(unit(marines, attackerName), marines, 'a');
    const target = makeTarget(unit(targetFaction, targetName), targetFaction, 't')!;
    const context = attackerContext(attacker, null, 'all');
    return { cell: computeCell(context, target, appModifiers()), target, context };
  };

  it('resolves a squad as a squad, not as one model', () => {
    // The bug: `targetModels` defaulted to 1 and overrode the datasheet, so a
    // ten-model Cadian squad died to the first casualty and read 100% wiped.
    const { cell: c, target } = cell('Eradicator Squad', 'Cadian Shock Troops');

    expect(target.target.models).toBe(10);
    expect(c.modelsSlain).toBeGreaterThan(3);
    expect(c.modelsSlain).toBeLessThan(target.target.models);
    expect(c.wipeChance).toBeLessThan(50);

    // The distribution must span the unit, not collapse onto a single value.
    expect(c.modelsSlainDistribution.size).toBeGreaterThan(3);
    const total = [...c.modelsSlainDistribution.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('keeps a target\'s invulnerable save under the app defaults', () => {
    // Terminators have a 4++; the defaults used to erase it.
    const naked = makeTarget(unit(marines, 'Terminator Squad'), marines, 't')!;
    expect(naked.target.invulnerable).toBe(4);

    const attacker = makeAttacker(unit(marines, 'Eradicator Squad'), marines, 'a');
    const context = attackerContext(attacker, null, 'all');

    const withDefaults = computeCell(context, naked, appModifiers());
    const bare = computeCell(context, naked, { halfRange: true });
    expect(withDefaults.modelsSlain).toBeCloseTo(bare.modelsSlain, 9);
  });

  it('never kills more models than the unit has', () => {
    for (const targetName of ['Cadian Shock Troops', 'Leman Russ Battle Tank']) {
      for (const attackerName of ['Intercessor Squad', 'Eradicator Squad', 'Terminator Squad']) {
        const { cell: c, target } = cell(attackerName, targetName);
        expect(`${attackerName}->${targetName}: ${c.modelsSlain <= target.target.models}`).toBe(
          `${attackerName}->${targetName}: true`
        );
        expect(c.efficiency).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('charges the squad its real points, and the leader on top', () => {
    const squad = makeAttacker(unit(marines, 'Intercessor Squad'), marines, 'a');
    const alone = attackerContext(squad, null, 'all');
    expect(alone.points).toBe(80);
    expect(alone.models).toBe(5);

    const captain = unit(marines, 'Captain in Gravis Armour');
    const led = attackerContext({ ...squad, leader: captain }, null, 'all');
    expect(led.points).toBe(80 + (captain.basePoints ?? 0));
    expect(led.models).toBe(6);
  });

  it('reports a wipe chance consistent with the distribution', () => {
    const { cell: c, target } = cell('Terminator Squad', 'Cadian Shock Troops');
    const wipe = c.modelsSlainDistribution.get(target.target.models) ?? 0;
    expect(c.wipeChance).toBeCloseTo(wipe * 100, 6);
  });
});
