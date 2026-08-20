/**
 * What a weapon's profile becomes once the modifiers are applied, and why.
 *
 * The datasheet prints one set of numbers and the game plays another: an
 * Intercessor firing into cover is not hitting on a 3+, and a squad under The
 * Red Thirst is not swinging at Strength 4. Showing the printed value alone
 * makes the player do that arithmetic in their head, and makes a wrong number
 * impossible to spot.
 *
 * Each characteristic is resolved, marked when it moved, and carries the list
 * of things that moved it — so a 4+ reads back as "printed 3+, −1 from cover"
 * rather than being taken on faith.
 */

import type { DataWeapon } from '../engine/adapt';
import type { ConditionalBuff } from '../engine/conditions';
import type { Modifiers } from '../engine/resolve';
import type { TargetEntry } from './board';

export interface Shown {
  value: string;
  /** True when something moved it off the printed value. */
  changed: boolean;
  printed: string;
  /**
   * Where a bonus adds to a roll rather than replacing a number, the halves
   * are kept apart: a melta rifle in half range is the same D6 with two more
   * damage, not a different weapon.
   */
  base?: string;
  bonus?: string;
  /** One line per contributing modifier. */
  reasons: string[];
}

type Field =
  | 'hitModifier'
  | 'attacksModifier'
  | 'strengthModifier'
  | 'apModifier'
  | 'damageModifier';

interface Contribution {
  amount: number;
  source: string;
}

const sign = (n: number) => (n > 0 ? `+${n}` : `−${Math.abs(n)}`);

/** Net roll modifiers cap at +/-1 however many sources stack. */
const cap = (n: number) => Math.max(-1, Math.min(1, n));

export function shownProfile(
  weapon: DataWeapon,
  /** What the player set in the drawer. */
  drawer: Modifiers,
  /** Rules acting on this weapon: detachment, abilities, leader, army rule. */
  buffs: ConditionalBuff[] = [],
  /** The target being looked at, when the view is showing one. */
  target?: TargetEntry
): { attacks: Shown; skill: Shown; strength: Shown; ap: Shown; damage: Shown } {
  const melee = weapon.kind === 'melee';
  const keywords = (weapon.keywords ?? []).map((k) => k.toLowerCase());
  const has = (needle: string) => keywords.some((k) => k.startsWith(needle));

  const parts: Record<Field, Contribution[]> = {
    hitModifier: [],
    attacksModifier: [],
    strengthModifier: [],
    apModifier: [],
    damageModifier: [],
  };

  const add = (field: Field, amount: number | undefined, source: string) => {
    if (amount) parts[field].push({ amount, source });
  };

  add('hitModifier', drawer.hitModifier, 'Modifiers');
  add('attacksModifier', drawer.attacksModifier, 'Modifiers');
  if (melee) add('attacksModifier', drawer.meleeAttacksModifier, 'Modifiers · melee only');
  add('strengthModifier', drawer.strengthModifier, 'Modifiers');
  add('apModifier', drawer.apModifier, 'Modifiers');
  add('damageModifier', drawer.damageModifier, 'Modifiers');

  for (const buff of buffs) {
    for (const field of Object.keys(parts) as Field[]) {
      add(field, buff.modifiers[field], buff.source);
    }
  }

  // Keywords that only bite in the right situation.
  if (drawer.stationary && has('heavy')) {
    parts.hitModifier.push({ amount: 1, source: '[HEAVY] · remained stationary' });
  }
  const rapid = keywordValue(weapon, /rapid fire\s*(\d+)/i);
  if (drawer.halfRange && rapid) {
    parts.attacksModifier.push({ amount: rapid, source: `[RAPID FIRE ${rapid}] · half range` });
  }
  const melta = keywordValue(weapon, /melta\s*(\d+)/i);
  if (drawer.halfRange && melta) {
    parts.damageModifier.push({ amount: melta, source: `[MELTA ${melta}] · half range` });
  }

  // The defender's own abilities blunt the attack before it lands, and the
  // player is reading this to decide whether it is worth shooting.
  const reduction = target?.target.damageReduction ?? 0;
  if (reduction) {
    parts.damageModifier.push({
      amount: -reduction,
      source: `${target!.unit.name} · damage reduction`,
    });
  }

  const total = (field: Field) => parts[field].reduce((n, c) => n + c.amount, 0);

  return {
    attacks: numeric(weapon.attacks, total('attacksModifier'), lines(parts.attacksModifier, 'Attacks'), 0),
    skill: skillOf(weapon, drawer, parts.hitModifier, melee, has),
    strength: numeric(weapon.strength, total('strengthModifier'), lines(parts.strengthModifier, 'Strength'), 1),
    ap: apOf(weapon, total('apModifier'), lines(parts.apModifier, 'AP')),
    // Damage is never reduced below 1, which is why a −1 ability blunts a
    // big-damage weapon far more than it blunts volume fire.
    damage: numeric(weapon.damage, total('damageModifier'), lines(parts.damageModifier, 'Damage'), 1),
  };
}

function skillOf(
  weapon: DataWeapon,
  drawer: Modifiers,
  contributions: Contribution[],
  melee: boolean,
  has: (needle: string) => boolean
): Shown {
  const printed = weapon.skill ?? (has('torrent') ? 'N/A' : '—');
  const base = parseInt(printed, 10);
  if (!Number.isFinite(base)) return plain(printed);

  const raw = contributions.reduce((n, c) => n + c.amount, 0);
  const capped = cap(raw);
  const label = melee ? 'Weapon Skill' : 'Ballistic Skill';

  const reasons = lines(contributions, 'to hit');
  if (raw !== capped) reasons.push(`net roll modifiers cap at ${sign(capped)}`);

  // Benefit of Cover worsens the characteristic rather than the roll, so it
  // stacks on top of a capped −1 for an effective −2.
  const cover = drawer.cover && !melee && !has('ignores cover') ? 1 : 0;
  if (cover) reasons.push(`−1 ${label} · Benefit of Cover, outside the cap`);

  const effective = Math.max(2, Math.min(6, base - capped + cover));
  const value = `${effective}+`;
  return { value, changed: value !== printed, printed, reasons };
}

function apOf(weapon: DataWeapon, bonus: number, reasons: string[]): Shown {
  const printed = weapon.ap ?? '0';
  const magnitude = Math.max(0, Math.abs(parseInt(printed, 10) || 0) + bonus);
  const value = magnitude === 0 ? '0' : `-${magnitude}`;
  return { value, changed: value !== printed, printed, reasons };
}

/** "+2 Strength · The Red Thirst" */
function lines(contributions: Contribution[], what: string): string[] {
  return contributions.map((c) => `${sign(c.amount)} ${what} · ${c.source}`);
}

function keywordValue(weapon: DataWeapon, pattern: RegExp): number {
  const match = pattern.exec((weapon.keywords ?? []).join(' '));
  return match ? Number(match[1]) : 0;
}

const plain = (value: string): Shown => ({ value, changed: false, printed: value, reasons: [] });

/**
 * Add a bonus to a characteristic that may be a die expression.
 *
 * A fixed number becomes a different number, floored where the rules floor it.
 * A die keeps its roll and carries the bonus alongside, so the addition stays
 * visible as an addition — and collapsing "D6+2" to an average here would
 * disagree with the engine, which resolves the die exactly.
 */
function numeric(
  printed: string | null,
  bonus: number,
  reasons: string[],
  floor: number
): Shown {
  const text = printed ?? '—';
  if (!bonus) return plain(text);

  // A reduction can never take a characteristic below its floor, and saying so
  // matters: a -1 ability blunts a D6 weapon far less than the arithmetic
  // suggests, because every roll is floored individually rather than the
  // average being shifted.
  const floored =
    bonus < 0 && floor > 0 ? [...reasons, `never reduced below ${floor}`] : reasons;

  const fixed = Number(text);
  if (Number.isFinite(fixed)) {
    const value = String(Math.max(floor, fixed + bonus));
    return { value, changed: value !== text, printed: text, reasons: floored };
  }

  const tail = /([+-])\s*(\d+)$/.exec(text);
  if (tail) {
    const total = Number(tail[1] + tail[2]) + bonus;
    const head = text.slice(0, tail.index);
    const suffix = total === 0 ? '' : sign(total).replace('−', '-');
    return { value: `${head}${suffix}`, changed: true, printed: text, base: head, bonus: suffix, reasons: floored };
  }

  const suffix = sign(bonus).replace('−', '-');
  return { value: `${text}${suffix}`, changed: true, printed: text, base: text, bonus: suffix, reasons: floored };
}
