/**
 * Detachments.
 *
 * Two armies can share an army rule and play nothing alike: Blood Angels and
 * Dark Angels both have Oath of Moment, but a Liberator Assault Group adds
 * +2 Strength and +1 Attack to melee weapons on the charge, which the Dark
 * Angels detachments do not. Leaving detachments out means every faction's
 * melee units read identically regardless of how they are actually built.
 *
 * They are deliberately not attached to datasheets — every unit in a faction
 * links every detachment, so per-unit they are both noise and wrong. The
 * player picks one, the same way they pick an army rule.
 */

import { type ConditionalBuff, readEffects, readTargetKeywords } from './conditions';
import type { BuffScope } from './leaders';
import type { Modifiers } from './resolve';
import type { Trigger } from './selfbuffs';

export interface DetachmentRule {
  name: string;
  text: string;
  buff: ConditionalBuff | null;
  trigger: Trigger;
  /** The wording that gates it, shown next to the toggle. */
  condition?: string;
}

export interface Detachment {
  name: string;
  rules: DetachmentRule[];
}

/** Raw shape emitted by the data pipeline. */
export interface RawDetachment {
  name: string;
  rules: Array<{ name: string; text: string }>;
}

const TRIGGERS: Array<[Trigger, RegExp]> = [
  ['charged', /made a charge move|ends a charge move|\bcharged\b/i],
  ['half-range', /within half range/i],
  ['stationary', /remained stationary|did not move/i],
  [
    'situational',
    /once per battle|at the start of|until the end|you can spend|select one|is active|in your (?:command|shooting|fight|movement) phase|if that unit|if this unit/i,
  ],
];

/**
 * Wording that makes a clause defensive: it modifies attacks made *against*
 * your army, not by it.
 *
 * Without this, "each time an attack targets an Adeptus Astartes unit from
 * your army ... subtract 1 from the Wound roll" parses as a -1 to wound on
 * the unit's own attacks. Wrath of the Rock and Vindication Task Force both
 * read as penalties to their own shooting, which is the opposite of what they
 * do. Reclamation Force is why this splits clauses rather than dropping whole
 * rules -- its first clause improves AP and its second is a defensive buff.
 */
const DEFENSIVE = /each time an attack (?:is made against|targets)\b/i;

/** Only the parts of a rule that change attacks this unit makes. */
export function offensiveClauses(text: string): string {
  return text
    .split(/(?<=\.)\s+|\s+[-•]\s+/)
    .filter((clause) => clause.trim() && !DEFENSIVE.test(clause))
    .join(' ');
}

/**
 * A short human summary of what a buff does, for the toggle label.
 *
 * The raw field names are what the engine wants; "attacksModifier,
 * strengthModifier" is not what a player reads.
 */
export function describeModifiers(modifiers: Partial<Modifiers>): string {
  const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  const parts: string[] = [];

  if (modifiers.hitModifier) parts.push(`${signed(modifiers.hitModifier)} to hit`);
  if (modifiers.woundModifier) parts.push(`${signed(modifiers.woundModifier)} to wound`);
  if (modifiers.attacksModifier) parts.push(`${signed(modifiers.attacksModifier)} Attacks`);
  if (modifiers.strengthModifier) parts.push(`${signed(modifiers.strengthModifier)} Strength`);
  if (modifiers.apModifier) parts.push(`${signed(modifiers.apModifier)} AP`);
  if (modifiers.damageModifier) parts.push(`${signed(modifiers.damageModifier)} Damage`);
  if (modifiers.rerollHits)
    parts.push(modifiers.rerollHits === 'ones' ? 're-roll hit 1s' : 're-roll hits');
  if (modifiers.rerollWounds)
    parts.push(modifiers.rerollWounds === 'ones' ? 're-roll wound 1s' : 're-roll wounds');
  if (modifiers.rerollDamage) parts.push('re-roll damage');
  if (modifiers.grantSustainedHits) parts.push(`Sustained Hits ${modifiers.grantSustainedHits}`);
  if (modifiers.grantLethalHits) parts.push('Lethal Hits');
  if (modifiers.grantDevastatingWounds) parts.push('Devastating Wounds');
  if (modifiers.grantTwinLinked) parts.push('Twin-linked');
  if (modifiers.grantIgnoresCover) parts.push('Ignores Cover');
  if (modifiers.critHitOn) parts.push(`crit hit on ${modifiers.critHitOn}+`);
  if (modifiers.critWoundOn) parts.push(`crit wound on ${modifiers.critWoundOn}+`);

  return parts.join(', ');
}

function scopeOf(text: string): BuffScope {
  const melee = /\bmelee (?:attack|weapon)/i.test(text);
  const ranged = /\branged (?:attack|weapon)/i.test(text);
  if (melee && !ranged) return 'melee';
  if (ranged && !melee) return 'ranged';
  return 'all';
}

/** Parse a faction's detachments into something the engine can apply. */
export function readDetachments(raw: RawDetachment[] | undefined): Detachment[] {
  return (raw ?? []).map((d) => ({
    name: d.name,
    rules: d.rules.map((rule) => {
      const offensive = offensiveClauses(rule.text);
      const modifiers = readEffects(offensive);
      const { keywords, negated } = readTargetKeywords(offensive);

      let trigger: Trigger = keywords.length ? 'target-keyword' : 'always';
      let condition: string | undefined;
      for (const [t, pattern] of TRIGGERS) {
        const match = pattern.exec(rule.text);
        if (match) {
          trigger = t;
          condition = match[0];
          break;
        }
      }

      return {
        name: rule.name,
        text: rule.text,
        trigger,
        condition,
        buff: Object.keys(modifiers).length
          ? {
              source: rule.name,
              scope: scopeOf(rule.text),
              requiresTargetKeyword: keywords,
              negated,
              modifiers,
              summary: describeModifiers(modifiers),
            }
          : null,
      };
    }),
  }));
}

/**
 * The buffs a chosen detachment contributes.
 *
 * Situational rules stay off unless named in `enabled`, for the same reason as
 * everywhere else: The Red Thirst only fires on the charge, and assuming every
 * melee unit charges every turn would overstate the whole detachment.
 */
export function detachmentBuffs(
  detachment: Detachment | null,
  enabled: string[] = []
): ConditionalBuff[] {
  if (!detachment) return [];
  const wanted = new Set(enabled);

  return detachment.rules
    .filter((r) => r.buff)
    .filter((r) => r.trigger === 'always' || r.trigger === 'target-keyword' || wanted.has(r.name))
    .map((r) => r.buff!);
}

/** Rules the player has to switch on, with the wording that gates them. */
export function optionalRules(detachment: Detachment | null): DetachmentRule[] {
  if (!detachment) return [];
  return detachment.rules.filter(
    (r) => r.buff && r.trigger !== 'always' && r.trigger !== 'target-keyword'
  );
}
