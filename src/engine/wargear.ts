/**
 * Building legal loadouts from a unit's wargear tree.
 *
 * The flat weapon list on a datasheet is a menu, not an inventory. A
 * Sternguard squad lists a Pyrecannon, but only one model may carry it; an
 * Intercessor squad lists a grenade launcher, but at most two models take it —
 * and those models keep their bolt rifles. Letting a user assign five
 * Pyrecannons produces a confident number for a unit that cannot be fielded.
 *
 * So loadouts are expressed the way the datasheet is: counts of model
 * variants, each with its choice slots resolved. The weapons fall out of that.
 */

import type { DataUnit, DataWeapon } from './adapt';
import { defaultModelCount, toWeapon } from './adapt';
import type { LoadoutEntry, Modifiers, Target } from './resolve';
import { resolveAttack } from './resolve';

/** A cap that changes once the squad reaches a given size. */
export interface MaxRule {
  when: 'atLeast' | 'equalTo' | 'lessThan' | 'greaterThan';
  models: number;
  max: number;
}

export interface WargearChoice {
  name: string;
  min: number;
  max: number;
  options: string[];
  maxRules?: MaxRule[];
  /**
   * Caps on an individual option, which the slot's own max does not express:
   * a Sword Brethren Squad allows two Pyre Pistols, four at ten models, and
   * none below five.
   */
  optionCaps?: Record<string, { max: number | null; maxRules?: MaxRule[] }>;
  /**
   * Weapons an option grants, where the option is a bundle rather than a
   * weapon. "Cyclone Missile Launcher & Storm Bolter" is one pick that arms
   * the model with both, which is why a Terminator keeps its storm bolter
   * after taking the launcher.
   */
  grants?: Record<string, string[]>;
}

export interface WargearVariant {
  name: string;
  min: number;
  max: number | null;
  fixed: string[];
  choices: WargearChoice[];
  /**
   * Caps that scale with squad size. A ten-model Terminator Squad takes two
   * cyclone missile launchers, not one, and the same pattern runs through
   * Scouts, Seraphim, Strike Squads and Crusaders.
   */
  maxRules?: MaxRule[];
}

export interface WargearGroup {
  name: string;
  min: number;
  max: number | null;
  variants: WargearVariant[];
  maxRules?: MaxRule[];
}

/** One model variant in a chosen loadout. */
export interface VariantSelection {
  variant: string;
  count: number;
  /** Choice slot name -> selected weapon. */
  choices: Record<string, string>;
}

export interface Loadout {
  selections: VariantSelection[];
}

export interface Problem {
  variant?: string;
  message: string;
}

function groupsOf(unit: DataUnit): WargearGroup[] {
  const groups = (unit.wargear ?? []) as WargearGroup[];
  if (groups.length) return groups;

  // BSData models no wargear tree for most single-model datasheets: a
  // Redemptor Dreadnought lists nine weapon profiles and exactly one choice
  // group (its fist and rocket pod). With no tree the unit fielded no weapons
  // at all and every cell read 0%, which is worse than the alternative.
  //
  // So fall back to "carries what it lists". The caveat is real and belongs in
  // the UI: where a datasheet offers alternatives the source does not record,
  // this over-arms the unit, and the player has to take the extras back off
  // with the steppers.
  const carried = baseWeaponNames(unit);
  if (!carried.length) return [];

  const models = defaultModelCount(unit);
  return [
    {
      name: unit.name,
      min: models,
      max: models,
      variants: [{ name: unit.name, min: models, max: models, fixed: carried, choices: [] }],
    },
  ];
}

/**
 * Distinct weapon names, with firing modes folded back into one.
 *
 * The loadout names wargear ("Macro Plasma Incinerator"); the profiles are per
 * mode ("- Standard", "- Supercharge"). `profilesFor` re-expands them, so
 * listing the modes separately here would field the same gun twice.
 */
function baseWeaponNames(unit: DataUnit): string[] {
  const names = new Set<string>();
  for (const weapon of unit.weapons) {
    names.add(weapon.mode ? weapon.name.replace(/\s+-\s+[^-]*$/, '').trim() : weapon.name);
  }
  return [...names];
}


/**
 * True when the unit has no recorded wargear tree and is therefore fielding
 * everything it lists.
 *
 * BSData models no alternatives for most single-model datasheets, so a
 * Redemptor Dreadnought carries both a Macro Plasma Incinerator and a Heavy
 * Onslaught Gatling Cannon at once -- not a legal build. Fielding nothing was
 * worse, but the number is an overestimate and the UI has to say so rather
 * than present it as the unit's output.
 */
export function loadoutIsAssumed(unit: DataUnit): boolean {
  return !(unit.wargear ?? []).length && (unit.weapons ?? []).length > 0;
}

/** Every variant across every group, flattened. */
export function variantsOf(unit: DataUnit): WargearVariant[] {
  return groupsOf(unit).flatMap((g) => g.variants);
}

/**
 * A legal starting loadout: every variant at its minimum, then the rest of the
 * unit filled with whichever variant can absorb them — which is the rank and
 * file, since that is the one with the largest maximum.
 */
export function defaultLoadout(unit: DataUnit, size?: number): Loadout {
  const groups = groupsOf(unit);
  if (!groups.length) return { selections: [] };

  const target = size ?? groups.reduce((n, g) => n + (g.min || 0), 0);
  const selections: VariantSelection[] = [];

  // The variant that fills the squad, and so what the rank and file carry.
  // Worked out before the selections so choice slots can default to matching
  // it: pooling every variant with headroom put the chain fist and the power
  // fist in the same bag, and a Terminator Sergeant took whichever the option
  // list happened to name first.
  const bulk = bulkVariant(groups.flatMap((g) => g.variants));
  const standard = new Set((bulk?.fixed ?? []).map((n) => n.toLowerCase()));

  for (const group of groups) {
    for (const variant of group.variants) {
      selections.push({
        variant: variant.name,
        count: variant.min ?? 0,
        choices: Object.fromEntries(
          variant.choices
            .filter((c) => c.min > 0 && c.options.length)
            .map((c) => [c.name, defaultOption(c, standard)])
        ),
      });
    }
  }

  // Top up to the unit's size using the variant with the most headroom.
  let assigned = selections.reduce((n, s) => n + s.count, 0);
  if (assigned < target) {
    const slot = selections.find((s) => s.variant === bulk?.name);
    if (slot && bulk) {
      const room = (bulk.max ?? Infinity) - slot.count;
      slot.count += Math.min(target - assigned, room);
      assigned = selections.reduce((n, s) => n + s.count, 0);
    }
  }

  return { selections };
}

/**
 * The option a choice slot should start on.
 *
 * Taking the first listed option is arbitrary and BSData's order is not the
 * datasheet's: an Intercessor Sergeant's slot lists the hand flamer first, so
 * every squad opened with the sergeant holding a flamer instead of a bolt
 * rifle. Preferring whatever the rank and file carry gives the standard build,
 * which is also the one worth comparing across units.
 */
function defaultOption(choice: WargearChoice, standard: Set<string>): string {
  return choice.options.find((o) => standard.has(o.toLowerCase())) ?? choice.options[0];
}

/** The variant with the most room, i.e. the one that fills out the squad. */
function bulkVariant(variants: WargearVariant[]): WargearVariant | null {
  let best: WargearVariant | null = null;
  let bestRoom = -1;
  for (const v of variants) {
    const room = (v.max ?? Infinity) - (v.min ?? 0);
    if (room > bestRoom) {
      bestRoom = room;
      best = v;
    }
  }
  return best;
}


/**
 * The cap that applies at this squad size.
 *
 * Rules are evaluated in order and the last match wins, which is how BSData
 * layers them. A squad below every threshold keeps the printed maximum.
 */
export function effectiveMax(
  item: { max: number | null; maxRules?: MaxRule[] },
  squadSize: number
): number | null {
  let max = item.max;
  for (const rule of item.maxRules ?? []) {
    const hit =
      rule.when === 'atLeast'
        ? squadSize >= rule.models
        : rule.when === 'equalTo'
          ? squadSize === rule.models
          : rule.when === 'lessThan'
            ? squadSize < rule.models
            : squadSize > rule.models;
    if (hit) max = rule.max;
  }
  return max;
}

/**
 * Check a loadout against the datasheet's constraints.
 *
 * Reported rather than enforced: the UI should show what is wrong and let the
 * user fix it, not silently rewrite their choice.
 */
export function validateLoadout(unit: DataUnit, loadout: Loadout): Problem[] {
  const problems: Problem[] = [];
  const byName = new Map(variantsOf(unit).map((v) => [v.name, v]));
  const squadSize = loadoutSize(loadout);

  for (const selection of loadout.selections) {
    const variant = byName.get(selection.variant);
    if (!variant) {
      problems.push({ variant: selection.variant, message: 'not a model in this unit' });
      continue;
    }
    if (selection.count < 0) {
      problems.push({ variant: variant.name, message: 'count cannot be negative' });
    }
    const cap = effectiveMax(variant, squadSize);
    if (cap != null && selection.count > cap) {
      problems.push({
        variant: variant.name,
        message: `at most ${cap} may be taken, ${selection.count} selected`,
      });
    }
    if (selection.count > 0 && variant.min > selection.count) {
      problems.push({
        variant: variant.name,
        message: `at least ${variant.min} required, ${selection.count} selected`,
      });
    }

    for (const choice of variant.choices) {
      const picked = selection.choices[choice.name];

      // Every model of this variant carries the same pick, so the number of
      // models taking that option is the variant's count.
      const optionCap = picked ? choice.optionCaps?.[picked] : undefined;
      if (optionCap) {
        const limit = effectiveMax(optionCap, squadSize);
        if (limit != null && selection.count > limit) {
          problems.push({
            variant: variant.name,
            message:
              limit === 0
                ? `${picked} cannot be taken at ${squadSize} models`
                : `at most ${limit} ${picked} may be taken, ${selection.count} selected`,
          });
        }
      }

      if (choice.min > 0 && !picked) {
        problems.push({ variant: variant.name, message: `"${choice.name}" must be chosen` });
      }
      if (picked && !choice.options.includes(picked)) {
        problems.push({
          variant: variant.name,
          message: `"${picked}" is not an option for "${choice.name}"`,
        });
      }
    }
  }

  for (const group of groupsOf(unit)) {
    const names = new Set(group.variants.map((v) => v.name));
    const total = loadout.selections
      .filter((s) => names.has(s.variant))
      .reduce((n, s) => n + s.count, 0);

    if (group.min && total < group.min) {
      problems.push({ message: `${group.name}: at least ${group.min} models, ${total} selected` });
    }
    if (group.max != null && total > group.max) {
      problems.push({ message: `${group.name}: at most ${group.max} models, ${total} selected` });
    }
  }

 // Group caps: how many models a set of variants may contribute between them.
  // A Purifier Squad allows two heavy weapons across three variants, four at
  // ten models, and nothing was checking it.
  for (const group of (unit.wargear ?? []) as WargearGroup[]) {
    const names = new Set(group.variants.map((v) => v.name));
    const taken = loadout.selections
      .filter((s) => names.has(s.variant))
      .reduce((n, s) => n + s.count, 0);
    const limit = effectiveMax(group, squadSize);
    if (limit != null && taken > limit) {
      problems.push({
        message: `${group.name || 'group'}: at most ${limit} models, ${taken} selected`,
      });
    }
  }

  return problems;
}

/**
 * Turn a loadout into engine entries.
 *
 * A model carries several weapons at once — the grenade-launcher Intercessor
 * still has its bolt rifle — so one variant yields one entry per weapon it
 * holds, all at that variant's model count.
 */
export function loadoutEntries(
  unit: DataUnit,
  loadout: Loadout,
  kind?: 'ranged' | 'melee',
  /** Return every firing mode, for `chooseModes` to pick between. */
  allModes = false
): LoadoutEntry[] {
  const byName = new Map(variantsOf(unit).map((v) => [v.name, v]));

  const entries: LoadoutEntry[] = [];
  for (const selection of loadout.selections) {
    if (selection.count <= 0) continue;
    const variant = byName.get(selection.variant);
    if (!variant) continue;

    const carried = [
      ...variant.fixed,
      ...Object.entries(selection.choices).flatMap(([slot, picked]) => {
        const choice = variant.choices.find((c) => c.name === slot);
        return choice?.grants?.[picked] ?? [picked];
      }),
    ];
    for (const name of carried) {
      for (const raw of profilesFor(unit, name, kind, allModes)) {
        const weapon = toWeapon(raw);
        if (weapon) entries.push({ weapon, models: selection.count });
      }
    }
  }
  return entries;
}

/**
 * Find the weapon profiles a named piece of wargear resolves to.
 *
 * The wargear tree names the weapon ("Astartes grenade launcher") but the
 * profiles are per firing mode ("Astartes grenade launcher - krak", "- frag").
 * An exact match alone finds nothing for those, which silently drops the
 * weapon from the loadout.
 */
export function profilesFor(
  unit: DataUnit,
  name: string,
  kind?: 'ranged' | 'melee',
  allModes = false
): DataWeapon[] {
  const wanted = name.toLowerCase().trim();
  const matches = unit.weapons.filter((w) => {
    if (kind && w.kind !== kind) return false;
    const actual = w.name.toLowerCase().trim();
    return actual === wanted || actual.startsWith(`${wanted} - `);
  });

  // A weapon with firing modes has no base profile, so the modes ARE the
  // weapon. Only one mode is fired at a time, so the caller gets them all and
  // picks; for a default we take the first.
  const modes = matches.filter((w) => w.mode);
  if (modes.length && modes.length === matches.length) return allModes ? modes : [modes[0]];
  return matches;
}

/**
 * Pick the firing mode a player would actually use against this target.
 *
 * A weapon with modes is one gun with a choice made at the moment of firing:
 * krak or frag, standard or supercharge. `profilesFor` has to return something
 * deterministic, so it returns the first mode -- which meant a cyclone missile
 * launcher fired frag into a Rhino and Hellblasters never supercharged.
 *
 * Scored on damage rather than efficiency because the choice is per weapon,
 * not per unit, and a mode that kills more of *this* target is the one taken.
 * Hazardous is priced in by `resolveAttack`, so supercharge only wins where
 * the extra damage outweighs the models it costs.
 */
export function chooseModes(
  entries: LoadoutEntry[],
  target: Target,
  modifiers: Modifiers = {},
  /**
   * Profiles the player has chosen by hand. Picking a mode for them is a
   * convenience, not a correction -- once they have said "analyse the Sweep",
   * switching them to the Strike because it scores better would be ignoring
   * the question they asked.
   */
  explicit: Set<string> = new Set()
): LoadoutEntry[] {
  const groups = new Map<string, LoadoutEntry[]>();
  const out: LoadoutEntry[] = [];

  for (const entry of entries) {
    const base = modeBase(entry.weapon.name);
    if (base === entry.weapon.name || explicit.has(entry.weapon.name)) {
      out.push(entry);
      continue;
    }
    // Grouped by kind as well as name: a Singing Spear is a thrown weapon and
    // a melee weapon, not two modes of one attack.
    const key = `${base}@${entry.weapon.melee ? 'melee' : 'ranged'}@${entry.models}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }

  for (const alternatives of groups.values()) {
    let best = alternatives[0];
    let bestDamage = -1;
    for (const candidate of alternatives) {
      const result = resolveAttack(candidate.weapon, target, {
        ...modifiers,
        ...candidate.modifiers,
        attackingModels: candidate.models,
      });
      const damage = result?.woundsRemoved ?? -1;
      if (damage > bestDamage) {
        bestDamage = damage;
        best = candidate;
      }
    }
    out.push(best);
  }

  return out;
}

/** "Cyclone missile launcher - krak" -> "Cyclone missile launcher". */
function modeBase(name: string): string {
  return name.replace(/\s+-\s+[^-]*$/, '').trim();
}

/** Total models in a loadout. */
export function loadoutSize(loadout: Loadout): number {
  return loadout.selections.reduce((n, s) => n + s.count, 0);
}
