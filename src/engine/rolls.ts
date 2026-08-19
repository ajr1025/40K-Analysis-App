/**
 * D6 threshold probabilities for the hit, wound and save steps.
 *
 * Two 11th-edition rules shape everything here:
 *   - an unmodified 1 always fails, and an unmodified 6 is always a critical
 *     (and always succeeds), regardless of modifiers;
 *   - hit and wound modifiers are capped at a net +1 / -1.
 *
 * Because the natural 1 and 6 are evaluated on the *unmodified* die, the
 * probabilities are computed by enumerating all six faces rather than by
 * arithmetic on the target number -- that keeps the edge cases honest.
 */

/** Net hit/wound modifiers are capped at +1/-1 in 11th edition. */
export const MODIFIER_CAP = 1;

export function capModifier(modifier: number, cap = MODIFIER_CAP): number {
  return Math.max(-cap, Math.min(cap, modifier));
}

export interface RollOutcome {
  /** Probability the roll succeeds at all (criticals included). */
  pass: number;
  /** Probability the roll is a critical (a natural 6, or lower with Anti-X). */
  crit: number;
  /** Probability the roll succeeds without being critical. */
  normal: number;
  fail: number;
}

export interface RollOptions {
  /** Unmodified target number, 2-6. */
  target: number;
  /** Net modifier, capped before use. */
  modifier?: number;
  /**
   * Lowest unmodified face that counts as a critical. 6 normally; Anti-X Y+
   * and similar abilities lower it.
   */
  critOn?: number;
  reroll?: RerollMode;
}

/**
 * Reroll abilities, in the forms the game actually uses.
 *
 * `ones`     - reroll natural 1s.
 * `failures` - reroll anything that failed.
 * `fishing`  - reroll failures AND non-critical successes. Rules that say
 *              "you can re-roll the Wound roll" permit this: with Devastating
 *              Wounds on the weapon it can pay to throw back a successful
 *              non-critical wound while hunting for a 6. It is not always
 *              better, so callers compare it against `failures` and keep
 *              whichever actually kills more.
 */
export type RerollMode = 'none' | 'ones' | 'failures' | 'fishing';

/** Classify a single unmodified face. */
function faceResult(
  face: number,
  target: number,
  modifier: number,
  critOn: number
): 'crit' | 'normal' | 'fail' {
  // Natural 1 always fails, and is never a critical.
  if (face === 1) return 'fail';
  // Criticals are judged on the unmodified roll and always succeed.
  if (face >= critOn) return 'crit';
  return face + modifier >= target ? 'normal' : 'fail';
}

/**
 * Probability of each outcome for one roll against `target`.
 *
 * A reroll is modelled as a second independent roll replacing the first, which
 * is exactly how the rule works -- rerolled dice cannot be rerolled again.
 */
export function roll({
  target,
  modifier = 0,
  critOn = 6,
  reroll = 'none',
}: RollOptions): RollOutcome {
  const mod = capModifier(modifier);
  const clampedTarget = Math.max(2, Math.min(6, target));

  const single = () => {
    const counts = { crit: 0, normal: 0, fail: 0 };
    for (let face = 1; face <= 6; face += 1) {
      counts[faceResult(face, clampedTarget, mod, critOn)] += 1 / 6;
    }
    return counts;
  };

  const first = single();
  if (reroll === 'none') {
    return { ...first, pass: first.crit + first.normal };
  }

  // Portion of the first roll that gets thrown back.
  let rerolledMass: number;
  if (reroll === 'fishing') {
    // Everything except a critical goes back for another try.
    rerolledMass = first.fail + first.normal;
  } else if (reroll === 'failures') {
    rerolledMass = first.fail;
  } else {
    // Only natural 1s, which always fail.
    rerolledMass = 1 / 6;
  }

  const kept =
    reroll === 'fishing'
      ? { crit: first.crit, normal: 0, fail: 0 }
      : { crit: first.crit, normal: first.normal, fail: first.fail - rerolledMass };

  const second = single();
  const combined = {
    crit: kept.crit + rerolledMass * second.crit,
    normal: kept.normal + rerolledMass * second.normal,
    fail: kept.fail + rerolledMass * second.fail,
  };

  return { ...combined, pass: combined.crit + combined.normal };
}

/**
 * The wound roll target from the 11th-edition Strength vs Toughness table.
 */
export function woundTarget(strength: number, toughness: number): number {
  if (strength >= toughness * 2) return 2;
  if (strength > toughness) return 3;
  if (strength === toughness) return 4;
  if (strength * 2 <= toughness) return 6;
  return 5;
}

/**
 * Probability a saving throw *fails*, which is what the damage step needs.
 *
 * In 11th edition the defender makes one roll that can pass either by meeting
 * the invulnerable save or by meeting the armour save after AP. That is
 * equivalent to rolling against whichever target is lower, so the invulnerable
 * save effectively caps how far AP can push the armour save.
 */
export function saveFailChance({
  armour,
  invulnerable,
  ap,
}: {
  /** Armour save, e.g. 3 for 3+. */
  armour: number;
  /** Invulnerable save, or null if the model has none. */
  invulnerable?: number | null;
  /** Armour penetration as a positive magnitude (AP-2 is 2). */
  ap: number;
}): number {
  // No save is better than 2+, and an unmodified 1 always fails.
  // Cover deliberately plays no part here: in 11th edition it worsens the
  // attacker's Ballistic Skill rather than improving this save.
  const modifiedArmour = Math.max(2, armour + ap);

  const target =
    invulnerable != null ? Math.min(modifiedArmour, Math.max(2, invulnerable)) : modifiedArmour;

  if (target > 6) return 1; // cannot save at all
  // Natural 1 always fails, so success is capped at 5/6.
  const successFaces = Math.min(6 - target + 1, 5);
  return 1 - successFaces / 6;
}
