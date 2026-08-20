import { describe, expect, it } from 'vitest';

import {
  CONTROL_GROUPS,
  MODIFIER_CONTROLS,
  MODIFIER_PRESETS,
  changedModifiers,
  defaultModifiers,
} from './modifier-controls';
import { resolveAttack, type Modifiers, type Target, type Weapon } from '../engine/resolve';

describe('modifier controls', () => {
  it('gives every control a group that exists', () => {
    const groups = new Set(CONTROL_GROUPS.map((g) => g.id));
    for (const control of MODIFIER_CONTROLS) {
      expect(groups.has(control.group)).toBe(true);
    }
  });

  it('does not offer the same field twice', () => {
    const fields = MODIFIER_CONTROLS.map((c) => c.field);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('keeps every default inside its own range', () => {
    for (const control of MODIFIER_CONTROLS) {
      if (control.kind === 'stepper') {
        expect(control.default).toBeGreaterThanOrEqual(control.min);
        expect(control.default).toBeLessThanOrEqual(control.max);
      }
      if (control.kind === 'choice') {
        expect(control.options.map((o) => o.value)).toContain(control.default);
      }
    }
  });

  it('produces defaults the engine accepts without changing the result', () => {
    // The default state must be a true no-op, or every number in the matrix
    // would be quietly shifted before the user touched anything.
    const weapon: Weapon = { name: 'w', attacks: '2', skill: 3, strength: 4, ap: 1, damage: '1' };
    const target: Target = { name: 't', toughness: 4, save: 3, wounds: 2, models: 5 };

    const bare = resolveAttack(weapon, target, {})!;
    const defaulted = resolveAttack(weapon, target, defaultModifiers())!;

    expect(defaulted.totalDamage).toBeCloseTo(bare.totalDamage, 9);
    expect(defaulted.expectedModelsSlain).toBeCloseTo(bare.expectedModelsSlain, 9);
  });

  it('reports only what the user changed', () => {
    const state: Modifiers = { ...defaultModifiers(), hitModifier: 1, cover: true };
    const changed = changedModifiers(state).map((c) => c.control.field);
    expect(changed).toContain('hitModifier');
    expect(changed).toContain('cover');
    expect(changed).not.toContain('woundModifier');
  });

  it('flags exactly the two capped controls', () => {
    // The cap governs dice rolls only. If a characteristic control is ever
    // marked capped, the UI would tell the user something untrue about it.
    const capped = MODIFIER_CONTROLS.filter((c) => c.kind === 'stepper' && c.capped).map(
      (c) => c.field
    );
    expect(capped.sort()).toEqual(['hitModifier', 'woundModifier']);
  });

  it('has presets that only set real fields', () => {
    const fields = new Set(MODIFIER_CONTROLS.map((c) => c.field));
    for (const preset of MODIFIER_PRESETS) {
      expect(Object.keys(preset.modifiers).length).toBeGreaterThan(0);
      for (const field of Object.keys(preset.modifiers)) {
        expect(fields.has(field as keyof Modifiers)).toBe(true);
      }
      expect(preset.hint).toBeTruthy();
    }
  });

  it('covers every modifier the engine understands', () => {
    // A modifier the engine supports but the panel never exposes is dead
    // capability; this fails when one is added to the engine and forgotten
    // here.
    const exposed = new Set<string>(MODIFIER_CONTROLS.map((c) => c.field));
    const engineFields: Array<keyof Modifiers> = [
      'hitModifier',
      'woundModifier',
      'rerollHits',
      'rerollWounds',
      'critHitOn',
      'critWoundOn',
      'attacksModifier',
      'strengthModifier',
      'apModifier',
      'damageModifier',
      'toughnessModifier',
      'saveModifier',
      'feelNoPain',
      'damageReduction',
      'invulnerable',
      'grantSustainedHits',
      'grantLethalHits',
      'grantDevastatingWounds',
      'grantTwinLinked',
      'grantIgnoresCover',
      'attackingModels',
      'targetModels',
      'halfRange',
      'charged',
      'cover',
    ];
    const missing = engineFields.filter((f) => !exposed.has(f));
    expect(missing).toEqual([]);
  });
});

describe('unset overrides never reach the engine', () => {
  // The highest-impact bug the app has had: the modifier defaults were spread
  // into every resolve, and four of them override a characteristic the target
  // already has. Every multi-model unit resolved as a single model, and every
  // invulnerable save, Feel No Pain and damage reduction was erased -- while
  // 297 engine tests passed, because they hand the engine explicit targets and
  // never go through the app's defaults.

  it('omits target overrides rather than defaulting them', () => {
    const defaults = defaultModifiers() as Record<string, unknown>;
    for (const field of ['targetModels', 'feelNoPain', 'invulnerable', 'damageReduction']) {
      expect(`${field}: ${field in defaults}`).toBe(`${field}: false`);
    }
  });

  it("leaves a target's own defences intact under the defaults", () => {
    const weapon: Weapon = {
      name: 'w', attacks: '10', skill: 3, strength: 8, ap: 0, damage: '1',
    };
    const target: Target = {
      name: 't', toughness: 4, save: 3, invulnerable: 4, wounds: 1, models: 10,
      feelNoPain: 5, damageReduction: 1,
    };

    const withDefaults = resolveAttack(weapon, target, defaultModifiers())!;
    const bare = resolveAttack(weapon, target, {})!;

    expect(withDefaults.expectedModelsSlain).toBeCloseTo(bare.expectedModelsSlain, 9);
    // And the unit is genuinely ten models, not one.
    expect(bare.expectedModelsSlain).toBeGreaterThan(1);
    expect(withDefaults.expectedModelsSlain).toBeGreaterThan(1);
  });

  it('still applies an override the player actually sets', () => {
    const weapon: Weapon = {
      name: 'w', attacks: '10', skill: 3, strength: 8, ap: 0, damage: '1',
    };
    const target: Target = {
      name: 't', toughness: 4, save: 7, wounds: 1, models: 10,
    };
    const capped = resolveAttack(weapon, target, {
      ...defaultModifiers(),
      targetModels: 2,
    })!;
    expect(capped.expectedModelsSlain).toBeLessThanOrEqual(2);
  });
});
