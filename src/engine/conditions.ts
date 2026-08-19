/**
 * Abilities that only apply against certain targets.
 *
 * A large share of what makes a unit good is conditional on what it is
 * shooting. Eradicators reroll hits, wounds *and* damage — but only against
 * Monsters and Vehicles, which is the entire reason they exist. Applying that
 * everywhere would overrate them against infantry; ignoring it underrates them
 * against armour by a wide margin. Either way the matrix would be wrong in the
 * one matchup the unit is bought for.
 *
 * So a buff carries the keywords it needs, and the engine resolves it per
 * target — exactly the way Anti-X already works.
 */

import type { Modifiers } from './resolve';
import type { BuffScope } from './leaders';

export interface ConditionalBuff {
  /** Ability it came from, for showing the working. */
  source: string;
  /** Melee, ranged, or both. */
  scope: BuffScope;
  /**
   * Target keywords that switch this on. Empty means unconditional.
   * Matching is "any of", which is how the datasheets read: "a Monster or
   * Vehicle unit".
   */
  requiresTargetKeyword: string[];
  /** True when the condition is the target *lacking* those keywords. */
  negated?: boolean;
  modifiers: Partial<Modifiers>;
  summary: string;
}

const KEYWORDS = [
  'Monster', 'Vehicle', 'Infantry', 'Character', 'Titanic', 'Psyker',
  'Mounted', 'Beast', 'Swarm', 'Fly', 'Battleline', 'Walker',
];

/**
 * Read the damage-affecting effects out of a piece of rules text.
 *
 * Shared by the leader parser and the self-buff parser, because the effects
 * are worded identically either way -- only the phrase identifying *who* is
 * affected differs ("models in that unit" versus "models in this unit").
 *
 * "D3" and "D6" values average rather than being modelled as dice: the
 * alternative is a distribution over ability values on top of the attack
 * distribution, for a difference well inside the noise of everything else.
 */
export function readEffects(text: string): Partial<Modifiers> {
  const out: Partial<Modifiers> = {};
  const value = (raw: string | undefined, fallback = 1) => {
    const v = (raw ?? '').trim();
    if (!v) return fallback;
    if (/^d3$/i.test(v)) return 2;
    if (/^d6$/i.test(v)) return 4;
    return Number(v) || fallback;
  };

  // Rerolls. The narrower "of 1" wording has to be tested first, or the
  // broader pattern swallows it and reports a full reroll.
  if (/re-?roll (?:a |the )?hit rolls? of 1/i.test(text)) out.rerollHits = 'ones';
  else if (/re-?roll (?:the )?hit rolls?/i.test(text)) out.rerollHits = 'failures';

  if (/re-?roll (?:a |the )?wound rolls? of 1/i.test(text)) out.rerollWounds = 'ones';
  else if (/re-?roll (?:the )?wound rolls?/i.test(text)) out.rerollWounds = 'failures';

  if (/re-?roll (?:a |the )?damage rolls?/i.test(text)) out.rerollDamage = true;

  // Granted weapon abilities.
  const sustained = /\[?sustained hits\s*(\d+|d\d+)/i.exec(text);
  if (sustained) out.grantSustainedHits = value(sustained[1]);
  if (/\[lethal hits\]|\[?lethal hits\]?\s*ability/i.test(text)) out.grantLethalHits = true;
  if (/\[devastating wounds\]/i.test(text)) out.grantDevastatingWounds = true;
  if (/\[twin-?linked\]/i.test(text)) out.grantTwinLinked = true;
  if (/\[ignores cover\]/i.test(text)) out.grantIgnoresCover = true;

  // Roll modifiers.
  const addHit = /add (\d) to the hit roll/i.exec(text);
  if (addHit) out.hitModifier = Number(addHit[1]);
  const subHit = /subtract (\d) from the hit roll/i.exec(text);
  if (subHit) out.hitModifier = -Number(subHit[1]);

  const addWound = /add (\d) to the wound roll/i.exec(text);
  if (addWound) out.woundModifier = Number(addWound[1]);
  const subWound = /subtract (\d) from the wound roll/i.exec(text);
  if (subWound) out.woundModifier = -Number(subWound[1]);

  // Characteristic changes. The compound "Attacks and Strength" wording has
  // to be matched before either single form.
  const both = /add (\d) to the (?:attacks and strength|strength and attacks) characteristics?/i.exec(text);
  if (both) {
    out.attacksModifier = Number(both[1]);
    out.strengthModifier = Number(both[1]);
  } else {
    const addA = /add (\d) to the attacks characteristic/i.exec(text);
    if (addA) out.attacksModifier = Number(addA[1]);
    const addS = /add (\d) to the strength characteristic/i.exec(text);
    if (addS) out.strengthModifier = Number(addS[1]);
  }

  const addD = /add (\d) to the damage characteristic/i.exec(text);
  if (addD) out.damageModifier = Number(addD[1]);
  const ap = /improve the armou?r penetration characteristic[^.]{0,50}by (\d)/i.exec(text);
  if (ap) out.apModifier = Number(ap[1]);

  // "+2 A" shorthand, as used by Hail of Bolts.
  const shorthand = /\+(\d)\s*A\b/.exec(text);
  if (shorthand && out.attacksModifier == null) out.attacksModifier = Number(shorthand[1]);

  // Critical thresholds.
  const critHit = /unmodified hit rolls? of (\d)\+? .{0,40}critical hit/i.exec(text);
  if (critHit) out.critHitOn = Number(critHit[1]);
  const critWound = /unmodified wound rolls? of (\d)\+? .{0,40}critical wound/i.exec(text);
  if (critWound) out.critWoundOn = Number(critWound[1]);

  return out;
}

/** Pull target keywords out of an ability's wording. */
export function readTargetKeywords(text: string): { keywords: string[]; negated: boolean } {
  const negated = /\(excluding\s+[^)]*\)/i.test(text);
  const scope = negated ? (/\(excluding\s+([^)]*)\)/i.exec(text)?.[1] ?? '') : text;

  const found = new Set<string>();
  for (const keyword of KEYWORDS) {
    // Datasheets wrap keywords in emphasis markers, so match the bare word.
    const re = new RegExp(`\\b${keyword}\\b`, 'i');
    if (re.test(scope)) found.add(keyword);
  }
  return { keywords: [...found], negated };
}

/**
 * Whether a buff applies to this attack.
 *
 * Unconditional buffs always apply. Conditional ones need the target to carry
 * one of the named keywords — or, for "excluding" wordings, to carry none.
 */
export function buffApplies(
  buff: ConditionalBuff,
  targetKeywords: string[] | undefined,
  kind: 'melee' | 'ranged'
): boolean {
  if (buff.scope !== 'all' && buff.scope !== kind) return false;
  if (!buff.requiresTargetKeyword.length) return true;

  const have = new Set((targetKeywords ?? []).map((k) => k.toLowerCase()));
  const matches = buff.requiresTargetKeyword.some((k) => have.has(k.toLowerCase()));
  return buff.negated ? !matches : matches;
}

const REROLL_RANK = { none: 0, ones: 1, failures: 2, fishing: 3 } as const;

/**
 * Merge every buff that applies into one Modifiers object.
 *
 * Roll modifiers add up, because the engine caps the *total* — summing here
 * and clamping there is what lets a later -1 pull a stacked +2 back into
 * range. Everything else takes the strongest value.
 */
export function resolveBuffs(
  buffs: ConditionalBuff[],
  targetKeywords: string[] | undefined,
  kind: 'melee' | 'ranged'
): { modifiers: Partial<Modifiers>; applied: ConditionalBuff[] } {
  const out: Partial<Modifiers> = {};
  const applied: ConditionalBuff[] = [];

  for (const buff of buffs) {
    if (!buffApplies(buff, targetKeywords, kind)) continue;
    applied.push(buff);

    for (const [key, value] of Object.entries(buff.modifiers)) {
      const field = key as keyof Modifiers;

      if (field === 'hitModifier' || field === 'woundModifier') {
        out[field] = ((out[field] as number) ?? 0) + (value as number);
      } else if (field === 'grantSustainedHits') {
        // Core rule 24.02: duplicated weapon abilities are not cumulative --
        // the player selects one instance, so take the strongest.
        out.grantSustainedHits = Math.max(out.grantSustainedHits ?? 0, value as number);
      } else if (field === 'critHitOn' || field === 'critWoundOn') {
        out[field] = Math.min((out[field] as number) ?? 6, value as number);
      } else if (field === 'rerollHits' || field === 'rerollWounds') {
        const current = out[field];
        const next = value as Modifiers['rerollHits'];
        out[field] = !current
          ? next
          : REROLL_RANK[current] >= REROLL_RANK[next!]
            ? current
            : next;
      } else if (typeof value === 'number') {
        out[field] = Math.max((out[field] as number) ?? 0, value) as never;
      } else {
        out[field] = ((out[field] as unknown) || value) as never;
      }
    }
  }

  return { modifiers: out, applied };
}
