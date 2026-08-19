/**
 * Leaders attached to a bodyguard unit.
 *
 * When a leader joins a unit it becomes *a model in that unit*, and that makes
 * buffs flow both ways:
 *
 *  - the leader's "while this model is leading a unit" abilities apply to the
 *    whole squad, which is the obvious direction; and
 *  - the squad's own abilities apply to the leader, which is the direction
 *    that gets missed. Asurmen joining Dire Avengers picks up Bladestorm, so
 *    his shooting gains Sustained Hits 1 in half range — nothing on his own
 *    datasheet says so.
 *
 * The combined unit is also a single points cost for efficiency, which is what
 * makes attachment worth modelling at all: a 135-point Asurmen bolted to a
 * 75-point squad has to earn 210 points back, not 135.
 */

import { type DataUnit, toWeapon } from './adapt';
import { type ConditionalBuff, resolveBuffs } from './conditions';
import { buffsFor, readLeaderEffects } from './leaders';
import { type SelfBuff, automaticBuffs, optionalBuffs, readSelfBuffs } from './selfbuffs';
import type { Modifiers } from './resolve';
import { type Loadout, defaultLoadout, loadoutEntries } from './wargear';
import type { LoadoutEntry } from './resolve';

export interface Attachment {
  leader: DataUnit;
  bodyguard: DataUnit;
}

/** Does the datasheet allow this pairing? */
export function canAttach(leader: DataUnit, bodyguard: DataUnit): boolean {
  const allowed = (leader.attachTo ?? []).map((n) => n.toLowerCase().trim());
  return allowed.includes(bodyguard.name.toLowerCase().trim());
}

/** Every unit in a pool this leader may join. */
export function attachableTo(leader: DataUnit, pool: DataUnit[]): DataUnit[] {
  if (!(leader.attachTo ?? []).length) return [];
  return pool.filter((u) => canAttach(leader, u));
}

export interface AttachedEffects {
  /** Everything applying to the combined unit's attacks of this kind. */
  buffs: ConditionalBuff[];
  /** Situational ones, off until the player switches them on. */
  optional: SelfBuff[];
  /** Abilities that affect the pairing but could not be modelled. */
  unmodelled: string[];
}

/**
 * Collect the buffs acting on an attached unit.
 *
 * `include` decides whether the situational ones are live; they stay off by
 * default for the same reason as anywhere else — assuming a unit is always in
 * half range and always charged flatters everything that has such an ability.
 */
export function attachedEffects(
  attachment: Attachment,
  kind: 'melee' | 'ranged',
  include: { optional?: string[] } = {}
): AttachedEffects {
  const { leader, bodyguard } = attachment;
  const wanted = new Set(include.optional ?? []);

  // What the leader grants the unit it leads.
  const leaderEffects = readLeaderEffects(leader);
  const granted = buffsFor(leaderEffects, kind);
  const grantedBuff: ConditionalBuff[] = Object.keys(granted).length
    ? [{
        source: leaderEffects.buffs.map((b) => b.source).join(', ') || leader.name,
        scope: kind,
        requiresTargetKeyword: [],
        modifiers: granted,
        summary: leaderEffects.buffs.map((b) => b.summary).join(', '),
      }]
    : [];

  // The squad's own abilities — which now cover the leader too.
  const squad = readSelfBuffs(bodyguard);
  // And the leader's own, which now cover the squad.
  const own = readSelfBuffs(leader);

  const pool = [...squad.buffs, ...own.buffs];
  const live = [
    ...automaticBuffs(pool),
    ...optionalBuffs(pool).filter((b) => wanted.has(b.source)),
  ];

  return {
    buffs: [...grantedBuff, ...live],
    optional: optionalBuffs(pool),
    unmodelled: [
      ...leaderEffects.unparsed.map((a) => `${leader.name}: ${a.name}`),
      ...squad.unparsed.map((a) => `${bodyguard.name}: ${a.name}`),
      ...own.unparsed.map((a) => `${leader.name}: ${a.name}`),
    ],
  };
}

/** Merged modifiers for one kind of attack against a particular target. */
export function attachedModifiers(
  attachment: Attachment,
  target: { keywords?: string[] },
  kind: 'melee' | 'ranged',
  include: { optional?: string[] } = {}
): { modifiers: Partial<Modifiers>; applied: string[]; unmodelled: string[] } {
  const effects = attachedEffects(attachment, kind, include);
  const { modifiers, applied } = resolveBuffs(effects.buffs, target.keywords, kind);
  return {
    modifiers,
    applied: applied.map((b) => b.source),
    unmodelled: effects.unmodelled,
  };
}

/** Combined points, which is what the efficiency score has to pay back. */
export function attachedPoints(attachment: Attachment): number | null {
  const a = attachment.leader.basePoints;
  const b = attachment.bodyguard.basePoints;
  return a == null || b == null ? null : a + b;
}

/**
 * Weapons fired by the combined unit: the squad's loadout plus the leader's.
 *
 * The leader is one more model in the unit, carrying its own guns, so its
 * profiles are added rather than replacing anything.
 */
export function attachedLoadout(
  attachment: Attachment,
  kind: 'ranged' | 'melee',
  loadouts?: { leader?: Loadout; bodyguard?: Loadout }
): LoadoutEntry[] {
  const { leader, bodyguard } = attachment;
  const squad = loadouts?.bodyguard ?? defaultLoadout(bodyguard);
  const boss = loadouts?.leader ?? defaultLoadout(leader);

  const squadEntries = loadoutEntries(bodyguard, squad, kind);
  let leaderEntries = loadoutEntries(leader, boss, kind);

  // Most leaders are a single model with no variant groups, so the wargear
  // tree yields nothing for them. Fall back to the profiles on the datasheet.
  if (!leaderEntries.length) {
    leaderEntries = leader.weapons
      .filter((w) => w.kind === kind)
      .map((w) => ({ weapon: toWeapon(w), models: 1 }))
      .filter((e): e is LoadoutEntry => e.weapon !== null) as LoadoutEntry[];
  }

  return [...squadEntries, ...leaderEntries];
}
