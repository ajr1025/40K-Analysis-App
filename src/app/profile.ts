/**
 * What a weapon's profile becomes once the modifiers are applied.
 *
 * The datasheet prints one set of numbers and the game plays another: an
 * Intercessor firing into cover is not hitting on a 3+, and a squad under The
 * Red Thirst is not swinging at Strength 4. Showing the printed value alone
 * makes the player do that arithmetic in their head, and makes a wrong number
 * impossible to spot.
 *
 * So each characteristic is resolved and reported alongside what was printed,
 * and the UI marks the ones that moved.
 */

import type { DataWeapon } from '../engine/adapt';
import type { Modifiers } from '../engine/resolve';

export interface Shown {
  value: string;
  /** True when a modifier moved it off the printed value. */
  changed: boolean;
  /** What the datasheet says, for the tooltip. */
  printed: string;
  /**
   * Where a bonus is added to a roll rather than replacing a number, the two
   * halves are kept apart so the UI can show "D6" plainly and "+2" as the
   * addition it is. A melta rifle inside half range is not a different weapon;
   * it is the same weapon with two more damage, and that reads better than a
   * "D6+2" that gives no clue where the 2 came from.
   */
  base?: string;
  bonus?: string;
  /** Why the bonus applies, for the tooltip. */
  reason?: string;
}

const plain = (value: string): Shown => ({ value, changed: false, printed: value });

function moved(printed: string, value: string, parts?: { base: string; bonus: string; reason?: string }): Shown {
  return { value, changed: value !== printed, printed, ...parts };
}

/**
 * The +/-1 cap on roll modifiers, mirrored here so the displayed skill matches
 * what the engine actually rolls. Benefit of Cover sits outside it because it
 * worsens the Ballistic Skill characteristic rather than the roll.
 */
const cap = (n: number) => Math.max(-1, Math.min(1, n));

export function shownProfile(
  weapon: DataWeapon,
  modifiers: Modifiers
): { attacks: Shown; skill: Shown; strength: Shown; ap: Shown; damage: Shown } {
  const m = modifiers;
  const melee = weapon.kind === 'melee';
  const keywords = (weapon.keywords ?? []).map((k) => k.toLowerCase());
  const has = (needle: string) => keywords.some((k) => k.startsWith(needle));

  // --- attacks: Rapid Fire and Blast are situational, so only the flat
  // modifier is shown here; the cell resolves the rest against a real target.
  const attacksBonus = m.attacksModifier ?? 0;
  const rapid = /rapid fire\s*(\d+)/i.exec((weapon.keywords ?? []).join(' '));
  const rapidBonus = m.halfRange && rapid ? Number(rapid[1]) : 0;
  const attacks = numeric(weapon.attacks, attacksBonus + rapidBonus);

  // --- skill: hit modifiers are capped, cover is not
  const printedSkill = weapon.skill ?? (has('torrent') ? 'N/A' : '—');
  let skill = plain(printedSkill);
  const base = parseInt(printedSkill, 10);
  if (Number.isFinite(base)) {
    const rollModifier = cap((m.hitModifier ?? 0) + (m.stationary && has('heavy') ? 1 : 0));
    const coverPenalty = m.cover && !melee && !has('ignores cover') ? 1 : 0;
    const effective = Math.max(2, Math.min(6, base - rollModifier + coverPenalty));
    skill = moved(printedSkill, `${effective}+`);
  }

  // --- strength, AP, damage
  const strength = numeric(weapon.strength, m.strengthModifier ?? 0);

  const printedAp = weapon.ap ?? '0';
  const apMagnitude = Math.abs(parseInt(printedAp, 10) || 0) + (m.apModifier ?? 0);
  const ap = moved(printedAp, apMagnitude === 0 ? '0' : `-${apMagnitude}`);

  const meltaBonus = m.halfRange ? meltaValue(weapon) : 0;
  const damage = numeric(
    weapon.damage,
    (m.damageModifier ?? 0) + meltaBonus,
    meltaBonus ? `Melta ${meltaBonus} — within half range` : undefined
  );

  return { attacks, skill, strength, ap, damage };
}

function meltaValue(weapon: DataWeapon): number {
  const match = /melta\s*(\d+)/i.exec((weapon.keywords ?? []).join(' '));
  return match ? Number(match[1]) : 0;
}

/**
 * Add a bonus to a characteristic that may be a die expression.
 *
 * "D6" with +2 becomes "D6+2" rather than a number, because the roll is still
 * a roll — collapsing it to an average here would disagree with the engine.
 */
function numeric(printed: string | null, bonus: number, reason?: string): Shown {
  const text = printed ?? '—';
  if (!bonus) return plain(text);

  // A fixed characteristic just becomes a different number.
  const fixed = Number(text);
  if (Number.isFinite(fixed)) return moved(text, String(Math.max(0, fixed + bonus)));

  // A die expression keeps its roll and carries the bonus alongside, so the
  // addition stays visible as an addition.
  const tail = /([+-])\s*(\d+)$/.exec(text);
  if (tail) {
    const total = Number(tail[1] + tail[2]) + bonus;
    const head = text.slice(0, tail.index);
    const suffix = total === 0 ? '' : `${total > 0 ? '+' : ''}${total}`;
    return moved(text, `${head}${suffix}`, { base: head, bonus: suffix, reason });
  }

  const suffix = `${bonus > 0 ? '+' : ''}${bonus}`;
  return moved(text, `${text}${suffix}`, { base: text, bonus: suffix, reason });
}
