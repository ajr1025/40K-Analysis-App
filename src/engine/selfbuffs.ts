/**
 * Abilities a unit applies to its own attacks.
 *
 * This is the largest category of unmodelled damage in the game and the one
 * that most distorts comparisons. Eradicators reroll hits, wounds *and*
 * damage against Monsters and Vehicles — the entire reason the unit exists —
 * and without it they read as mediocre anti-tank. Intercessors get +2 Attacks
 * on their bolt rifles, doubling the profile. Neither is a leader buff, so the
 * leader parser never saw them.
 *
 * Two things make this harder than the leader case:
 *
 *  1. **Datasheets phrase it both ways round.** "each time a model in this
 *     unit makes an attack…" and "each time a ranged attack made by a model in
 *     this unit targets…". Matching only the first misses Eradicators
 *     entirely, and an empty result looks like a unit with no abilities rather
 *     than a broken parser.
 *
 *  2. **Most are conditional.** Some resolve automatically from the target
 *     (Monster/Vehicle); others depend on the situation (half range, remained
 *     stationary, spending a token) and can only be a toggle the player sets.
 *     Applying those unconditionally would overstate every unit that has one.
 */

import type { DataAbility, DataUnit } from './adapt';
import { type ConditionalBuff, readEffects, readTargetKeywords } from './conditions';
import type { BuffScope } from './leaders';

/** What has to be true for a self-buff to apply. */
export type Trigger =
  | 'always'
  | 'target-keyword'
  | 'half-range'
  | 'charged'
  | 'stationary'
  | 'situational';

export interface SelfBuff extends ConditionalBuff {
  trigger: Trigger;
  /** The wording that made it conditional, for the UI to show. */
  condition?: string;
}

export interface SelfBuffs {
  buffs: SelfBuff[];
  /** Affects this unit's attacks but could not be modelled. */
  unparsed: DataAbility[];
}

/** Phrases marking an ability as acting on this unit's own attacks. */
const SELF =
  /each time[^.]{0,110}\bmodels? in this unit\b|each time this (?:model|unit) (?:makes|is selected)|(?:ranged |melee )?weapons equipped by models in this unit have|this unit['’]s [^.]{0,40}attacks/i;

/** Army-wide rules that sit on every datasheet; they belong to a selector. */
const ARMY_RULE =
  /^(oath of moment|templar vows|battle focus|reanimation protocols|for the greater good|combat doctrines|waaagh!?)$/i;

/** Wordings that make an ability depend on something only the player knows. */
const TRIGGERS: Array<[Trigger, RegExp]> = [
  ['half-range', /within half range/i],
  ['charged', /\bcharged\b|made a charge move|ends a charge move/i],
  ['stationary', /remained stationary|did not move/i],
  [
    'situational',
    // "While this model has 1-4 wounds remaining ... subtract 1 from the Hit
    // roll" is a real attack modifier, but it depends on the vehicle already
    // being damaged. Matching only "while this unit is" left it unconditional,
    // so every vehicle in the matrix attacked at -1 to hit while at full
    // wounds. Situational, not excluded: modelling a damaged vehicle is a
    // thing a player may legitimately want to do.
    /once per battle|at the start of|until the end|if this unit|if that unit|you can spend|pain token|select one|while this (?:model|unit) (?:is|has)|wounds remaining|in your (?:command|shooting|fight|movement) phase|is empowered|battle-?shock/i,
  ],
];

function scopeOf(text: string): BuffScope {
  const melee = /\bmelee (?:attack|weapon)/i.test(text);
  const ranged = /\branged (?:attack|weapon)/i.test(text);
  if (melee && !ranged) return 'melee';
  if (ranged && !melee) return 'ranged';
  return 'all';
}

function triggerOf(text: string, hasKeywords: boolean): { trigger: Trigger; condition?: string } {
  for (const [trigger, pattern] of TRIGGERS) {
    const match = pattern.exec(text);
    if (match) return { trigger, condition: match[0] };
  }
  return { trigger: hasKeywords ? 'target-keyword' : 'always' };
}

/**
 * Abilities that mention this unit but do not modify its attacks.
 *
 * Without this the "unmodelled" list fills with noise and buries the real
 * gaps: Deadly Demise (672 instances) triggers when a model is *destroyed*,
 * and Deep Strike (322) is deployment — both match the "models in this unit"
 * phrasing while having nothing to do with damage dealt.
 */
const NOT_DAMAGE = new RegExp(
  [
    'is destroyed',
    'deadly demise',
    'ingress move',
    'set up anywhere',
    'deep strike',
    'fights first',
    'objective control',
    'objective marker',
    'battle-?shock',
    'leadership',
    'advance',
    'fall back',
    'scouts',
    'stealth',
    'benefit of cover',
    'feel no pain',
    'invulnerable save',
    'precision',
    'hazard',
    'cannot be',
    'is eligible',
    'charge rolls?',
    'command point',
    'stratagem',
  ].join('|'),
  'i'
);

/** Ability names that are never attack buffs, whatever their text says. */
const NOT_DAMAGE_NAME = /^(deep strike|deadly demise|scouts|infiltrators|stealth|lone operative|fights first|firing deck)/i;

/**
 * Read a unit's own damage-affecting abilities.
 *
 * Anything that clearly acts on this unit's attacks but matches no rule comes
 * back in `unparsed` rather than being dropped, so the UI can say the number
 * is incomplete instead of quietly presenting it as whole.
 */
export function readSelfBuffs(unit: DataUnit): SelfBuffs {
  const buffs: SelfBuff[] = [];
  const unparsed: DataAbility[] = [];

  for (const ability of unit.abilities ?? []) {
    const text = ability.text ?? '';
    if (ARMY_RULE.test(ability.name ?? '')) continue;
    if (!SELF.test(text)) continue;

    if (NOT_DAMAGE_NAME.test(ability.name ?? '')) continue;

    const modifiers = readEffects(text);
    if (!Object.keys(modifiers).length) {
      if (!NOT_DAMAGE.test(text)) unparsed.push(ability);
      continue;
    }

    const { keywords, negated } = readTargetKeywords(text);
    const { trigger, condition } = triggerOf(text, keywords.length > 0);

    buffs.push({
      source: ability.name ?? '',
      scope: scopeOf(text),
      requiresTargetKeyword: keywords,
      negated,
      modifiers,
      summary: describe(modifiers),
      trigger,
      condition,
    });
  }

  return { buffs, unparsed };
}

/**
 * Buffs that apply without the player having to assert anything.
 *
 * Target-keyword conditions resolve from the target itself, so they are safe
 * to apply automatically; everything else defaults to off and is offered as a
 * toggle. The alternative — assuming every unit is always in half range and
 * always charged — flatters units with situational abilities.
 */
export function automaticBuffs(buffs: SelfBuff[]): SelfBuff[] {
  return buffs.filter((b) => b.trigger === 'always' || b.trigger === 'target-keyword');
}

/** Buffs the player must switch on, with the wording that gates them. */
export function optionalBuffs(buffs: SelfBuff[]): SelfBuff[] {
  return buffs.filter((b) => b.trigger !== 'always' && b.trigger !== 'target-keyword');
}

function describe(modifiers: Record<string, unknown>): string {
  const parts: string[] = [];
  const say = (k: string, v: unknown) => {
    switch (k) {
      case 'rerollHits': return `reroll hits (${v})`;
      case 'rerollWounds': return `reroll wounds (${v})`;
      case 'rerollDamage': return 'reroll damage';
      case 'grantSustainedHits': return `Sustained Hits ${v}`;
      case 'grantLethalHits': return 'Lethal Hits';
      case 'grantDevastatingWounds': return 'Devastating Wounds';
      case 'grantTwinLinked': return 'Twin-linked';
      case 'grantIgnoresCover': return 'Ignores Cover';
      case 'hitModifier': return `${(v as number) > 0 ? '+' : ''}${v} to Hit`;
      case 'woundModifier': return `${(v as number) > 0 ? '+' : ''}${v} to Wound`;
      case 'attacksModifier': return `+${v} Attacks`;
      case 'strengthModifier': return `+${v} Strength`;
      case 'damageModifier': return `+${v} Damage`;
      case 'apModifier': return `+${v} AP`;
      case 'critHitOn': return `crit hits on ${v}+`;
      case 'critWoundOn': return `crit wounds on ${v}+`;
      default: return `${k}=${v}`;
    }
  };
  for (const [k, v] of Object.entries(modifiers)) parts.push(say(k, v));
  return parts.join(', ');
}
