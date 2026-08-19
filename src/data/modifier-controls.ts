/**
 * The modifier controls offered on the analyse page.
 *
 * Declared as data rather than hard-coded into the UI so the panel, the URL
 * state and the "what did I change?" summary all read from one list.
 *
 * Grouping follows how the *rules* behave, not how the UI happens to look,
 * because the difference is load-bearing: roll modifiers are capped at a net
 * +/-1 while characteristic modifiers are not. Presenting them together would
 * invite the assumption that +2 Strength gets clamped, which it does not.
 */

import type { Modifiers } from '../engine/resolve';

export type ControlGroup =
  | 'attacker-rolls'
  | 'attacker-profile'
  | 'granted'
  | 'situation'
  | 'defender';

interface BaseControl {
  /** Key in the engine's Modifiers object. */
  field: keyof Modifiers;
  label: string;
  group: ControlGroup;
  /** Shown as help text; explains the rule, not the control. */
  hint?: string;
}

export interface StepperControl extends BaseControl {
  kind: 'stepper';
  min: number;
  max: number;
  default: number;
  /** True when the +/-1 cap applies, so the UI can say so. */
  capped?: boolean;
}

export interface ToggleControl extends BaseControl {
  kind: 'toggle';
  default: boolean;
}

export interface ChoiceControl extends BaseControl {
  kind: 'choice';
  options: Array<{ value: string | number | null; label: string }>;
  default: string | number | null;
}

export type ModifierControl = StepperControl | ToggleControl | ChoiceControl;

export const CONTROL_GROUPS: Array<{ id: ControlGroup; label: string; note?: string }> = [
  {
    id: 'attacker-rolls',
    label: 'Hit & wound rolls',
    note: 'Modifiers here are capped at a net +1 / -1. Stack as many sources as you like; only the total is clamped.',
  },
  {
    id: 'attacker-profile',
    label: 'Weapon profile',
    note: 'Characteristic changes are NOT capped — "add 2 to Strength" applies in full.',
  },
  { id: 'granted', label: 'Granted abilities', note: 'Keywords a leader, detachment or stratagem hands to the weapon.' },
  { id: 'situation', label: 'Situation' },
  { id: 'defender', label: 'Target' },
];

const REROLL_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'ones', label: 'Rolls of 1' },
  { value: 'failures', label: 'Failed rolls' },
  { value: 'fishing', label: 'Failures + reroll successes to fish for crits' },
];

export const MODIFIER_CONTROLS: ModifierControl[] = [
  // --- hit and wound rolls (capped at net +/-1) ---------------------------
  {
    kind: 'stepper',
    field: 'hitModifier',
    label: 'To hit',
    group: 'attacker-rolls',
    min: -3,
    max: 3,
    default: 0,
    capped: true,
    hint: 'Sum every source. Oath +1, Chaplain +1, target -1 nets to +1.',
  },
  {
    kind: 'stepper',
    field: 'woundModifier',
    label: 'To wound',
    group: 'attacker-rolls',
    min: -3,
    max: 3,
    default: 0,
    capped: true,
  },
  {
    kind: 'choice',
    field: 'rerollHits',
    label: 'Reroll hits',
    group: 'attacker-rolls',
    options: REROLL_OPTIONS,
    default: 'none',
  },
  {
    kind: 'choice',
    field: 'rerollWounds',
    label: 'Reroll wounds',
    group: 'attacker-rolls',
    options: REROLL_OPTIONS,
    default: 'none',
    hint: 'The last option also throws back successful non-critical wounds to hunt for a 6 — a separate, deliberate play that only pays off with Devastating Wounds. Leader buffs never assume it; the app checks both and takes whichever kills more.',
  },
  {
    kind: 'choice',
    field: 'critHitOn',
    label: 'Critical hit on',
    group: 'attacker-rolls',
    options: [
      { value: 6, label: '6+ (normal)' },
      { value: 5, label: '5+' },
      { value: 4, label: '4+' },
    ],
    default: 6,
  },
  {
    kind: 'choice',
    field: 'critWoundOn',
    label: 'Critical wound on',
    group: 'attacker-rolls',
    options: [
      { value: 6, label: '6+ (normal)' },
      { value: 5, label: '5+' },
      { value: 4, label: '4+' },
    ],
    default: 6,
    hint: 'Anti-X is applied automatically when the target has the matching keyword.',
  },

  // --- weapon profile (uncapped) ------------------------------------------
  {
    kind: 'stepper',
    field: 'attacksModifier',
    label: 'Attacks',
    group: 'attacker-profile',
    min: -3,
    max: 6,
    default: 0,
  },
  {
    kind: 'stepper',
    field: 'strengthModifier',
    label: 'Strength',
    group: 'attacker-profile',
    min: -3,
    max: 6,
    default: 0,
  },
  {
    kind: 'stepper',
    field: 'apModifier',
    label: 'Armour penetration',
    group: 'attacker-profile',
    min: 0,
    max: 3,
    default: 0,
    hint: '+1 turns AP-1 into AP-2.',
  },
  {
    kind: 'stepper',
    field: 'damageModifier',
    label: 'Damage',
    group: 'attacker-profile',
    min: -2,
    max: 4,
    default: 0,
  },

  // --- granted abilities ---------------------------------------------------
  {
    kind: 'stepper',
    field: 'grantSustainedHits',
    label: 'Sustained Hits',
    group: 'granted',
    min: 0,
    max: 4,
    default: 0,
    hint: 'Stacks on top of any the weapon already prints.',
  },
  { kind: 'toggle', field: 'grantLethalHits', label: 'Lethal Hits', group: 'granted', default: false },
  {
    kind: 'toggle',
    field: 'grantDevastatingWounds',
    label: 'Devastating Wounds',
    group: 'granted',
    default: false,
  },
  { kind: 'toggle', field: 'grantTwinLinked', label: 'Twin-linked', group: 'granted', default: false },
  {
    kind: 'toggle',
    field: 'grantIgnoresCover',
    label: 'Ignores Cover',
    group: 'granted',
    default: false,
    hint: 'Cancels the target’s Benefit of Cover.',
  },

  // --- situation -----------------------------------------------------------
  {
    kind: 'toggle',
    field: 'halfRange',
    label: 'Within half range',
    group: 'situation',
    default: false,
    hint: 'Switches on Rapid Fire and Melta.',
  },
  {
    kind: 'toggle',
    field: 'charged',
    label: 'Charged this turn',
    group: 'situation',
    default: false,
    hint: 'Switches on Lance.',
  },
  {
    kind: 'stepper',
    field: 'attackingModels',
    label: 'Attacking models',
    group: 'situation',
    min: 1,
    max: 20,
    default: 1,
  },

  // --- target ---------------------------------------------------------------
  {
    kind: 'toggle',
    field: 'cover',
    label: 'Benefit of Cover',
    group: 'defender',
    default: false,
    hint: 'Worsens the attack’s BS by 1. Because it changes the characteristic rather than the roll, it stacks past the +/-1 cap.',
  },
  {
    kind: 'stepper',
    field: 'toughnessModifier',
    label: 'Toughness',
    group: 'defender',
    min: -2,
    max: 2,
    default: 0,
    hint: 'Death Guard’s Afflicted is -1.',
  },
  {
    kind: 'stepper',
    field: 'saveModifier',
    label: 'Save',
    group: 'defender',
    min: -1,
    max: 3,
    default: 0,
    hint: 'Positive worsens the target’s armour save.',
  },
  {
    kind: 'choice',
    field: 'invulnerable',
    label: 'Invulnerable save',
    group: 'defender',
    options: [
      { value: null, label: 'From datasheet' },
      { value: 4, label: '4++' },
      { value: 5, label: '5++' },
      { value: 6, label: '6++' },
    ],
    default: null,
  },
  {
    kind: 'choice',
    field: 'feelNoPain',
    label: 'Feel No Pain',
    group: 'defender',
    options: [
      { value: null, label: 'From datasheet' },
      { value: 4, label: '4+++' },
      { value: 5, label: '5+++' },
      { value: 6, label: '6+++' },
    ],
    default: null,
  },
  {
    kind: 'stepper',
    field: 'damageReduction',
    label: 'Damage reduction',
    group: 'defender',
    min: 0,
    max: 2,
    default: 0,
    hint: 'Blunts big-damage weapons far more than volume fire; never below 1 damage.',
  },
  {
    kind: 'stepper',
    field: 'targetModels',
    label: 'Target unit size',
    group: 'defender',
    min: 1,
    max: 20,
    default: 1,
    hint: 'Also drives Blast, which adds an attack per five models.',
  },
];

/**
 * One-click situations that set several controls at once.
 *
 * These are the combinations that come up every game; setting them by hand
 * each time invites mistakes, particularly the engagement-range penalty, which
 * players routinely forget applies to shooting at all.
 */
export const MODIFIER_PRESETS: Array<{
  id: string;
  label: string;
  hint: string;
  modifiers: Partial<Modifiers>;
}> = [
  {
    id: 'engagement-range',
    label: 'Shooting in engagement range',
    hint: '-1 to hit for making ranged attacks while enemies are within Engagement Range.',
    modifiers: { hitModifier: -1 },
  },
  {
    id: 'target-in-cover',
    label: 'Target in cover',
    hint: 'Worsens BS by 1. Only Infantry, Beasts and Swarms get cover from terrain.',
    modifiers: { cover: true },
  },
  {
    id: 'oath-style-rerolls',
    label: 'Full rerolls to hit',
    hint: 'Oath of Moment and similar army rules.',
    modifiers: { rerollHits: 'failures' },
  },
  {
    id: 'close-range',
    label: 'Close range',
    hint: 'Within half range: Rapid Fire and Melta both switch on.',
    modifiers: { halfRange: true },
  },
  {
    id: 'charging',
    label: 'Charging',
    hint: 'Switches on Lance.',
    modifiers: { charged: true },
  },
];

/** Everything at its default, as the starting state for the panel. */
export function defaultModifiers(): Modifiers {
  const out: Record<string, unknown> = {};
  for (const control of MODIFIER_CONTROLS) {
    out[control.field] = control.default;
  }
  return out as Modifiers;
}

/** Only the controls the user actually changed, for a compact summary or URL. */
export function changedModifiers(current: Modifiers): Array<{ control: ModifierControl; value: unknown }> {
  const out: Array<{ control: ModifierControl; value: unknown }> = [];
  for (const control of MODIFIER_CONTROLS) {
    const value = (current as Record<string, unknown>)[control.field];
    if (value !== undefined && value !== control.default) out.push({ control, value });
  }
  return out;
}
