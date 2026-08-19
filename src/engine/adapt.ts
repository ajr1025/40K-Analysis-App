/**
 * Bridge between the shape the data pipeline emits and the shape the engine
 * wants.
 *
 * Datasheet characteristics arrive as display strings -- "3+", "-2", '6"' --
 * because that is how they read on the card. Parsing is deliberately strict:
 * anything unrecognised becomes null so the caller can mark a unit as
 * unmodellable, rather than defaulting to a number that would silently produce
 * a confident but wrong result.
 */

import { parseDice } from './dice';
import type { Target, Weapon } from './resolve';

export interface DataModel {
  name: string;
  movement: string | null;
  toughness: string | null;
  save: string | null;
  wounds: string | null;
  leadership: string | null;
  objectiveControl: string | null;
  invulnerable: string | null;
}

export interface DataWeapon {
  name: string;
  kind: 'ranged' | 'melee';
  mode: boolean;
  range: string | null;
  attacks: string | null;
  skill: string | null;
  strength: string | null;
  ap: string | null;
  damage: string | null;
  keywords: string[];
}

export interface DataAbility {
  name: string;
  /** The printed rules text, used to read out defensive and leader effects. */
  text: string;
}

export interface DataUnit {
  id: string;
  name: string;
  legends: boolean;
  models: DataModel[];
  weapons: DataWeapon[];
  keywords: string[];
  abilities: DataAbility[];
  /** Units this model may attach to, if it is a leader. */
  leaderAttachTo?: string[];
  /**
   * Model variants and their legal counts, from the datasheet's selection
   * tree. Without this the weapon list is a menu with no portions: nothing
   * stops five Pyrecannons in a squad that may take one.
   */
  wargear?: Array<{
    name: string;
    min: number;
    max: number | null;
    variants: Array<{
      name: string;
      min: number;
      max: number | null;
      fixed: string[];
      choices: Array<{ name: string; min: number; max: number; options: string[] }>;
    }>;
  }>;
  points: Array<{ models: number; points: number; range: string | null; label: string | null }>;
  basePoints: number | null;
  role?: string | null;
  attachTo?: string[];
}

/** "3+" -> 3, "3" -> 3, anything else -> null. */
export function parseTargetNumber(text: string | null | undefined): number | null {
  if (text == null) return null;
  const match = /^\s*(\d)\s*\+?\s*$/.exec(String(text));
  return match ? Number(match[1]) : null;
}

/** "-2" or "2" -> 2 (a positive magnitude). "0" or blank -> 0. */
export function parseAp(text: string | null | undefined): number {
  if (text == null) return 0;
  const match = /^\s*-?\s*(\d+)\s*$/.exec(String(text));
  return match ? Number(match[1]) : 0;
}

/** Plain integer characteristics such as Toughness and Wounds. */
export function parseInteger(text: string | null | undefined): number | null {
  if (text == null) return null;
  const match = /^\s*(\d+)\s*$/.exec(String(text));
  return match ? Number(match[1]) : null;
}

/**
 * Strength, tolerating a stray trailing "+".
 *
 * BSData has at least one datasheet with a Strength of "8+" (the Deathwatch
 * chainfist). Strength is never a target number, so the "+" is a typo rather
 * than a meaning, and rejecting the weapon over it would lose a real profile.
 */
export function parseStrength(text: string | null | undefined): number | null {
  if (text == null) return null;
  const match = /^\s*(\d+)\s*\+?\s*$/.exec(String(text));
  return match ? Number(match[1]) : null;
}

const SUSTAINED = /^sustained hits\s*(\d+|d\d+)?/i;
/**
 * "Anti-Vehicle 4+" -- the keyword it applies to, and the threshold.
 *
 * Three real variations in the data, each of which silently dropped the
 * ability rather than failing:
 *
 *   Anti-Monster/Vehicle 3+       two keywords in one, joined by a slash
 *   Anti-Non-Monster/Vehicle 3+   negated: applies to everything else
 *   Anti-Fly 2                    BSData omits the "+" on seven weapons
 *
 * The keyword half also turns up with a non-breaking hyphen, so the text is
 * normalised before matching.
 */
const ANTI = /^anti-\s*(.+?)\s*(\d)\+?\s*$/i;
const RAPID_FIRE = /^rapid fire\s*(\d+|d\d+)?/i;
const MELTA = /^melta\s*(\d+|d\d+)?/i;
const BLAST = /^blast\s*(\d+)?/i;

/** Recognise the ability half of a keyword-scoped weapon ability. */
function matchAbility(
  text: string
): { ability: NonNullable<Weapon['conditionalAbilities']>[number]['ability']; value?: number } | null {
  const t = text.trim();
  const sustained = SUSTAINED.exec(t);
  if (sustained) return { ability: 'sustainedHits', value: keywordValue(sustained[1]) };
  if (/^lethal hits$/i.test(t)) return { ability: 'lethalHits' };
  if (/^devastating wounds$/i.test(t)) return { ability: 'devastatingWounds' };
  if (/^twin-?linked$/i.test(t)) return { ability: 'twinLinked' };
  if (/^ignores cover$/i.test(t)) return { ability: 'ignoresCover' };
  return null;
}

/** "D3" averages 2, "D6" averages 4; anything else is a plain count. */
function keywordValue(text: string | undefined, fallback = 1): number {
  const value = (text ?? '').trim();
  if (value === '') return fallback;
  if (/^d3$/i.test(value)) return 2;
  if (/^d6$/i.test(value)) return 4;
  return Number(value) || fallback;
}

/**
 * Read the weapon keyword line into engine flags.
 *
 * Only the keywords that change the damage maths are interpreted. Anything
 * else (Assault, Pistol, Heavy) affects when you may shoot rather than how
 * much you kill, so the engine ignores it by design.
 */
export function readKeywords(keywords: string[]) {
  const flags = {
    sustainedHits: 0,
    lethalHits: false,
    devastatingWounds: false,
    torrent: false,
    twinLinked: false,
    critWoundOn: 6,
    anti: [] as Array<{ keyword: string; critOn: number; negated?: boolean }>,
    blast: 0,
    rapidFire: 0,
    melta: 0,
    lance: false,
    extraAttacks: false,
    ignoresCover: false,
    conditionalAbilities: [] as NonNullable<Weapon['conditionalAbilities']>,
  };

  for (const raw of keywords) {
    // BSData uses a non-breaking hyphen in a few places ("Anti-Non‑Monster"),
    // which no plain "-" pattern matches.
    let keyword = raw.replace(/[‐-―−]/g, '-').trim();

    // Core rule 24.01: "[SUSTAINED HITS 1: INFANTRY/BEASTS]" only applies
    // against a target with one of those keywords. Split the restriction off
    // and record it as a condition; applying the bare ability everywhere is
    // the same mistake Anti-X used to make.
    const scoped = /^(.*?)\s*:\s*(.+)$/.exec(keyword);
    if (scoped) {
      const [, abilityText, targetText] = scoped;
      const negated = /^non-/i.test(targetText.trim());
      const targets = targetText
        .replace(/^non-/i, '')
        .split(/[/,]| or /i)
        .map((k) => k.trim())
        .filter(Boolean);

      const ability = matchAbility(abilityText);
      if (ability && targets.length) {
        flags.conditionalAbilities.push({ ...ability, keywords: targets, negated });
        continue;
      }
      // Unrecognised restriction: fall through on the bare ability rather
      // than dropping the weapon's keyword entirely.
      keyword = abilityText.trim();
    }

    const sustained = SUSTAINED.exec(keyword);
    if (sustained) {
      // "Sustained Hits D3" averages 2; the engine wants a whole number of
      // extra hits, so round to the nearest.
      flags.sustainedHits = keywordValue(sustained[1]);
      continue;
    }
    const rapidFire = RAPID_FIRE.exec(keyword);
    if (rapidFire) {
      flags.rapidFire = keywordValue(rapidFire[1]);
      continue;
    }
    const melta = MELTA.exec(keyword);
    if (melta) {
      flags.melta = keywordValue(melta[1]);
      continue;
    }
    const blast = BLAST.exec(keyword);
    if (blast) {
      flags.blast = keywordValue(blast[1]);
      continue;
    }
    const anti = ANTI.exec(keyword);
    if (anti) {
      // Recorded as a condition, never folded into critWoundOn -- Anti-Vehicle
      // must not lower the threshold when shooting at infantry. `applyAnti`
      // resolves these against the actual target.
      const critOn = Number(anti[2]);
      let subject = anti[1].trim();
      const negated = /^non-/i.test(subject);
      if (negated) subject = subject.replace(/^non-/i, '');
      for (const part of subject.split('/')) {
        const name = part.trim();
        if (name) flags.anti.push({ keyword: name, critOn, ...(negated ? { negated } : {}) });
      }
      continue;
    }
    if (/^lethal hits$/i.test(keyword)) flags.lethalHits = true;
    else if (/^devastating wounds$/i.test(keyword)) flags.devastatingWounds = true;
    else if (/^torrent$/i.test(keyword)) flags.torrent = true;
    else if (/^twin-?linked$/i.test(keyword)) flags.twinLinked = true;
    else if (/^lance$/i.test(keyword)) flags.lance = true;
    else if (/^extra attacks$/i.test(keyword)) flags.extraAttacks = true;
    else if (/^ignores cover$/i.test(keyword)) flags.ignoresCover = true;
  }

  return flags;
}

/** Convert a datasheet weapon, or null if it cannot be modelled. */
export function toWeapon(source: DataWeapon): Weapon | null {
  // Most weapons have a fixed Strength, but a few roll for it -- an Ork Zzap
  // gun is "2D6". Keep the expression so the engine can average over it,
  // rather than discarding the weapon as unmodellable.
  const fixedStrength = parseStrength(source.strength);
  const rolledStrength = fixedStrength == null && parseDice(source.strength) ? source.strength : null;
  const strength = fixedStrength ?? rolledStrength;
  if (strength == null) return null;
  if (source.attacks == null || source.damage == null) return null;

  const flags = readKeywords(source.keywords);
  const skill = parseTargetNumber(source.skill);
  // Torrent weapons have no skill characteristic, which is expected. Any other
  // weapon without a readable skill cannot be resolved.
  if (skill == null && !flags.torrent) return null;

  return {
    name: source.name,
    attacks: source.attacks,
    skill,
    strength,
    ap: parseAp(source.ap),
    damage: source.damage,
    melee: source.kind === 'melee',
    ...flags,
  };
}

/**
 * Defensive abilities that live in rules text rather than in a characteristic.
 *
 * The statline covers Toughness, Save and Wounds, but three things that matter
 * just as much are written in prose: Feel No Pain, damage reduction, and -- for
 * about 40 units -- the invulnerable save itself. Reading only the
 * characteristics makes those units look markedly more fragile than they are.
 */
const FEEL_NO_PAIN = /feel no pain\s*(\d)\+/i;
const INVULN_TEXT = /(\d)\+\s*invulnerable save/i;
const DAMAGE_MINUS_ONE =
  /subtract 1 from the damage characteristic|-1 damage\b/i;
const DAMAGE_HALVED = /halve the damage/i;

export interface DefensiveAbilities {
  feelNoPain: number | null;
  invulnerable: number | null;
  damageReduction: number;
  /** True where damage is halved rather than reduced by a flat amount. */
  damageHalved: boolean;
}

/**
 * Read defensive modifiers out of a unit's ability text.
 *
 * Deliberately conservative: an ability that only applies in narrow
 * circumstances ("against Psychic Attacks", "while in Cover") is skipped
 * rather than applied unconditionally, since a Feel No Pain that only works
 * against one damage type would otherwise make the unit look universally
 * tougher than it is.
 */
/**
 * Wordings that make a defensive ability situational.
 *
 * Being generous here is expensive: Ork Boyz have no invulnerable save on
 * their statline, but [Waaagh!] mentions one, and reading that as permanent
 * gave every Boy a 5++ — which showed up as a 20% under-count of damage
 * against them. 47 units were affected the same way. When in doubt, do not
 * grant the save; an understated defence is a smaller error than a phantom
 * one, and the statline already covers the common case.
 */
const SITUATIONAL =
  /once per (?:battle|turn|round)|at the start of|until the (?:start|end)|while |if your|if this|if that|you can call|against\s+(?:psychic|mortal|melee|ranged)|only against|\bcover\b|in your (?:command|shooting|fight|movement) phase/i;

export function readDefensiveAbilities(unit: DataUnit): DefensiveAbilities {
  const out: DefensiveAbilities = {
    feelNoPain: null,
    invulnerable: null,
    damageReduction: 0,
    damageHalved: false,
  };

  for (const ability of unit.abilities ?? []) {
    const text = ability.text ?? '';
    const name = ability.name ?? '';
    const situational = SITUATIONAL.test(text);

    // The value can live in either place. Units that link the shared Feel No
    // Pain rule carry it in the name ("Feel No Pain 5+") while units that
    // spell the ability out carry it in the prose. A value in the *name* is
    // the linked rule and is always on; one buried in prose is only trusted
    // when nothing about the wording makes it situational.
    const fnpInName = FEEL_NO_PAIN.exec(name);
    const fnp = fnpInName ?? (situational ? null : FEEL_NO_PAIN.exec(text));
    if (fnp) {
      const value = Number(fnp[1]);
      if (out.feelNoPain == null || value < out.feelNoPain) out.feelNoPain = value;
    }

    // An invulnerable save named as such is a real one; anything else has to
    // be unconditional prose to count.
    const namedInvuln = /^\*?\s*invulnerable save/i.test(name);
    const invuln = namedInvuln || !situational ? INVULN_TEXT.exec(text) : null;
    if (invuln && !/against melee|against ranged/i.test(text)) {
      const value = Number(invuln[1]);
      if (out.invulnerable == null || value < out.invulnerable) out.invulnerable = value;
    }

    if (DAMAGE_MINUS_ONE.test(text)) out.damageReduction = Math.max(out.damageReduction, 1);
    if (DAMAGE_HALVED.test(text)) out.damageHalved = true;
  }

  return out;
}

/** Names that mark a squad leader rather than the rank and file. */
const LEADER_PROFILE =
  /\b(sergeant|sarge|nob|exarch|champion|leader|master|superior|alpha|pack leader|shas'?vre)\b/i;

/** Fold a name for comparison: lowercase, strip punctuation and spacing. */
function nameKey(text: string | null | undefined): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Pick the profile that represents what the unit actually is.
 *
 * Three cases, and the rules pull in opposite directions:
 *
 *  1. **The datasheet names its own subject.** Intercessor Squad lists
 *     [Intercessor Sergeant, Intercessor Squad]; the profile sharing the
 *     unit's name is the one to use.
 *
 *  2. **Characters with attendants.** Ghazghkull Thraka is [Ghazghkull W10,
 *     Makari W1] -- Makari is a grot bannerman. Taking the weakest model
 *     turns a 235-point warboss into a one-wound grot, which is how a 25-point
 *     Datasmith came out scoring 931% against him. For a CHARACTER the subject
 *     is the strongest profile; attendants are extras.
 *
 *  3. **Squads.** Ork Boyz are [Boy W1, Boss Nob W2] and Intercessors are
 *     [Sergeant, Squad] -- BSData orders them inconsistently, so neither end
 *     of the list is safe. Drop the squad leaders by name and take the weakest
 *     of the rest, since that is what most of the unit is made of.
 */
export function bulkProfile(unit: DataUnit): DataModel | null {
  if (!unit.models.length) return null;

  // 1. A profile named after the unit itself.
  const unitKey = nameKey(unit.name);
  const named = unit.models.find((m) => nameKey(m.name) === unitKey);
  if (named) return named;

  const wounds = (m: DataModel) => parseInteger(m.wounds) ?? 0;

  // 2. The most common statline. Where a datasheet lists each model
  //    individually -- Kill Team Cassius names all eleven -- the profile that
  //    appears most often is what the unit is mostly made of.
  const counts = new Map<string, DataModel[]>();
  for (const model of unit.models) {
    const key = statlineKey(model);
    if (!counts.has(key)) counts.set(key, []);
    counts.get(key)!.push(model);
  }
  const modal = [...counts.values()].sort((a, b) => b.length - a.length);
  if (modal[0].length > 1 && modal[0].length > (modal[1]?.length ?? 0)) {
    return modal[0][0];
  }

  // 3. No clear majority. A character is its own subject and anything else on
  //    its datasheet is an attendant -- Ghazghkull's Makari is a one-wound
  //    grot, and taking the weakest profile turns a 235-point warboss into
  //    something a 25-point Datasmith deletes.
  const isCharacter = (unit.keywords ?? []).some((k) => /^(character|epic hero)$/i.test(k));
  if (isCharacter) {
    return unit.models.reduce((strongest, m) => (wounds(m) > wounds(strongest) ? m : strongest));
  }

  // 4. Rank and file: drop the squad leaders, take the weakest of the rest.
  const rankAndFile = unit.models.filter((m) => !LEADER_PROFILE.test(m.name ?? ''));
  const candidates = rankAndFile.length ? rankAndFile : unit.models;

  return candidates.reduce((weakest, model) => {
    const a = parseInteger(model.wounds) ?? Infinity;
    const b = parseInteger(weakest.wounds) ?? Infinity;
    return a < b ? model : weakest;
  });
}

/** Everything about a model that the damage maths reads. */
function statlineKey(model: DataModel): string {
  return `${model.toughness}/${model.save}/${model.wounds}/${model.invulnerable ?? ''}`;
}

/**
 * Convert a datasheet unit into a target.
 *
 * `profileName` pins a specific model profile, for units where the bulk
 * profile is not the one you want to measure against -- Terminator Assault
 * Squads list both a 4-wound storm shield model and a 3-wound lightning claw
 * model, and which one you mean matters.
 */
export function toTarget(
  unit: DataUnit,
  modelCount?: number,
  profileName?: string
): Target | null {
  const profile = profileName
    ? (unit.models.find((m) => m.name?.toLowerCase().includes(profileName.toLowerCase())) ??
      bulkProfile(unit))
    : bulkProfile(unit);
  if (!profile) return null;

  const toughness = parseInteger(profile.toughness);
  const wounds = parseInteger(profile.wounds);
  const save = parseTargetNumber(profile.save);
  if (toughness == null || wounds == null || save == null) return null;

  const defensive = readDefensiveAbilities(unit);
  // Around 40 units carry no InSv characteristic but describe an invulnerable
  // save in prose (Deathwatch Terminators, storm-shield Vanguard). Prefer the
  // characteristic; fall back to the text.
  const invulnerable = parseTargetNumber(profile.invulnerable) ?? defensive.invulnerable;

  return {
    name: unit.name,
    toughness,
    save,
    invulnerable,
    wounds,
    models: modelCount ?? representedModels(unit, profile),
    feelNoPain: defensive.feelNoPain,
    damageReduction: defensive.damageReduction,
    keywords: unit.keywords,
  };
}

/**
 * The set of melee weapons that actually swing together.
 *
 * A model picks ONE ordinary melee weapon, but every [EXTRA ATTACKS] weapon is
 * used *in addition* to it rather than instead of it. The Twin Lance is the
 * clearest case: its XV pulse pistol is the chosen weapon, while its fusion
 * eliminator and ion scattercannon both carry Extra Attacks and are swung as
 * well. Scoring only the chosen weapon understates its melee output badly.
 *
 * `chosen` names the ordinary weapon to use; without it the highest-volume one
 * is assumed.
 */
export function meleeLoadout(unit: DataUnit, chosen?: string): DataWeapon[] {
  const melee = unit.weapons.filter((w) => w.kind === 'melee');
  const bonus = melee.filter((w) => readKeywords(w.keywords).extraAttacks);
  const selectable = melee.filter((w) => !readKeywords(w.keywords).extraAttacks);

  let primary: DataWeapon | undefined;
  if (chosen) {
    primary = selectable.find((w) => w.name.toLowerCase() === chosen.toLowerCase());
  }
  if (!primary) {
    // Fall back to whichever ordinary weapon throws the most attacks, as a
    // stand-in for "the one you would actually pick".
    primary = selectable.reduce<DataWeapon | undefined>((best, w) => {
      const value = (s: string | null) => {
        const dist = parseDice(s);
        if (!dist) return 0;
        let total = 0;
        for (const [v, p] of dist) total += v * p;
        return total;
      };
      return !best || value(w.attacks) > value(best.attacks) ? w : best;
    }, undefined);
  }

  return [...(primary ? [primary] : []), ...bonus];
}

/**
 * How many models the chosen profile actually stands for.
 *
 * A unit is modelled as N copies of one statline, which cannot represent a
 * mixed squad exactly. Where a datasheet lists every model individually --
 * Ghazghkull plus Makari, or the eleven named members of Kill Team Cassius --
 * counting the whole unit at the chosen profile's wounds inflates it badly
 * (Ghazghkull's grot would become a second ten-wound model). In that case only
 * the models sharing the chosen statline are counted. Ordinary squads, where a
 * couple of profiles cover ten bodies, keep their full size.
 */
function representedModels(unit: DataUnit, profile: DataModel): number {
  const size = defaultModelCount(unit);
  if (unit.models.length <= 1) return size;

  // Where the datasheet names every model -- Kill Team Cassius lists all
  // eleven -- the count is exactly those sharing the chosen statline.
  if (unit.models.length === size) {
    const key = statlineKey(profile);
    return Math.max(1, unit.models.filter((m) => statlineKey(m) === key).length);
  }

  // Mixed profiles that do not enumerate: The Silent King is three models
  // from two profiles (Szarekh plus two Triarchal Menhirs). There is no way
  // to recover the split, so for a character the subject is taken as one
  // model and the attendants ignored. That understates a little; counting the
  // whole unit at the character's wounds would overstate enormously -- three
  // 16-wound Silent Kings instead of one.
  const distinctProfiles = new Set(unit.models.map(statlineKey)).size;
  const isCharacter = (unit.keywords ?? []).some((k) => /^(character|epic hero)$/i.test(k));
  if (distinctProfiles > 1 && isCharacter) return 1;

  return size;
}

/** The smallest legal unit size, which is what its base points buy. */
export function defaultModelCount(unit: DataUnit): number {
  if (!unit.points?.length) return 1;
  return Math.min(...unit.points.map((tier) => tier.models));
}
