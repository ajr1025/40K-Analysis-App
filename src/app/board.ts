/**
 * The board: what is on it, and what each cell works out to.
 *
 * Cells are computed on demand rather than precomputed. The alternative --
 * enumerating unit x loadout x detachment x buffs x target -- is not a large
 * table, it is an unbounded one, and it would go stale the moment a datasheet
 * changed. A full 12x21 board resolves in about 17ms, and editing one unit's
 * loadout only dirties that unit's row.
 */

import { type DataUnit, toTarget } from '../engine/adapt';
import type { Distribution } from '../engine/dice';
import { type ConditionalBuff, resolveBuffs } from '../engine/conditions';
import { type Detachment, detachmentBuffs } from '../engine/detachments';
import { type Attachment, attachedEffects, attachedPoints } from '../engine/attachment';
import {
  type Modifiers,
  type Target,
  pointsDestroyed,
  pointsEfficiency,
  resolveLoadout,
} from '../engine/resolve';
import { type SelfBuff, automaticBuffs, readSelfBuffs } from '../engine/selfbuffs';
import {
  type Loadout,
  chooseModes,
  defaultLoadout,
  loadoutEntries,
  loadoutIsAssumed,
  loadoutSize,
  validateLoadout,
} from '../engine/wargear';
import type { LoadoutEntry } from '../engine/resolve';
import type { Faction } from './data';

export type WeaponScope = 'all' | 'ranged' | 'melee';

/** An attacker as configured on the board. */
export interface Attacker {
  id: string;
  unit: DataUnit;
  faction: Faction;
  loadout: Loadout;
  /** Optional character leading the unit. */
  leader: DataUnit | null;
  /** Self-buff and detachment rules the player has switched on. */
  enabled: string[];
  /**
   * How many models carry each weapon, keyed by weapon name.
   *
   * The variant builder can only express what the source records, and for most
   * single-model datasheets it records nothing — a Redemptor ends up holding
   * both of its main guns because BSData never says they are alternatives. So
   * every weapon also gets a direct count, which wins wherever it is set. The
   * player knows what is on the model; the data often does not.
   */
  weapons: Record<string, number>;
}

export interface TargetEntry {
  id: string;
  unit: DataUnit;
  faction: Faction;
  target: Target;
  points: number;
}

export interface Cell {
  /** Points destroyed divided by points spent, as a percentage. */
  efficiency: number;
  /** Uncapped, so overkill stays visible. */
  damage: number;
  modelsSlain: number;
  /** Probability the target unit is wiped out. */
  wipeChance: number;
  pointsDestroyed: number;
  /** Abilities that actually fired against this target. */
  applied: string[];
  /** What the unit is holding, as model counts. */
  loadout: string;
  /** Exact distribution over models slain, for the detail chart. */
  modelsSlainDistribution: Distribution;
}

/** Points for a given model count, from the MFM tiers. */
export function pointsFor(unit: DataUnit, models: number): number {
  const tiers = unit.points ?? [];
  if (!tiers.length) return unit.basePoints ?? 0;
  const exact = tiers.find((t) => t.models === models);
  if (exact) return exact.points;
  // Between tiers, charge the largest tier the squad has reached.
  const below = tiers.filter((t) => t.models <= models).sort((a, b) => b.models - a.models)[0];
  return below?.points ?? tiers[0].points;
}

export function makeAttacker(unit: DataUnit, faction: Faction, id: string): Attacker {
  return {
    id,
    unit,
    faction,
    loadout: defaultLoadout(unit),
    leader: null,
    enabled: [],
    weapons: {},
  };
}

export function makeTarget(unit: DataUnit, faction: Faction, id: string): TargetEntry | null {
  const target = toTarget(unit);
  if (!target) return null;
  return { id, unit, faction, target, points: pointsFor(unit, target.models) };
}

/** Buffs the unit contributes on its own, split into automatic and optional. */
export function unitBuffs(attacker: Attacker): { automatic: SelfBuff[]; optional: SelfBuff[] } {
  const buffs = readSelfBuffs(attacker.unit).buffs;
  const automatic = automaticBuffs(buffs);
  return { automatic, optional: buffs.filter((b) => !automatic.includes(b)) };
}

/** Everything a cell needs that does not depend on the target. */
export interface AttackerContext {
  models: number;
  points: number;
  buffs: ConditionalBuff[];
  entries: ReturnType<typeof loadoutEntries>;
  problems: ReturnType<typeof validateLoadout>;
  assumedLoadout: boolean;
  unmodelled: string[];
  label: string;
}

export function attackerContext(
  attacker: Attacker,
  detachment: Detachment | null,
  scope: WeaponScope,
  /**
   * The army rule in play. Nearly all of them are conditional — a nominated
   * target, an active vow, a called Waaagh! — so choosing one in the toolbar
   * is the player asserting the condition is met, the same way half range is.
   */
  armyRule: ConditionalBuff | null = null
): AttackerContext {
  const kind = scope === 'all' ? undefined : scope;
  const size = loadoutSize(attacker.loadout);
  const leader = attacker.leader;

  // Composed rather than handed to `attachedLoadout`, which resolves a single
  // firing mode. Every mode is kept here and narrowed per target below: krak
  // or frag, standard or supercharge, is decided when the trigger is pulled,
  // and a leader's plasma pistol deserves that choice as much as the squad's.
  const entries = applyWeaponCounts(
    [
      ...loadoutEntries(attacker.unit, attacker.loadout, kind, true),
      ...(leader ? loadoutEntries(leader, defaultLoadout(leader), kind, true) : []),
    ],
    attacker
  );

  const self = readSelfBuffs(attacker.unit);
  let buffs: ConditionalBuff[];
  let unmodelled: string[];

  if (leader) {
    // Attached, the two datasheets buff each other, so the pairing is resolved
    // as one unit rather than as a squad with an add-on.
    const attachment: Attachment = { leader, bodyguard: attacker.unit };
    const include = { optional: attacker.enabled };
    const melee = attachedEffects(attachment, 'melee', include);
    const ranged = attachedEffects(attachment, 'ranged', include);
    // Each buff carries its own scope, so `resolveBuffs` picks the right ones
    // per weapon; the union is what the combined unit brings.
    buffs = [...melee.buffs, ...ranged.buffs];
    unmodelled = [...new Set([...melee.unmodelled, ...ranged.unmodelled])];
  } else {
    const automatic = automaticBuffs(self.buffs);
    const chosen = new Set(attacker.enabled);
    buffs = [
      ...automatic,
      ...self.buffs.filter((b) => !automatic.includes(b) && chosen.has(b.source)),
    ];
    unmodelled = self.unparsed.map((a) => a.name);
  }

  buffs = [...buffs, ...detachmentBuffs(detachment, attacker.enabled)];
  if (armyRule) buffs = [...buffs, armyRule];

  const squadPoints = pointsFor(attacker.unit, size);
  const combined = leader ? attachedPoints({ leader, bodyguard: attacker.unit }) : null;

  return {
    models: size + (leader ? 1 : 0),
    // `attachedPoints` uses each datasheet's base cost; a squad priced by size
    // needs its own tier, so the leader's cost is added to that instead.
    points: leader ? squadPoints + (combined != null ? combined - (attacker.unit.basePoints ?? 0) : 0) : squadPoints,
    buffs,
    entries,
    problems: validateLoadout(attacker.unit, attacker.loadout),
    assumedLoadout: loadoutIsAssumed(attacker.unit),
    unmodelled,
    label: loadoutLabel(attacker),
  };
}


/**
 * Apply the player's per-weapon counts over whatever the wargear tree produced.
 *
 * A weapon set to zero drops out entirely, which is how you take the second
 * main gun off a Dreadnought. Firing modes share one count, since they are one
 * weapon fired one way or the other.
 */
function applyWeaponCounts(entries: LoadoutEntry[], attacker: Attacker): LoadoutEntry[] {
  const counts = attacker.weapons;
  if (!Object.keys(counts).length) return entries;

  return entries
    .map((entry) => {
      const override = counts[weaponKey(entry.weapon.name)];
      return override === undefined ? entry : { ...entry, models: override };
    })
    .filter((entry) => entry.models > 0);
}

/** "Cyclone missile launcher - krak" and "- frag" are one weapon. */
export function weaponKey(name: string): string {
  return name.replace(/\s+-\s+[^-]*$/, '').trim();
}

/** What the unit is actually holding, as counts of each weapon. */
export function loadoutLabel(attacker: Attacker): string {
  const counts = new Map<string, number>();
  for (const entry of applyWeaponCounts(
    loadoutEntries(attacker.unit, attacker.loadout),
    attacker
  )) {
    if (/close combat weapon/i.test(entry.weapon.name)) continue;
    // The firing mode is a per-target decision, not part of the build.
    const name = entry.weapon.name.replace(/\s+-\s+[^-]*$/, '').trim();
    counts.set(name, (counts.get(name) ?? 0) + entry.models);
  }
  if (!counts.size) return '—';

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${n}× ${name}`)
    .join(', ');
}


const REROLL_RANK = { none: 0, ones: 1, failures: 2, fishing: 3 } as const;

/**
 * Combine the player's modifiers with the ones the unit's own rules supply.
 *
 * Spreading one over the other let whichever came last win, which quietly
 * discarded the player's choice: an Eradicator squad already re-rolling
 * against vehicles ignored every re-roll setting in the drawer, because its
 * own ability landed on top. Rule 24.02 says duplicated abilities are not
 * cumulative and the player picks which applies, so the stronger of the two
 * is taken rather than the later one.
 */
export function mergeModifiers(
  player: Modifiers,
  fromRules: Partial<Modifiers>,
  melee: boolean,
  perWeapon: Modifiers | undefined
): Modifiers {
  const out: Modifiers = { ...player, ...fromRules };

  for (const field of ['rerollHits', 'rerollWounds'] as const) {
    const a = player[field];
    const b = fromRules[field];
    if (a && b) out[field] = REROLL_RANK[a] >= REROLL_RANK[b] ? a : b;
    else out[field] = a ?? b;
  }

  // Melee-only attack bonuses land on melee weapons and nowhere else.
  if (melee) {
    out.attacksModifier =
      (player.attacksModifier ?? 0) +
      (player.meleeAttacksModifier ?? 0) +
      (fromRules.attacksModifier ?? 0);
  }

  return { ...out, ...perWeapon };
}

export function computeCell(
  context: AttackerContext,
  entry: TargetEntry,
  modifiers: Modifiers
): Cell {
  const melee = resolveBuffs(context.buffs, entry.target.keywords, 'melee');
  const ranged = resolveBuffs(context.buffs, entry.target.keywords, 'ranged');

  const perEntry = chooseModes(
    context.entries.map((e) => ({
      ...e,
      modifiers: mergeModifiers(
        modifiers,
        e.weapon.melee ? melee.modifiers : ranged.modifiers,
        e.weapon.melee === true,
        e.modifiers
      ),
    })),
    entry.target,
    modifiers
  );

  const result = resolveLoadout(perEntry, entry.target, {
    ...modifiers,
    attackingModels: context.models,
  });

  if (!result) {
    return {
      efficiency: 0,
      damage: 0,
      modelsSlain: 0,
      wipeChance: 0,
      pointsDestroyed: 0,
      applied: [],
      loadout: context.label,
      modelsSlainDistribution: new Map(),
    };
  }

  return {
    efficiency: pointsEfficiency(result, entry.target, entry.points, context.points) * 100,
    damage: result.totalDamage,
    modelsSlain: result.expectedModelsSlain,
    wipeChance: result.probabilityDestroyed * 100,
    pointsDestroyed: pointsDestroyed(result, entry.target, entry.points),
    applied: [...new Set([...melee.applied, ...ranged.applied].map((b) => b.source))],
    loadout: context.label,
    modelsSlainDistribution: result.modelsSlainDistribution,
  };
}

/**
 * Targets read lowest toughness first, then by save.
 *
 * Warp Spiders sit above Cadians at the same toughness because a 3+ save makes
 * them a different problem to shoot at.
 */
export function sortTargets(entries: TargetEntry[]): TargetEntry[] {
  return [...entries].sort(
    (a, b) =>
      a.target.toughness - b.target.toughness ||
      a.target.save - b.target.save ||
      a.unit.name.localeCompare(b.unit.name)
  );
}
