/**
 * Turn a leader's printed rules text into engine modifiers.
 *
 * Leaders are the main reason two identical squads perform differently, so the
 * matrix is misleading without them: a Terminator Squad led by a Librarian
 * gets Sustained Hits 1 on every weapon, and Bladeguard led by Adrax reroll
 * their melee wounds.
 *
 * The grammar is consistent enough to pattern-match. 11th-edition datasheets
 * almost always phrase it as:
 *
 *   "While this model is leading a unit, <effect on that unit>"
 *
 * Two design choices matter:
 *
 *   - **Scope.** Most buffs apply to melee or ranged only. Adrax's Unto the
 *     Anvil is melee-only, so applying it to shooting would overstate him.
 *   - **Anything unrecognised is reported, not discarded.** A silently ignored
 *     buff produces a confident, wrong number. Unparsed abilities come back in
 *     `unparsed` so the UI can say "this leader does something not accounted
 *     for" rather than pretending the leader is inert.
 */

import type { DataAbility, DataUnit } from './adapt';
import type { Modifiers } from './resolve';

/** Which attacks a buff applies to. */
export type BuffScope = 'melee' | 'ranged' | 'all';

export interface LeaderBuff {
  /** The ability it came from, for showing your working in the UI. */
  source: string;
  scope: BuffScope;
  modifiers: Partial<Modifiers>;
  /** Short human-readable summary, e.g. "Sustained Hits 1". */
  summary: string;
}

export interface LeaderEffects {
  buffs: LeaderBuff[];
  /** Abilities that clearly do something but could not be modelled. */
  unparsed: DataAbility[];
}

/**
 * Phrases that mark an ability as affecting the unit this model leads, rather
 * than the model itself or the wider army.
 */
const LEADING = /while (?:this model|the bearer) is leading|while this model leads|models in that unit|that unit has the|weapons equipped by models in that unit/i;

/** Melee-only and ranged-only wordings. */
const MELEE_ONLY = /\bmelee (?:attack|weapon)/i;
const RANGED_ONLY = /\branged (?:attack|weapon)/i;

function scopeOf(text: string): BuffScope {
  const melee = MELEE_ONLY.test(text);
  const ranged = RANGED_ONLY.test(text);
  if (melee && !ranged) return 'melee';
  if (ranged && !melee) return 'ranged';
  return 'all';
}

/** "D3" averages 2, "D6" averages 4. */
function value(raw: string | undefined, fallback = 1): number {
  const text = (raw ?? '').trim();
  if (!text) return fallback;
  if (/^d3$/i.test(text)) return 2;
  if (/^d6$/i.test(text)) return 4;
  return Number(text) || fallback;
}

/**
 * Each rule is a pattern plus what it means. Ordered loosely by specificity --
 * a full reroll must be recognised before the narrower "reroll 1s" wording.
 */
const RULES: Array<{
  match: RegExp;
  build: (m: RegExpExecArray) => { modifiers: Partial<Modifiers>; summary: string };
}> = [
  // --- granted weapon abilities ------------------------------------------
  {
    match: /\[?sustained hits\s*(\d+|d\d+)\]?/i,
    build: (m) => ({
      modifiers: { grantSustainedHits: value(m[1]) },
      summary: `Sustained Hits ${value(m[1])}`,
    }),
  },
  {
    match: /\[?lethal hits\]?/i,
    build: () => ({ modifiers: { grantLethalHits: true }, summary: 'Lethal Hits' }),
  },
  {
    match: /\[?devastating wounds\]?/i,
    build: () => ({ modifiers: { grantDevastatingWounds: true }, summary: 'Devastating Wounds' }),
  },
  {
    match: /\[?twin-?linked\]?/i,
    build: () => ({ modifiers: { grantTwinLinked: true }, summary: 'Twin-linked' }),
  },
  {
    match: /\[?ignores cover\]?/i,
    build: () => ({ modifiers: { grantIgnoresCover: true }, summary: 'Ignores Cover' }),
  },

  // --- rerolls ------------------------------------------------------------
  {
    // "you can re-roll the Hit roll" with no qualifier is a full reroll.
    match: /re-?roll (?:the )?hit rolls?(?!\s+of)/i,
    build: () => ({ modifiers: { rerollHits: 'failures' }, summary: 'reroll Hit rolls' }),
  },
  {
    match: /re-?roll (?:a |the )?hit rolls? of 1/i,
    build: () => ({ modifiers: { rerollHits: 'ones' }, summary: 'reroll Hit rolls of 1' }),
  },
  {
    // "You can re-roll the Wound roll" is read as rerolling failures.
    //
    // Strictly, an unqualified reroll permission also allows throwing back a
    // *successful* non-critical wound to hunt for a 6, which is worth doing
    // with Devastating Wounds on the weapon. That is a deliberate play rather
    // than what a leader's buff implies, so it is not assumed here -- the
    // player opts into it with the "Any roll" reroll setting.
    match: /re-?roll (?:the )?wound rolls?(?!\s+of)/i,
    build: () => ({ modifiers: { rerollWounds: 'failures' }, summary: 'reroll Wound rolls' }),
  },
  {
    match: /re-?roll (?:a |the )?wound rolls? of 1/i,
    build: () => ({ modifiers: { rerollWounds: 'ones' }, summary: 'reroll Wound rolls of 1' }),
  },

  // --- roll modifiers -----------------------------------------------------
  {
    match: /add (\d) to the hit roll/i,
    build: (m) => ({ modifiers: { hitModifier: Number(m[1]) }, summary: `+${m[1]} to Hit` }),
  },
  {
    match: /subtract (\d) from the hit roll/i,
    build: (m) => ({ modifiers: { hitModifier: -Number(m[1]) }, summary: `-${m[1]} to Hit` }),
  },
  {
    match: /add (\d) to the wound roll/i,
    build: (m) => ({ modifiers: { woundModifier: Number(m[1]) }, summary: `+${m[1]} to Wound` }),
  },
  {
    match: /subtract (\d) from the wound roll/i,
    build: (m) => ({ modifiers: { woundModifier: -Number(m[1]) }, summary: `-${m[1]} to Wound` }),
  },

  // --- characteristic modifiers ------------------------------------------
  {
    // Compound wording: "add 1 to the Attacks and Strength characteristic".
    match: /add (\d) to the attacks and strength characteristics?/i,
    build: (m) => ({
      modifiers: { attacksModifier: Number(m[1]), strengthModifier: Number(m[1]) },
      summary: `+${m[1]} Attack and Strength`,
    }),
  },
  {
    match: /add (\d) to the strength and attacks characteristics?/i,
    build: (m) => ({
      modifiers: { strengthModifier: Number(m[1]), attacksModifier: Number(m[1]) },
      summary: `+${m[1]} Attack and Strength`,
    }),
  },
  {
    match: /add (\d) to the attacks characteristic/i,
    build: (m) => ({ modifiers: { attacksModifier: Number(m[1]) }, summary: `+${m[1]} Attack` }),
  },
  {
    match: /add (\d) to the strength characteristic/i,
    build: (m) => ({ modifiers: { strengthModifier: Number(m[1]) }, summary: `+${m[1]} Strength` }),
  },
  {
    match: /add (\d) to the damage characteristic/i,
    build: (m) => ({ modifiers: { damageModifier: Number(m[1]) }, summary: `+${m[1]} Damage` }),
  },
  {
    match: /improve the armou?r penetration characteristic[^.]{0,40}by (\d)/i,
    build: (m) => ({ modifiers: { apModifier: Number(m[1]) }, summary: `+${m[1]} AP` }),
  },

  // --- critical thresholds -------------------------------------------------
  {
    match: /unmodified hit rolls? of (\d)\+? .{0,30}critical hit/i,
    build: (m) => ({ modifiers: { critHitOn: Number(m[1]) }, summary: `critical hits on ${m[1]}+` }),
  },
  {
    match: /unmodified wound rolls? of (\d)\+? .{0,30}critical wound/i,
    build: (m) => ({
      modifiers: { critWoundOn: Number(m[1]) },
      summary: `critical wounds on ${m[1]}+`,
    }),
  },
];

/**
 * Abilities that affect the led unit but never the damage it deals, so they
 * are neither a buff nor a gap worth reporting.
 */
const NOT_DAMAGE = new RegExp(
  [
    // Not about damage at all.
    'fights first',
    'objective control',
    'battle-?shock',
    'leadership',
    'advance',
    'fall back',
    'deep strike',
    'scouts',
    'sticky',
    'cannot be',
    're-?roll (?:the )?(?:charge|advance)',
    'add \\d+"? to the range characteristic',
    '\\[(?:assault|heavy|pistol|indirect fire)\\]',
    // Defender-side effects on the led unit. Real, but expressed through the
    // target's own profile and the cover toggle rather than as attacker buffs,
    // so reporting them as gaps would be noise.
    'benefit of cover',
    'stealth',
    'feel no pain',
    'invulnerable save',
    'subtract \\d from the damage characteristic',
    'add \\d to the toughness characteristic',
  ].join('|'),
  'i'
);

/** Read one ability into zero or more buffs. */
function parseAbility(ability: DataAbility): LeaderBuff[] {
  const text = ability.text ?? '';
  if (!LEADING.test(text)) return [];

  const scope = scopeOf(text);
  const buffs: LeaderBuff[] = [];

  for (const rule of RULES) {
    const match = rule.match.exec(text);
    if (!match) continue;
    const { modifiers, summary } = rule.build(match);

    // A later, narrower rule can supersede an earlier one for the same key
    // (a "reroll 1s" wording also matches the broader reroll pattern).
    const key = Object.keys(modifiers)[0];
    const existing = buffs.findIndex((b) => Object.keys(b.modifiers)[0] === key);
    if (existing >= 0) buffs[existing] = { source: ability.name, scope, modifiers, summary };
    else buffs.push({ source: ability.name, scope, modifiers, summary });
  }

  return buffs;
}

/**
 * Read every leading-conditional ability on a unit.
 *
 * Abilities that clearly affect the led unit but match no rule are returned in
 * `unparsed`, so the UI can flag them instead of silently under-counting.
 */
export function readLeaderEffects(leader: DataUnit): LeaderEffects {
  const buffs: LeaderBuff[] = [];
  const unparsed: DataAbility[] = [];

  for (const ability of leader.abilities ?? []) {
    const text = ability.text ?? '';
    if (!LEADING.test(text)) continue;

    const parsed = parseAbility(ability);
    if (parsed.length) {
      buffs.push(...parsed);
    } else if (!NOT_DAMAGE.test(text)) {
      unparsed.push(ability);
    }
  }

  return { buffs, unparsed };
}

/**
 * Collapse the buffs that apply to a given kind of attack into one Modifiers
 * object.
 *
 * Roll modifiers add together (the engine caps the total), granted Sustained
 * Hits add, and everything else takes the strongest value.
 */
export function buffsFor(effects: LeaderEffects, kind: 'melee' | 'ranged'): Partial<Modifiers> {
  const out: Partial<Modifiers> = {};

  for (const buff of effects.buffs) {
    if (buff.scope !== 'all' && buff.scope !== kind) continue;

    for (const [key, value] of Object.entries(buff.modifiers)) {
      const field = key as keyof Modifiers;

      if (field === 'hitModifier' || field === 'woundModifier') {
        out[field] = ((out[field] as number) ?? 0) + (value as number);
      } else if (field === 'grantSustainedHits') {
        // Core rule 24.02: duplicated weapon abilities are not cumulative.
        out.grantSustainedHits = Math.max(out.grantSustainedHits ?? 0, value as number);
      } else if (field === 'critHitOn' || field === 'critWoundOn') {
        out[field] = Math.min((out[field] as number) ?? 6, value as number);
      } else if (field === 'rerollHits' || field === 'rerollWounds') {
        out[field] = strongerReroll(out[field], value as Modifiers['rerollHits']);
      } else {
        // Characteristic bonuses and granted booleans: take the best.
        const current = out[field];
        if (typeof value === 'number') {
          out[field] = Math.max((current as number) ?? 0, value) as never;
        } else {
          out[field] = (current || value) as never;
        }
      }
    }
  }

  return out;
}

const REROLL_RANK = { none: 0, ones: 1, failures: 2, fishing: 3 } as const;

function strongerReroll(
  a: Modifiers['rerollHits'],
  b: Modifiers['rerollHits']
): Modifiers['rerollHits'] {
  if (!a) return b;
  if (!b) return a;
  return REROLL_RANK[a] >= REROLL_RANK[b] ? a : b;
}
