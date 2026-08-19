/**
 * Army-wide rules, which belong to a selector rather than to a datasheet.
 *
 * Oath of Moment appears on 367 units across 15 factions and Templar Vows on
 * 246 — not because those units each have them, but because the whole army
 * does. Worse, the Space Marines and Black Templars catalogues link into each
 * other, so a plain Intercessor squad shows Templar Vows it would only have in
 * a Templar army.
 *
 * Listing them per unit is therefore both noise and a lie. They are collected
 * here once per faction, and the player picks which is active.
 */

import type { DataUnit } from './adapt';
import { type ConditionalBuff, readEffects, readTargetKeywords } from './conditions';

/** The rules that are army-wide rather than unit abilities. */
const ARMY_RULES = [
  'Oath of Moment',
  'Templar Vows',
  'Battle Focus',
  'Reanimation Protocols',
  'For The Greater Good',
  'Combat Doctrines',
  'Waaagh!',
];

export interface ArmyRule {
  name: string;
  text: string;
  /** Factions whose datasheets carry it. */
  factions: string[];
  /** How many units list it — a rough measure of how army-wide it is. */
  units: number;
  buff: ConditionalBuff | null;
  /**
   * Nearly all of these are conditional (a nominated target, an active vow, a
   * called Waaagh!), so they are never applied automatically.
   */
  conditional: boolean;
}

/** Collect the army rules present across a set of units. */
export function collectArmyRules(units: Array<DataUnit & { faction?: string }>): ArmyRule[] {
  const found = new Map<string, ArmyRule>();

  for (const unit of units) {
    for (const ability of unit.abilities ?? []) {
      const name = (ability.name ?? '').trim();
      if (!ARMY_RULES.some((r) => r.toLowerCase() === name.toLowerCase())) continue;

      const existing = found.get(name);
      if (existing) {
        existing.units += 1;
        const faction = unit.faction ?? '';
        if (faction && !existing.factions.includes(faction)) existing.factions.push(faction);
        continue;
      }

      const text = ability.text ?? '';
      const modifiers = readEffects(text);
      const { keywords, negated } = readTargetKeywords(text);

      found.set(name, {
        name,
        text,
        factions: unit.faction ? [unit.faction] : [],
        units: 1,
        buff: Object.keys(modifiers).length
          ? {
              source: name,
              scope: 'all',
              requiresTargetKeyword: keywords,
              negated,
              modifiers,
              summary: Object.keys(modifiers).join(', '),
            }
          : null,
        // "select one unit", "while a Vow is active", "call a Waaagh!" — all
        // require the player to have done something.
        conditional: /select one|while a|once per|if you do|is active|you can call/i.test(text),
      });
    }
  }

  return [...found.values()].sort((a, b) => b.units - a.units);
}

/** The army rules available to a given faction. */
export function rulesForFaction(rules: ArmyRule[], faction: string): ArmyRule[] {
  return rules.filter((r) => r.factions.some((f) => f === faction));
}
