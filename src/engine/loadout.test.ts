/**
 * Mixed loadouts: a squad resolved as the weapons it actually carries.
 *
 * An Intercessor Squad is four bolt rifles, up to two grenade launchers, and a
 * sergeant holding one of six things. Scoring one profile times five models
 * cannot express that, and scoring each weapon separately and adding the
 * results double-counts overkill — two weapons that each "finish" the same
 * last model would report two kills and two chances to wipe.
 */

import { describe, expect, it } from 'vitest';

import { type Target, type Weapon, resolveAttack, resolveLoadout } from './resolve';

const weapon = (o: Partial<Weapon> = {}): Weapon => ({
  name: 'w',
  attacks: '1',
  skill: 3,
  strength: 4,
  ap: 0,
  damage: '1',
  torrent: true,
  ...o,
});

const target = (o: Partial<Target> = {}): Target => ({
  name: 't',
  toughness: 4,
  save: 7,
  wounds: 1,
  models: 10,
  ...o,
});

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe('resolving a mixed loadout', () => {
  it('matches the single-weapon path when the loadout is one weapon', () => {
    const w = weapon({ attacks: '2', strength: 6 });
    const t = target();

    const single = resolveAttack(w, t, { attackingModels: 5 })!;
    const loadout = resolveLoadout([{ weapon: w, models: 5 }], t)!;

    near(loadout.totalDamage, single.totalDamage);
    near(loadout.expectedModelsSlain, single.expectedModelsSlain);
    near(loadout.probabilityDestroyed, single.probabilityDestroyed);
    near(loadout.woundsRemoved, single.woundsRemoved);
  });

  it('adds the damage of every weapon in the loadout', () => {
    // 4 bolt rifles plus 1 grenade launcher, against a target large enough
    // that nothing is wasted.
    const rifle = weapon({ name: 'Bolt Rifle', attacks: '2', strength: 4 });
    const launcher = weapon({ name: 'Grenade Launcher', attacks: '1', strength: 9, damage: '2' });
    const t = target({ models: 20, toughness: 4 });

    const result = resolveLoadout(
      [
        { weapon: rifle, models: 4 },
        { weapon: launcher, models: 1 },
      ],
      t
    )!;

    const rifleOnly = resolveAttack(rifle, t, { attackingModels: 4 })!;
    const launcherOnly = resolveAttack(launcher, t, { attackingModels: 1 })!;

    near(result.totalDamage, rifleOnly.totalDamage + launcherOnly.totalDamage);
  });

  it('does not double-count kills across weapons', () => {
    // Two weapons that would each wipe a small unit on their own must not
    // report two wipes, or two units' worth of kills.
    const heavy = weapon({ attacks: '10', strength: 20, damage: '2' });
    const t = target({ models: 3, wounds: 1, toughness: 4 });

    const result = resolveLoadout(
      [
        { weapon: heavy, models: 1 },
        { weapon: heavy, models: 1 },
      ],
      t
    )!;

    expect(result.expectedModelsSlain).toBeLessThanOrEqual(3 + 1e-9);
    expect(result.probabilityDestroyed).toBeLessThanOrEqual(1 + 1e-9);
    expect(result.woundsRemoved).toBeLessThanOrEqual(3 + 1e-9);
    // The damage thrown, however, is uncapped and should show the overkill.
    expect(result.totalDamage).toBeGreaterThan(20);
    expect(result.overkillRatio).toBeGreaterThan(6);
  });

  it('is order-independent for the totals that matter', () => {
    const a = weapon({ name: 'a', attacks: '3', strength: 8, damage: '2' });
    const b = weapon({ name: 'b', attacks: '2', strength: 5, damage: '1' });
    const t = target({ models: 5, wounds: 2, toughness: 5, save: 4 });

    const ab = resolveLoadout([{ weapon: a, models: 2 }, { weapon: b, models: 3 }], t)!;
    const ba = resolveLoadout([{ weapon: b, models: 3 }, { weapon: a, models: 2 }], t)!;

    near(ab.totalDamage, ba.totalDamage);
    expect(Math.abs(ab.expectedModelsSlain - ba.expectedModelsSlain)).toBeLessThan(1e-9);
  });

  it('ignores entries with no models carrying them', () => {
    const w = weapon({ attacks: '2' });
    const t = target();
    const withZero = resolveLoadout(
      [{ weapon: w, models: 5 }, { weapon: weapon({ attacks: '10', strength: 20 }), models: 0 }],
      t
    )!;
    const without = resolveLoadout([{ weapon: w, models: 5 }], t)!;
    near(withZero.totalDamage, without.totalDamage);
  });

  it('lets one entry carry its own modifiers', () => {
    // A sergeant's weapon can be buffed independently of the squad's.
    const w = weapon({ attacks: '2', strength: 4, skill: 4, torrent: false });
    const t = target({ models: 20 });

    const plain = resolveLoadout([{ weapon: w, models: 1 }], t)!;
    const buffed = resolveLoadout([{ weapon: w, models: 1, modifiers: { hitModifier: 1 } }], t)!;

    expect(buffed.totalDamage).toBeGreaterThan(plain.totalDamage);
  });

  it('returns null when nothing in the loadout can be modelled', () => {
    expect(resolveLoadout([], target())).toBeNull();
    expect(resolveLoadout([{ weapon: weapon({ damage: '*' }), models: 5 }], target())).toBeNull();
  });

  it('models the real Intercessor Squad shape', () => {
    // 4 bolt rifles, 1 grenade launcher, sergeant with a power fist — the
    // structure BSData actually encodes for this datasheet.
    const boltRifle = weapon({ name: 'Bolt Rifle', attacks: '2', skill: 3, strength: 4, ap: 1, torrent: false });
    const grenade = weapon({ name: 'Grenade launcher', attacks: '1', skill: 3, strength: 9, ap: 2, damage: '3', torrent: false });
    const fist = weapon({ name: 'Power fist', attacks: '3', skill: 3, strength: 8, ap: 2, damage: '2', torrent: false, melee: true });

    const marines = target({ toughness: 4, save: 3, wounds: 2, models: 5 });
    const result = resolveLoadout(
      [
        { weapon: boltRifle, models: 4 },
        { weapon: grenade, models: 1 },
        { weapon: fist, models: 1 },
      ],
      marines
    )!;

    // Sanity: a real squad kills some but not all of an equivalent squad.
    expect(result.expectedModelsSlain).toBeGreaterThan(0.5);
    expect(result.expectedModelsSlain).toBeLessThan(5);
    expect(result.woundsRemoved).toBeLessThanOrEqual(10);
    // And beats any single one of its weapons alone.
    const best = Math.max(
      resolveAttack(boltRifle, marines, { attackingModels: 4 })!.expectedModelsSlain,
      resolveAttack(grenade, marines, { attackingModels: 1 })!.expectedModelsSlain,
      resolveAttack(fist, marines, { attackingModels: 1 })!.expectedModelsSlain
    );
    expect(result.expectedModelsSlain).toBeGreaterThan(best);
  });
});
