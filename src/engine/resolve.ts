/**
 * The 11th-edition attack sequence, resolved exactly.
 *
 * The hit/wound/save chain is just three independent rolls. What makes this
 * more than a multiplication is what happens to the damage afterwards:
 *
 *   - Damage never spills between models. A D6-damage weapon fired into
 *     one-wound infantry wastes most of every hit, so dividing total damage by
 *     wounds-per-model badly overrates it. This holds for Devastating Wounds
 *     too: a 2-damage devastating hit kills one guardsman and wastes the
 *     second point, exactly like an ordinary failed save.
 *
 *   - Sustained Hits means one attack can produce several independent chances
 *     to wound, so landing hits are a distribution rather than a count.
 *
 * So landing hits are walked through a small state machine over (models slain,
 * wounds left on the model currently taking hits), discarding the overkill.
 */

import {
  type Distribution,
  constant,
  expected,
  mapValues,
  mix,
  parseDice,
  repeat,
} from './dice';
import { type RerollMode, roll, saveFailChance, woundTarget } from './rolls';

export interface Weapon {
  name: string;
  /** Attacks characteristic, e.g. "3" or "D6". */
  attacks: string;
  /** BS/WS as a target number. Null for Torrent weapons, which auto-hit. */
  skill: number | null;
  /**
   * Strength. Usually fixed, but a few weapons roll for it -- an Ork Zzap gun
   * is "2D6" -- so the wound roll has to be averaged over the distribution
   * rather than computed from a single value.
   */
  strength: number | string;
  /** Armour penetration as a positive magnitude: AP-2 is 2. */
  ap: number;
  /** Damage characteristic, e.g. "1" or "D6+2". */
  damage: string;
  sustainedHits?: number;
  lethalHits?: boolean;
  /**
   * Anti-X conditions: each lowers the critical wound threshold, but only
   * against a target carrying that keyword. Kept as conditions rather than
   * folded into `critWoundOn` because Anti-Vehicle must not fire into
   * infantry -- resolve them with `applyAnti` before scoring an attack.
   */
  anti?: Array<{ keyword: string; critOn: number; negated?: boolean }>;
  /**
   * Critical wounds cannot be saved by armour or invulnerable saves. Feel No
   * Pain still applies, and the damage is still allocated to a single model.
   */
  devastatingWounds?: boolean;
  torrent?: boolean;
  twinLinked?: boolean;
  /** Unmodified wound roll that counts as critical, from Anti-X. 6 normally. */
  critWoundOn?: number;
  /**
   * [BLAST X]: X additional attacks for every five models in the target unit.
   * Unlike the range-dependent keywords this needs no toggle -- the target's
   * size is already known.
   */
  blast?: number;
  /** [RAPID FIRE X]: X additional attacks within half range. */
  rapidFire?: number;
  /** [MELTA X]: X added to the Damage characteristic within half range. */
  melta?: number;
  /** [LANCE]: +1 to wound when the attacking unit charged this turn. */
  lance?: boolean;
  /**
   * [HEAVY]: +1 to hit if the unit Remained Stationary this turn. Carried by
   * 543 weapons -- every bolt rifle, melta rifle and lascannon in the game --
   * so leaving it out understates a gunline that did what gunlines do.
   */
  heavy?: boolean;
  /** Melee weapons ignore Benefit of Cover, which applies to ranged attacks only. */
  melee?: boolean;
  /**
   * Core rule 24.01: a weapon ability followed by keywords only applies
   * against a target carrying one of them — "[SUSTAINED HITS 1: INFANTRY]"
   * does nothing to a vehicle. Kept as conditions and resolved per target,
   * exactly the way Anti-X is, rather than baked into the flag.
   */
  conditionalAbilities?: Array<{
    ability: 'sustainedHits' | 'lethalHits' | 'devastatingWounds' | 'twinLinked' | 'ignoresCover';
    value?: number;
    keywords: string[];
    /** "Non-Monster/Vehicle" style wording inverts the test. */
    negated?: boolean;
  }>;
  /**
   * [IGNORES COVER]: cancels the target's Benefit of Cover. Now that cover
   * worsens Ballistic Skill rather than the save, this keyword matters to the
   * hit step -- 758 weapons carry it.
   */
  ignoresCover?: boolean;
}

export interface Target {
  name: string;
  toughness: number;
  /** Armour save as a target number: 3 for 3+. */
  save: number;
  invulnerable?: number | null;
  /** Wounds per model. */
  wounds: number;
  models: number;
  /** Feel No Pain target number, or null. */
  feelNoPain?: number | null;
  /**
   * Flat reduction applied to each attack's Damage characteristic, from
   * abilities like the C'tan's Necrodermis. Damage never drops below 1, so
   * this blunts big-damage weapons far more than volume fire.
   */
  damageReduction?: number;
  /** Keywords the target has, used to decide whether Anti-X applies. */
  keywords?: string[];
}

/**
 * Everything a player can change about a matchup.
 *
 * Split three ways, because the game treats them differently:
 *
 *   - **Roll modifiers** (hit, wound) are capped at a net +/-1. Sum every
 *     source before passing them; the cap applies to the total.
 *   - **Characteristic modifiers** (attacks, strength, AP, damage, toughness,
 *     save) are NOT capped -- the cap governs dice rolls, not profiles, so
 *     "add 2 to the Strength characteristic" is legal and must not be clamped.
 *   - **Granted abilities** are keywords a leader, detachment or stratagem
 *     hands to a weapon that does not print them.
 */
export interface Modifiers {
  // --- roll modifiers, capped at a net +/-1 -------------------------------
  hitModifier?: number;
  woundModifier?: number;
  rerollHits?: RerollMode;
  rerollWounds?: RerollMode;
  /**
   * "You can re-roll the Damage roll." Only meaningful for variable damage,
   * and it is a *choice* -- you see the result before deciding -- so the
   * engine rerolls exactly the outcomes below the threshold that maximises
   * expected damage, which is what a player would do.
   */
  rerollDamage?: boolean;
  /** Lowest unmodified hit roll that critically hits. 6 normally. */
  critHitOn?: number;
  /** Lowest unmodified wound roll that critically wounds, before Anti-X. */
  critWoundOn?: number;

  // --- attacker characteristics, uncapped --------------------------------
  attacksModifier?: number;
  /**
   * Added to Attacks on melee weapons only. Most attack bonuses in the game
   * are melee-only -- a charge, a Waaagh!, The Red Thirst -- and applying them
   * to a squad's bolters as well would flatter every gunline that ever fixed
   * bayonets.
   */
  meleeAttacksModifier?: number;
  strengthModifier?: number;
  /** Improves AP: +1 turns AP-1 into AP-2. */
  apModifier?: number;
  damageModifier?: number;

  // --- defender characteristics, uncapped --------------------------------
  /** Negative worsens the target: Death Guard's Afflicted is -1 Toughness. */
  toughnessModifier?: number;
  /** Positive worsens the target's armour save by that many pips. */
  saveModifier?: number;
  /** Overrides the target's Feel No Pain; null removes it. */
  feelNoPain?: number | null;
  /** Overrides the target's flat damage reduction. */
  damageReduction?: number;
  /** Overrides the target's invulnerable save; null removes it. */
  invulnerable?: number | null;

  // --- abilities granted to the weapon -----------------------------------
  grantSustainedHits?: number;
  grantLethalHits?: boolean;
  grantDevastatingWounds?: boolean;
  grantTwinLinked?: boolean;
  /** Negates the target's Benefit of Cover. */
  grantIgnoresCover?: boolean;

  // --- situation ----------------------------------------------------------
  /** Number of models in the attacking unit firing this weapon. */
  attackingModels?: number;
  /** Number of models in the target unit, overriding its default size. */
  targetModels?: number;
  /**
   * Within half range, which switches on [RAPID FIRE] and [MELTA]. Neither
   * can be decided from the datasheets alone -- it depends where the models
   * are standing, so it is the player's call.
   */
  halfRange?: boolean;
  /** The unit Remained Stationary, which switches on [HEAVY]. */
  stationary?: boolean;
  /** The attacking unit charged this turn, which switches on [LANCE]. */
  charged?: boolean;
  /**
   * The target has the Benefit of Cover. In 11th edition this worsens the
   * attack's BS by 1 rather than improving the save, so it stacks with any
   * -1 to hit the target also imposes.
   */
  cover?: boolean;
}

export interface Result {
  /**
   * Expected damage the attack throws, ignoring how much the target can
   * absorb. Deliberately uncapped: an attack averaging 50 into a 10-wound unit
   * is far more overkill than one averaging 11, and clamping both to 10 would
   * hide the difference.
   */
  totalDamage: number;
  /**
   * Wounds actually removed from this unit, after overkill waste and the unit
   * running out of models. Never exceeds the unit's wound pool.
   */
  woundsRemoved: number;
  /** Expected models killed, respecting overkill waste. */
  expectedModelsSlain: number;
  /** Probability the unit is wiped out entirely -- the confidence figure. */
  probabilityDestroyed: number;
  /** Share of the target's wound pool removed, 0-1. Drives the bar. */
  fractionDestroyed: number;
  /** Share of the target's models killed, 0-1. */
  fractionModelsSlain: number;
  /** Full distribution over models slain, for showing spread. */
  modelsSlainDistribution: Distribution;
  /** Damage thrown per wound the unit has. 1 = exactly lethal on average. */
  overkillRatio: number;
}

/** Chance a single point of damage survives Feel No Pain and is actually lost. */
function woundLossChance(feelNoPain: number | null | undefined): number {
  if (feelNoPain == null) return 1;
  const target = Math.max(2, Math.min(6, feelNoPain));
  // A natural 1 always fails the Feel No Pain roll, so it saves at most 5 faces.
  const saved = Math.min(6 - target + 1, 5) / 6;
  return 1 - saved;
}

function binomial(n: number, k: number, p: number): number {
  let coefficient = 1;
  for (let i = 0; i < k; i += 1) coefficient = (coefficient * (n - i)) / (i + 1);
  return coefficient * p ** k * (1 - p) ** (n - k);
}

/**
 * Wounds actually lost from one packet of damage, folding Feel No Pain in per
 * point of damage.
 *
 * Feel No Pain is rolled once for every point of damage, not once for the
 * attack. A two-wound model with FNP 6+ taking 2 damage rolls twice, and a
 * single 6 leaves it alive on one wound -- which is why a unit with Feel No
 * Pain absorbs more failed saves than its raw wound count suggests.
 */
function woundsLostFrom(damage: Distribution, feelNoPain: number | null | undefined): Distribution {
  const lossChance = woundLossChance(feelNoPain);
  if (lossChance === 1) return damage;

  const out: Distribution = new Map();
  for (const [dmg, pDmg] of damage) {
    for (let lost = 0; lost <= dmg; lost += 1) {
      const p = binomial(dmg, lost, lossChance);
      if (p > 0) out.set(lost, (out.get(lost) ?? 0) + pDmg * p);
    }
  }
  return out;
}

/**
 * Apply a damage reroll.
 *
 * The player sees the roll before choosing, so the optimal play is to reroll
 * every result below some threshold and keep the rest. The best threshold is
 * whichever maximises the expected result, so each candidate is evaluated and
 * the winner kept -- rather than assuming "reroll below average", which is
 * close but not always right for offset dice like D6+2.
 *
 * Fixed-damage weapons are untouched: there is nothing to reroll.
 */
function rerollDamageRoll(damage: Distribution): Distribution {
  if (damage.size <= 1) return damage;

  const outcomes = [...damage.keys()].sort((a, b) => a - b);
  let best = damage;
  let bestMean = expected(damage);

  for (const threshold of outcomes) {
    let belowMass = 0;
    for (const [value, p] of damage) if (value < threshold) belowMass += p;
    if (belowMass === 0) continue;

    const out: Distribution = new Map();
    for (const [value, p] of damage) {
      // Kept outcomes, plus a fresh roll for everything thrown back.
      const kept = value >= threshold ? p : 0;
      out.set(value, kept + belowMass * p);
    }

    const mean = expected(out);
    if (mean > bestMean + 1e-12) {
      bestMean = mean;
      best = out;
    }
  }

  return best;
}

function convolve(a: Distribution, b: Distribution): Distribution {
  const out: Distribution = new Map();
  for (const [va, pa] of a) {
    for (const [vb, pb] of b) {
      const v = va + vb;
      out.set(v, (out.get(v) ?? 0) + pa * pb);
    }
  }
  return out;
}

const bernoulli = (p: number): Distribution =>
  new Map([
    [0, 1 - p],
    [1, p],
  ]);

/** Strength as a distribution, so rolled values like "2D6" are supported. */
function strengthDistribution(strength: number | string): Distribution {
  if (typeof strength === 'number') return constant(strength);
  return parseDice(strength) ?? constant(Number(strength) || 0);
}

/**
 * Average a roll outcome over a distribution of inputs.
 *
 * Used for weapons whose Strength is rolled: each possible Strength gives a
 * different wound threshold, and the result is their weighted blend.
 */
function mixOutcomes(
  inputs: Distribution,
  outcomeFor: (value: number) => { crit: number; normal: number; fail: number; pass: number }
) {
  if (inputs.size === 1) return outcomeFor([...inputs.keys()][0]);

  const blended = { crit: 0, normal: 0, fail: 0, pass: 0 };
  for (const [value, p] of inputs) {
    const outcome = outcomeFor(value);
    blended.crit += p * outcome.crit;
    blended.normal += p * outcome.normal;
    blended.fail += p * outcome.fail;
    blended.pass += p * outcome.pass;
  }
  return blended;
}

/**
 * Distribution over how many hits from a single attack go on to deal damage.
 *
 * Devastating Wounds and ordinary failed saves both end up here: they differ
 * only in whether a save is rolled, not in how the damage is then applied.
 *
 * `useLethal` selects whether critical hits take the Lethal Hits auto-wound.
 * That choice is optional in 11th edition and forfeits the chance of a
 * critical wound, so the caller evaluates both branches and keeps the better.
 */
/**
 * Core rule: the net modifier to a hit or wound roll can never exceed +/-1,
 * however many sources stack. Three +1s and a -1 is still +1.
 *
 * This governs *roll* modifiers only. Characteristic modifiers are uncapped
 * (The Red Thirst really does add 2 to Strength), and Benefit of Cover
 * worsens the Ballistic Skill characteristic rather than the roll, which is
 * why cover and a -1 to hit combine to an effective -2.
 */
function capRollModifier(n: number): number {
  return Math.max(-1, Math.min(1, n));
}

function landingHitsPerAttack(
  weapon: Weapon,
  target: Target,
  modifiers: Modifiers,
  useLethal: boolean
): Distribution {
  // Benefit of Cover worsens the attack's Ballistic Skill characteristic; it
  // is NOT a hit-roll modifier. That distinction matters: because the +/-1 cap
  // applies to roll modifiers only, cover stacks on top of a -1 to hit for an
  // effective -2. It applies to ranged attacks only, Torrent weapons hit
  // automatically, and [IGNORES COVER] cancels it outright.
  const ignoresCover = weapon.ignoresCover || modifiers.grantIgnoresCover;
  const coverPenalty = modifiers.cover && !weapon.melee && !ignoresCover ? 1 : 0;

  // [HEAVY] is a hit-roll modifier like any other, so it goes inside the cap:
  // a unit already at +1 gains nothing further by standing still.
  const heavyBonus = weapon.heavy && modifiers.stationary ? 1 : 0;

  const hit = weapon.torrent
    ? { crit: 0, normal: 1, fail: 0, pass: 1 }
    : roll({
        target: (weapon.skill ?? 4) + coverPenalty,
        modifier: capRollModifier((modifiers.hitModifier ?? 0) + heavyBonus),
        critOn: modifiers.critHitOn ?? 6,
        reroll: modifiers.rerollHits ?? 'none',
      });

  // [LANCE] adds its bonus on top of whatever the player already set, and the
  // usual +/-1 cap still applies to the total.
  const woundModifier = capRollModifier(
    (modifiers.woundModifier ?? 0) + (weapon.lance && modifiers.charged ? 1 : 0)
  );

  // A rolled Strength means there is no single wound threshold, so average the
  // wound outcome over the Strength distribution.
  const strengthBonus = modifiers.strengthModifier ?? 0;
  const strengths =
    strengthBonus !== 0
      ? mapValues(strengthDistribution(weapon.strength), (s) => Math.max(1, s + strengthBonus))
      : strengthDistribution(weapon.strength);

  // Toughness can be worsened -- Death Guard's Afflicted subtracts 1 -- and
  // never drops below 1.
  const toughness = Math.max(1, target.toughness + (modifiers.toughnessModifier ?? 0));

  const twinLinked = weapon.twinLinked || modifiers.grantTwinLinked;
  const wound = mixOutcomes(strengths, (strength) =>
    roll({
      target: woundTarget(strength, toughness),
      modifier: woundModifier,
      critOn: Math.min(weapon.critWoundOn ?? 6, modifiers.critWoundOn ?? 6),
      reroll: twinLinked ? 'failures' : (modifiers.rerollWounds ?? 'none'),
    })
  );

  const failSave = saveFailChance({
    armour: target.save + (modifiers.saveModifier ?? 0),
    invulnerable:
      modifiers.invulnerable !== undefined ? modifiers.invulnerable : target.invulnerable,
    // AP is a positive magnitude here, so improving it means adding.
    ap: weapon.ap + (modifiers.apModifier ?? 0),
  });

  // A Devastating critical wound skips the saving throw entirely; everything
  // else has to get past it.
  const devastating = weapon.devastatingWounds === true || modifiers.grantDevastatingWounds === true;
  const savable = wound.normal + (devastating ? 0 : wound.crit);
  const unsavable = devastating ? wound.crit : 0;
  const pLandFromHit = savable * failSave + unsavable;

  // A Lethal Hits auto-wound skips the wound roll but is still saveable, and
  // being automatic it can never be a critical wound.
  const pLandFromAutoWound = failSave;

  // Core rule 24.02: duplicated weapon abilities are NOT cumulative -- the
  // player selects which instance applies. So a granted [SUSTAINED HITS 1] on
  // a weapon that already prints [SUSTAINED HITS 2] gives 2, not 3.
  const sustained = Math.max(weapon.sustainedHits ?? 0, modifiers.grantSustainedHits ?? 0);
  const lethal = useLethal && (weapon.lethalHits === true || modifiers.grantLethalHits === true);

  const parts: Array<{ weight: number; dist: Distribution }> = [
    { weight: hit.fail, dist: constant(0) },
    { weight: hit.normal, dist: bernoulli(pLandFromHit) },
  ];

  if (hit.crit > 0) {
    // The critical hit itself, plus any Sustained Hits extras. The extras are
    // ordinary hits that roll to wound as normal.
    const primary = lethal ? bernoulli(pLandFromAutoWound) : bernoulli(pLandFromHit);
    const extras = repeat(bernoulli(pLandFromHit), sustained);
    parts.push({ weight: hit.crit, dist: convolve(primary, extras) });
  }

  return mix(parts);
}

interface AllocationOutcome {
  modelsSlain: Distribution;
  woundsRemoved: number;
  probabilityDestroyed: number;
}

/**
 * Walk landing hits through the target unit, killing models one at a time.
 *
 * State is (models slain, wounds left on the model currently taking hits).
 * When a hit exceeds what that model has left, the surplus is discarded rather
 * than carried onward -- that discard is the whole reason this cannot be a
 * division.
 */
function allocate(
  landingHits: Distribution,
  woundsLost: Distribution,
  target: Target
): AllocationOutcome {
  const maxModels = target.models;
  const perModel = target.wounds;
  const stride = perModel + 1;

  const encode = (slain: number, remaining: number) => slain * stride + remaining;
  const slainOf = (key: number) => Math.floor(key / stride);
  const remainingOf = (key: number) => key % stride;

  let state = new Map<number, number>([[encode(0, perModel), 1]]);
  const snapshots: Array<Map<number, number>> = [];
  const maxHits = Math.max(...landingHits.keys());

  for (let hits = 0; hits <= maxHits; hits += 1) {
    snapshots.push(state);
    if (hits === maxHits) break;

    const next = new Map<number, number>();
    for (const [key, pState] of state) {
      const slain = slainOf(key);
      const remaining = remainingOf(key);

      if (slain >= maxModels) {
        // Unit already destroyed; further hits have nothing to allocate to.
        next.set(key, (next.get(key) ?? 0) + pState);
        continue;
      }

      for (const [lost, pLost] of woundsLost) {
        const p = pState * pLost;
        if (p === 0) continue;
        const nextKey =
          lost >= remaining
            ? encode(Math.min(slain + 1, maxModels), perModel) // excess wasted
            : encode(slain, remaining - lost);
        next.set(nextKey, (next.get(nextKey) ?? 0) + p);
      }
    }
    state = next;
  }

  // Weight each hit-count's outcome by how likely that many hits were.
  const clamp = (n: number) => Math.min(n, snapshots.length - 1);
  const modelsSlain: Distribution = new Map();
  let woundsRemoved = 0;
  let probabilityDestroyed = 0;

  for (const [hits, weight] of landingHits) {
    for (const [key, p] of snapshots[clamp(hits)]) {
      const slain = slainOf(key);
      const remaining = remainingOf(key);
      const mass = weight * p;

      modelsSlain.set(slain, (modelsSlain.get(slain) ?? 0) + mass);
      const partial = slain >= maxModels ? 0 : perModel - remaining;
      woundsRemoved += mass * (slain * perModel + partial);
      if (slain >= maxModels) probabilityDestroyed += mass;
    }
  }

  return { modelsSlain, woundsRemoved, probabilityDestroyed };
}

/**
 * Apply a weapon's Anti-X conditions against a specific target.
 *
 * Anti-Vehicle 4+ lowers the critical wound threshold only when shooting at a
 * VEHICLE. Baking the threshold in unconditionally would overstate damage for
 * every Anti- weapon fired at anything else, which is most of the matrix.
 */
export function applyAnti(weapon: Weapon, target: Target): Weapon {
  const targetKeywords = (target.keywords ?? []).map((k) => k.toLowerCase());
  const has = (keywords: string[]) => keywords.some((k) => targetKeywords.includes(k.toLowerCase()));

  let out = weapon;

  // Anti-X: lowers the critical wound threshold, but only against a matching
  // target. Rule 24.02 says duplicated abilities are not cumulative and the
  // player selects one, so the best applicable threshold wins.
  if (weapon.anti?.length) {
    let critOn = weapon.critWoundOn ?? 6;
    for (const condition of weapon.anti) {
      // "Anti-Non-Monster/Vehicle 3+" fires against everything that is *not*
      // one of the listed keywords.
      const matches = has([condition.keyword]);
      if (condition.negated ? !matches : matches) critOn = Math.min(critOn, condition.critOn);
    }
    if (critOn !== (weapon.critWoundOn ?? 6)) out = { ...out, critWoundOn: critOn };
  }

  // Rule 24.01: keyword-scoped weapon abilities, e.g. [LETHAL HITS: VEHICLE].
  for (const condition of weapon.conditionalAbilities ?? []) {
    const matches = has(condition.keywords);
    if (condition.negated ? matches : !matches) continue;

    if (out === weapon) out = { ...weapon };
    if (condition.ability === 'sustainedHits') {
      out.sustainedHits = Math.max(out.sustainedHits ?? 0, condition.value ?? 1);
    } else {
      out[condition.ability] = true;
    }
  }

  return out;
}

/**
 * Resolve one weapon firing into one target unit.
 *
 * Anti-X conditions are resolved here against the target's keywords, so
 * callers do not have to remember to do it.
 *
 * Returns null when the datasheet values cannot be modelled -- weapons with
 * "*" characteristics, for instance -- so callers can show them as unsupported
 * rather than scoring them as zero damage.
 */
export function resolveAttack(
  rawWeapon: Weapon,
  rawTarget: Target,
  modifiers: Modifiers = {}
): Result | null {
  // Apply the defender-side overrides before anything reads the target, so
  // Anti-X and the allocation walk both see the same unit.
  const target: Target = {
    ...rawTarget,
    models: modifiers.targetModels ?? rawTarget.models,
    feelNoPain:
      modifiers.feelNoPain !== undefined ? modifiers.feelNoPain : rawTarget.feelNoPain,
    damageReduction: modifiers.damageReduction ?? rawTarget.damageReduction,
  };
  const weapon = applyAnti(rawWeapon, target);
  const baseAttacks = parseDice(weapon.attacks);
  const baseDamage = parseDice(weapon.damage);
  if (!baseAttacks || !baseDamage) return null;
  if (!strengthDistribution(weapon.strength).size || !Number.isFinite(target.toughness)) return null;

  // [BLAST]: one extra attack per five models in the target, rounding down.
  // No toggle needed -- the target's size is already known.
  const blastBonus = weapon.blast ? weapon.blast * Math.floor(target.models / 5) : 0;
  // [RAPID FIRE X]: X extra attacks within half range.
  const rapidFireBonus = weapon.rapidFire && modifiers.halfRange ? weapon.rapidFire : 0;
  const extraAttacks = blastBonus + rapidFireBonus + (modifiers.attacksModifier ?? 0);

  const perModelAttacks =
    extraAttacks !== 0 ? mapValues(baseAttacks, (a) => Math.max(0, a + extraAttacks)) : baseAttacks;

  // [MELTA X]: X added to the Damage characteristic within half range.
  const meltaBonus = weapon.melta && modifiers.halfRange ? weapon.melta : 0;
  const damageBonus = meltaBonus + (modifiers.damageModifier ?? 0);
  const boosted =
    damageBonus !== 0 ? mapValues(baseDamage, (d) => Math.max(1, d + damageBonus)) : baseDamage;
  // The reroll happens on the rolled characteristic, so after Melta is added.
  const damage = modifiers.rerollDamage ? rerollDamageRoll(boosted) : boosted;

  const attackingModels = Math.max(1, modifiers.attackingModels ?? 1);
  const attackCounts = repeat(perModelAttacks, attackingModels);

  // Damage reduction bites before Feel No Pain, and never takes an attack
  // below 1 damage -- so it blunts a D6 weapon far more than a volume of D1s.
  const reduction = target.damageReduction ?? 0;
  const reducedDamage =
    reduction > 0 ? mapValues(damage, (d) => (d > 0 ? Math.max(1, d - reduction) : 0)) : damage;

  const woundsLost = woundsLostFrom(reducedDamage, target.feelNoPain);
  const damagePerLandingHit = expected(woundsLost);

  // Two choices the player makes at the table, both resolved by taking
  // whichever actually lands more hits:
  //
  //   - Lethal Hits is optional and forfeits Devastating Wounds.
  //   - A full "re-roll the Wound roll" permits throwing back a successful
  //     non-critical wound to fish for a critical, which only pays off when
  //     criticals are worth more (i.e. with Devastating Wounds).
  const lethalChoices =
    weapon.lethalHits || modifiers.grantLethalHits ? [true, false] : [false];
  const rerollChoices: RerollMode[] =
    modifiers.rerollWounds === 'fishing' ? ['fishing', 'failures'] : [modifiers.rerollWounds ?? 'none'];

  let perAttack: Distribution | null = null;
  for (const useLethal of lethalChoices) {
    for (const rerollWounds of rerollChoices) {
      const candidate = landingHitsPerAttack(
        weapon,
        target,
        { ...modifiers, rerollWounds },
        useLethal
      );
      if (!perAttack || expected(candidate) > expected(perAttack)) perAttack = candidate;
    }
  }

  // Landing hits across every attack. Attacks are independent and identically
  // distributed, so this is a convolution weighted by the attack count.
  const landingHits = mix(
    [...attackCounts].map(([count, weight]) => ({
      weight,
      dist: repeatConvolve(perAttack!, count),
    }))
  );

  const { modelsSlain, woundsRemoved, probabilityDestroyed } = allocate(
    landingHits,
    woundsLost,
    target
  );

  // Damage thrown, ignoring what the target can absorb.
  const totalDamage = expected(landingHits) * damagePerLandingHit;
  const woundPool = target.models * target.wounds;

  return {
    totalDamage,
    woundsRemoved,
    expectedModelsSlain: expected(modelsSlain),
    probabilityDestroyed,
    fractionDestroyed: woundPool === 0 ? 0 : woundsRemoved / woundPool,
    fractionModelsSlain: target.models === 0 ? 0 : expected(modelsSlain) / target.models,
    modelsSlainDistribution: modelsSlain,
    overkillRatio: woundPool === 0 ? 0 : totalDamage / woundPool,
  };
}

/** Convolve a distribution with itself `n` times. */
function repeatConvolve(dist: Distribution, n: number): Distribution {
  let out = constant(0);
  for (let i = 0; i < n; i += 1) out = convolve(out, dist);
  return out;
}

/** One weapon in a unit's loadout, and how many models carry it. */
export interface LoadoutEntry {
  weapon: Weapon;
  /** Models firing this profile. */
  models: number;
  /** Modifiers specific to this entry, layered over the unit-wide ones. */
  modifiers?: Modifiers;
}

/**
 * Resolve a mixed loadout as a single attack.
 *
 * A squad is rarely one weapon repeated. An Intercessor Squad is four bolt
 * rifles, up to two grenade launchers, and a sergeant carrying any of six
 * things -- BSData encodes exactly those limits. Scoring one profile times
 * five models cannot express it.
 *
 * Resolving each weapon separately and adding the results would double-count
 * overkill: two weapons that each "kill" the same last model would report two
 * kills, and both would claim a chance to wipe a unit only one of them
 * finished. So every weapon's landing hits are walked through the *same* unit
 * state in turn, and the unit stops absorbing damage once destroyed.
 */
export function resolveLoadout(
  entries: LoadoutEntry[],
  rawTarget: Target,
  modifiers: Modifiers = {}
): Result | null {
  const streams = entries
    .filter((e) => e.models > 0)
    .map((e) => prepareStream(e.weapon, rawTarget, { ...modifiers, ...e.modifiers }, e.models))
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (!streams.length) return null;

  const target: Target = {
    ...rawTarget,
    models: modifiers.targetModels ?? rawTarget.models,
    feelNoPain: modifiers.feelNoPain !== undefined ? modifiers.feelNoPain : rawTarget.feelNoPain,
    damageReduction: modifiers.damageReduction ?? rawTarget.damageReduction,
  };

  const stride = target.wounds + 1;
  let state = new Map<number, number>([[target.wounds, 1]]); // slain 0, full model
  let totalDamage = 0;

  for (const stream of streams) {
    totalDamage += expected(stream.landingHits) * expected(stream.woundsLost);
    state = advanceState(state, stream.landingHits, stream.woundsLost, target, stride);
  }

  return summariseState(state, target, stride, totalDamage);
}

/** Landing hits and wounds-per-hit for one weapon at a given model count. */
function prepareStream(
  rawWeapon: Weapon,
  rawTarget: Target,
  modifiers: Modifiers,
  attackingModels: number
): { landingHits: Distribution; woundsLost: Distribution } | null {
  const target: Target = {
    ...rawTarget,
    models: modifiers.targetModels ?? rawTarget.models,
    feelNoPain: modifiers.feelNoPain !== undefined ? modifiers.feelNoPain : rawTarget.feelNoPain,
    damageReduction: modifiers.damageReduction ?? rawTarget.damageReduction,
  };
  const weapon = applyAnti(rawWeapon, target);

  const baseAttacks = parseDice(weapon.attacks);
  const baseDamage = parseDice(weapon.damage);
  if (!baseAttacks || !baseDamage) return null;

  const blast = weapon.blast ? weapon.blast * Math.floor(target.models / 5) : 0;
  const rapid = weapon.rapidFire && modifiers.halfRange ? weapon.rapidFire : 0;
  const extra = blast + rapid + (modifiers.attacksModifier ?? 0);
  const perModelAttacks =
    extra !== 0 ? mapValues(baseAttacks, (a) => Math.max(0, a + extra)) : baseAttacks;

  const melta = weapon.melta && modifiers.halfRange ? weapon.melta : 0;
  const damageBonus = melta + (modifiers.damageModifier ?? 0);
  const boosted =
    damageBonus !== 0 ? mapValues(baseDamage, (d) => Math.max(1, d + damageBonus)) : baseDamage;
  const damage = modifiers.rerollDamage ? rerollDamageRoll(boosted) : boosted;

  const reduction = target.damageReduction ?? 0;
  const reduced =
    reduction > 0 ? mapValues(damage, (d) => (d > 0 ? Math.max(1, d - reduction) : 0)) : damage;

  const lethalChoices = weapon.lethalHits || modifiers.grantLethalHits ? [true, false] : [false];
  const rerollChoices: RerollMode[] =
    modifiers.rerollWounds === 'fishing'
      ? ['fishing', 'failures']
      : [modifiers.rerollWounds ?? 'none'];

  let perAttack: Distribution | null = null;
  for (const useLethal of lethalChoices) {
    for (const rerollWounds of rerollChoices) {
      const candidate = landingHitsPerAttack(weapon, target, { ...modifiers, rerollWounds }, useLethal);
      if (!perAttack || expected(candidate) > expected(perAttack)) perAttack = candidate;
    }
  }

  const attackCounts = repeat(perModelAttacks, Math.max(1, attackingModels));
  const landingHits = mix(
    [...attackCounts].map(([count, weight]) => ({ weight, dist: repeatConvolve(perAttack!, count) }))
  );

  return { landingHits, woundsLost: woundsLostFrom(reduced, target.feelNoPain) };
}

/** Push one weapon's landing hits through the shared unit state. */
function advanceState(
  state: Map<number, number>,
  landingHits: Distribution,
  woundsLost: Distribution,
  target: Target,
  stride: number
): Map<number, number> {
  const maxHits = Math.max(...landingHits.keys());
  const snapshots: Array<Map<number, number>> = [state];
  for (let hits = 1; hits <= maxHits; hits += 1) {
    snapshots.push(applyOnePacket(snapshots[hits - 1], woundsLost, target, stride));
  }

  const out = new Map<number, number>();
  for (const [hits, weight] of landingHits) {
    for (const [key, p] of snapshots[Math.min(hits, snapshots.length - 1)]) {
      out.set(key, (out.get(key) ?? 0) + weight * p);
    }
  }
  return out;
}

function applyOnePacket(
  state: Map<number, number>,
  woundsLost: Distribution,
  target: Target,
  stride: number
): Map<number, number> {
  const next = new Map<number, number>();
  for (const [key, pState] of state) {
    const slain = Math.floor(key / stride);
    const remaining = key % stride;

    if (slain >= target.models) {
      next.set(key, (next.get(key) ?? 0) + pState);
      continue;
    }
    for (const [lost, pLost] of woundsLost) {
      const p = pState * pLost;
      if (p === 0) continue;
      const nextKey =
        lost >= remaining
          ? Math.min(slain + 1, target.models) * stride + target.wounds
          : slain * stride + (remaining - lost);
      next.set(nextKey, (next.get(nextKey) ?? 0) + p);
    }
  }
  return next;
}

function summariseState(
  state: Map<number, number>,
  target: Target,
  stride: number,
  totalDamage: number
): Result {
  const modelsSlain: Distribution = new Map();
  let woundsRemoved = 0;
  let probabilityDestroyed = 0;

  for (const [key, p] of state) {
    const slain = Math.floor(key / stride);
    const remaining = key % stride;
    modelsSlain.set(slain, (modelsSlain.get(slain) ?? 0) + p);
    const partial = slain >= target.models ? 0 : target.wounds - remaining;
    woundsRemoved += p * (slain * target.wounds + partial);
    if (slain >= target.models) probabilityDestroyed += p;
  }

  const expectedModelsSlain = expected(modelsSlain);
  const pool = target.models * target.wounds;

  return {
    totalDamage,
    woundsRemoved,
    expectedModelsSlain,
    probabilityDestroyed,
    fractionDestroyed: pool === 0 ? 0 : woundsRemoved / pool,
    fractionModelsSlain: target.models === 0 ? 0 : expectedModelsSlain / target.models,
    modelsSlainDistribution: modelsSlain,
    overkillRatio: pool === 0 ? 0 : totalDamage / pool,
  };
}

/**
 * Expected points of the target destroyed.
 *
 * Valued per model, because that is how a unit actually loses value: a model
 * is either dead or still fighting, and a model on one wound contributes the
 * same as a fresh one. Since `expectedModelsSlain` is an expectation, this
 * also reads correctly for single-model units, where it becomes
 * (chance of killing it) x (its points).
 */
export function pointsDestroyed(result: Result, target: Target, targetPoints: number): number {
  if (!targetPoints || target.models === 0) return 0;
  return (result.expectedModelsSlain / target.models) * targetPoints;
}

/**
 * Points-trade efficiency: value destroyed divided by value spent.
 *
 * 1.0 means the attack pays for itself -- it removes as many points as the
 * attacking unit costs. Above 1.0 the attacker wins the trade. Three 90-point
 * Dragon Knights wiping a 100-point Sternguard squad score 1.11.
 */
export function pointsEfficiency(
  result: Result,
  target: Target,
  targetPoints: number,
  attackerPoints: number
): number {
  if (!attackerPoints) return 0;
  return pointsDestroyed(result, target, targetPoints) / attackerPoints;
}
