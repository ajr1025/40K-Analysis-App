/**
 * Legal loadouts.
 *
 * Both cases here came from cross-checking against another engine: a
 * benchmark ran five Pyrecannons in a Sternguard squad that may take one, and
 * a Shining Spears run missed that the Exarch can swap to a Star Lance. The
 * flat weapon list gave no way to know either.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DataUnit } from './adapt';
import {
  type Loadout,
  chooseModes,
  effectiveMax,
  defaultLoadout,
  loadoutEntries,
  loadoutSize,
  validateLoadout,
  variantsOf,
} from './wargear';
import { resolveLoadout } from './resolve';
import { toTarget } from './adapt';

const DATA = join(process.cwd(), 'public', 'data');
const hasData = existsSync(join(DATA, 'index.json'));
const describeWithData = hasData ? describe : describe.skip;

function load(): Array<DataUnit & { faction: string }> {
  const manifest = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8')) as {
    factions: Array<{ slug: string }>;
  };
  const out: Array<DataUnit & { faction: string }> = [];
  for (const { slug } of manifest.factions) {
    const p = join(DATA, `${slug}.json`);
    if (existsSync(p)) {
      const d = JSON.parse(readFileSync(p, 'utf8'));
      for (const u of d.units) out.push({ ...u, faction: d.name });
    }
  }
  return out;
}

describeWithData('wargear constraints', () => {
  const units = load();
  const unit = (n: string, f?: string) =>
    units.find((u) => u.name.toLowerCase() === n.toLowerCase() && (!f || u.faction.includes(f)))!;

  it('caps the Sternguard special weapon at one model', () => {
    const stern = unit('Sternguard Veteran Squad', 'Space Marines');
    const special = variantsOf(stern).find((v) => /special weapon/i.test(v.name))!;

    expect(special.max).toBe(1);
    expect(special.choices[0].options).toContain('Pyrecannon');

    // Five Pyrecannons — the loadout an earlier benchmark used — is illegal.
    const problems = validateLoadout(stern, {
      selections: [
        { variant: special.name, count: 5, choices: { [special.choices[0].name]: 'Pyrecannon' } },
      ],
    });
    expect(problems.some((p) => /at most 1/.test(p.message))).toBe(true);
  });

  it('offers the Shining Spears Exarch a Star Lance', () => {
    const spears = unit('Shining Spears');
    const exarch = variantsOf(spears).find((v) => /exarch/i.test(v.name))!;
    const weapons = exarch.choices.flatMap((c) => c.options);
    expect(weapons).toContain('Star Lance');
    expect(weapons).toContain('Laser Lance');
  });

  it('keeps the bolt rifle on the grenade-launcher Intercessor', () => {
    const inter = unit('Intercessor Squad', 'Space Marines');
    const launcher = variantsOf(inter).find((v) => /grenade launcher/i.test(v.name))!;

    expect(launcher.max).toBe(2);
    expect(launcher.fixed).toContain('Bolt Rifle');
    expect(launcher.fixed).toContain('Astartes grenade launcher');
  });

  it('starts a choice slot on the standard weapon, not the first listed', () => {
    // BSData's option order is not the datasheet's: the Intercessor
    // Sergeant's slot lists the hand flamer first, so every squad opened with
    // the sergeant holding a flamer and the squad fired four bolt rifles
    // instead of five.
    const inter = unit('Intercessor Squad', 'Space Marines');
    const loadout = defaultLoadout(inter);
    const sergeant = loadout.selections.find((s) => /sergeant/i.test(s.variant))!;

    expect(Object.values(sergeant.choices)).toContain('Bolt Rifle');

    const rifles = loadoutEntries(inter, loadout)
      .filter((e) => e.weapon.name === 'Bolt Rifle')
      .reduce((n, e) => n + e.models, 0);
    expect(rifles).toBe(5);
  });

  it('gives a model the weapon its variant is named for', () => {
    // The weapon is often an inline child entry rather than a link -- a
    // "Windrider with Scatter Laser" links only its close combat weapon and
    // holds the laser as a child. Reading links alone left these models armed
    // with nothing but a knife, so whole units read as harmless.
    const windriders = unit('Windriders');
    for (const variant of variantsOf(windriders)) {
      const named = /with (.+)$/i.exec(variant.name)![1].toLowerCase();
      const carried = variant.fixed.join(' ').toLowerCase();
      expect(`${variant.name}: ${carried}`).toContain(named.split(' ').at(-1)!);
    }
  });

  it('arms almost every weapon-named variant across the roster', () => {
    // A blunt roster-wide guard: most variants named after a weapon should
    // carry something beyond a pistol and a knife. Icons, standards and vox
    // sets legitimately do not, so this is a threshold rather than a zero.
    let named = 0;
    let armed = 0;
    for (const u of units) {
      for (const variant of variantsOf(u)) {
        if (!/\bw\/|\bwith /i.test(variant.name)) continue;
        named += 1;
        const guns = variant.fixed.filter((n) => !/close combat weapon|pistol/i.test(n));
        if (guns.length || variant.choices.length) armed += 1;
      }
    }
    expect(named).toBeGreaterThan(300);
    expect(armed / named).toBeGreaterThan(0.85);
  });

  it('keeps the storm bolter when a Terminator takes the cyclone', () => {
    // The launcher is additive, not a swap. BSData stores it as a bundle
    // entry that links both guns and carries no profile of its own, so it was
    // judged weaponless and the cyclone missile launcher vanished from the
    // datasheet entirely.
    const term = unit('Terminator Squad', 'Space Marines');
    const heavy = variantsOf(term).find((v) => /heavy weapon/i.test(v.name))!;
    const slot = heavy.choices.find((c) => /ranged/i.test(c.name))!;

    const bundle = slot.options.find((o) => /cyclone/i.test(o))!;
    expect(bundle).toBeDefined();
    expect(slot.grants?.[bundle]).toEqual(
      expect.arrayContaining(['Storm bolter', 'Cyclone missile launcher'])
    );

    const entries = loadoutEntries(term, {
      selections: [
        {
          variant: heavy.name,
          count: 1,
          choices: { [slot.name]: bundle, 'Melee Weapon Option': 'Power fist' },
        },
      ],
    });
    const names = entries.map((e) => e.weapon.name);
    expect(names).toContain('Storm bolter');
    expect(names.some((n) => /cyclone missile launcher/i.test(n))).toBe(true);
  });

  it('does not bundle a group of alternatives into one model', () => {
    // "Heavy Weapons" on a War Walker lists five guns to choose one from.
    // Treated as a bundle it armed a single walker with all five.
    const walker = unit('War Walkers');
    for (const variant of variantsOf(walker)) {
      for (const choice of variant.choices) {
        for (const granted of Object.values(choice.grants ?? {})) {
          expect(granted.length).toBeLessThan(4);
        }
      }
    }
  });

  it('fires the firing mode that suits the target', () => {
    // Krak into a Rhino, frag into infantry. Taking the first listed mode had
    // a cyclone missile launcher throwing frag at a vehicle.
    const term = unit('Terminator Squad', 'Space Marines');
    const heavy = variantsOf(term).find((v) => /heavy weapon/i.test(v.name))!;
    const slot = heavy.choices.find((c) => /ranged/i.test(c.name))!;
    const bundle = slot.options.find((o) => /cyclone/i.test(o))!;

    const entries = loadoutEntries(
      term,
      {
        selections: [
          {
            variant: heavy.name,
            count: 1,
            choices: { [slot.name]: bundle, 'Melee Weapon Option': 'Power fist' },
          },
        ],
      },
      undefined,
      true
    );

    const rhino = toTarget(unit('Rhino', 'Space Marines'))!;
    const guardsmen = toTarget(unit('Cadian Shock Troops'))!;

    const vsVehicle = chooseModes(entries, rhino).map((e) => e.weapon.name);
    const vsInfantry = chooseModes(entries, guardsmen).map((e) => e.weapon.name);

    expect(vsVehicle.some((n) => /cyclone.*krak/i.test(n))).toBe(true);
    expect(vsInfantry.some((n) => /cyclone.*frag/i.test(n))).toBe(true);
  });

  it('lets a ten-model squad take two cyclone missile launchers', () => {
    // BSData stores this as a `set` modifier rewriting the max constraint once
    // the squad hits ten models. Reading the constraint alone capped a
    // full-strength squad at the five-model allowance.
    const term = unit('Terminator Squad', 'Space Marines');
    const heavy = variantsOf(term).find((v) => /heavy weapon/i.test(v.name))!;

    expect(effectiveMax(heavy, 5)).toBe(1);
    expect(effectiveMax(heavy, 10)).toBe(2);

    const ten: Loadout = {
      selections: [
        { variant: 'Terminator Sergeant', count: 1, choices: { 'Weapon Option': 'Power fist' } },
        { variant: 'Terminator w/ Power Fist', count: 7, choices: {} },
        {
          variant: heavy.name,
          count: 2,
          choices: {
            'Ranged Weapon Option': 'Cyclone Missile Launcher & Storm Bolter',
            'Melee Weapon Option': 'Power fist',
          },
        },
      ],
    };
    expect(loadoutSize(ten)).toBe(10);
    expect(validateLoadout(term, ten)).toEqual([]);

    // The same two launchers in a five-model squad are illegal.
    const five: Loadout = {
      selections: [
        { variant: 'Terminator Sergeant', count: 1, choices: { 'Weapon Option': 'Power fist' } },
        { variant: 'Terminator w/ Power Fist', count: 2, choices: {} },
        {
          variant: heavy.name,
          count: 2,
          choices: {
            'Ranged Weapon Option': 'Cyclone Missile Launcher & Storm Bolter',
            'Melee Weapon Option': 'Power fist',
          },
        },
      ],
    };
    expect(validateLoadout(term, five).some((p) => /at most 1/.test(p.message))).toBe(true);
  });

  it('scales special-weapon caps with squad size across the roster', () => {
    // The user's rule: doubling the squad doubles the special weapons. Twelve
    // datasheets encode it, and every one should read higher at full strength.
    const scaled: string[] = [];
    for (const u of units) {
      for (const v of variantsOf(u)) {
        if (!v.maxRules?.length) continue;
        const small = effectiveMax(v, 5);
        const large = effectiveMax(v, 20);
        scaled.push(`${u.name}/${v.name}`);
        expect(typeof large === 'number' || large === null).toBe(true);
        if (v.maxRules.some((r) => r.when === 'atLeast' && r.max > (small ?? 0))) {
          expect(large).toBeGreaterThan(small ?? 0);
        }
      }
    }
    expect(scaled.length).toBeGreaterThanOrEqual(10);
  });

  it('extracts model groups nested below the top level', () => {
    // A Crusader Squad reads Crusaders -> Initiates -> models. Stopping at the
    // first level found one Sword Brother in a twenty-model squad; an
    // Indomitor Kill Team came back with no wargear at all.
    const crusaders = unit('Crusader Squad', 'Black Templars');
    const names = variantsOf(crusaders).map((v) => v.name);
    expect(names).toContain('Sword Brother');
    expect(names.some((n) => /Initiate/i.test(n))).toBe(true);
    expect(names.some((n) => /Neophyte/i.test(n))).toBe(true);

    expect(variantsOf(unit('Indomitor Kill Team', 'Deathwatch')).length).toBeGreaterThan(0);
  });

  it('caps an individual option, not just the slot', () => {
    // A Sword Brethren Squad takes two Pyre Pistols, four once it is ten
    // strong, and none below five. The slot's own max says nothing about this
    // -- the cap lives on the option, and on the shared entry it links to.
    const sb = unit('Sword Brethren Squad', 'Black Templars');
    const brother = variantsOf(sb).find((v) => /sword brother/i.test(v.name))!;
    const slot = brother.choices.find((c) => c.optionCaps && 'Pyre Pistol' in c.optionCaps)!;
    const cap = slot.optionCaps!['Pyre Pistol'];

    expect(effectiveMax(cap, 4)).toBe(0);
    expect(effectiveMax(cap, 5)).toBe(2);
    expect(effectiveMax(cap, 10)).toBe(4);
  });

  it('enforces a group cap across sibling variants', () => {
    // Purifiers take two heavy weapons spread over three variants. Nothing
    // checked the group total, so six were allowed.
    const purifiers = unit('Purifier Squad', 'Grey Knights');
    const heavy = (purifiers.wargear ?? []).find((g) => /heavy weapon/i.test(g.name))!;
    expect(heavy.max).toBe(2);

    const overloaded = {
      selections: heavy.variants.map((v) => ({ variant: v.name, count: 2, choices: {} })),
    };
    expect(validateLoadout(purifiers, overloaded).some((p) => /at most 2 models/.test(p.message)))
      .toBe(true);
  });

  it('builds a legal default loadout', () => {
    for (const name of ['Intercessor Squad', 'Sternguard Veteran Squad', 'Infernus Squad']) {
      const u = unit(name, 'Space Marines');
      const loadout = defaultLoadout(u);
      expect(validateLoadout(u, loadout)).toEqual([]);
      expect(loadoutSize(loadout)).toBeGreaterThan(0);
    }
  });

  it('turns a variant into one entry per weapon it carries', () => {
    // The grenade-launcher model fires its bolt rifle as well.
    const inter = unit('Intercessor Squad', 'Space Marines');
    const entries = loadoutEntries(
      inter,
      { selections: [{ variant: 'Intercessor w/ Grenade Launcher', count: 1, choices: {} }] },
      'ranged'
    );
    const names = entries.map((e) => e.weapon.name.toLowerCase());
    expect(names.some((n) => n.includes('bolt rifle'))).toBe(true);
    expect(names.some((n) => n.includes('grenade launcher'))).toBe(true);
  });

  it('scores a legal mixed squad through the engine', () => {
    const inter = unit('Intercessor Squad', 'Space Marines');
    const cadians = unit('Cadian Shock Troops');
    const target = toTarget(cadians)!;

    const loadout = {
      selections: [
        { variant: 'Intercessor', count: 4, choices: {} },
        { variant: 'Intercessor w/ Grenade Launcher', count: 1, choices: {} },
      ],
    };
    expect(loadoutSize(loadout)).toBe(5);

    const entries = loadoutEntries(inter, loadout, 'ranged');
    const result = resolveLoadout(entries, target)!;
    expect(result.totalDamage).toBeGreaterThan(0);
    expect(result.expectedModelsSlain).toBeLessThanOrEqual(target.models);
  });

  it('rejects a variant that is not in the unit', () => {
    const inter = unit('Intercessor Squad', 'Space Marines');
    const problems = validateLoadout(inter, {
      selections: [{ variant: 'Terminator', count: 1, choices: {} }],
    });
    expect(problems.some((p) => /not a model in this unit/.test(p.message))).toBe(true);
  });

  it('rejects a weapon that is not offered by its choice slot', () => {
    const stern = unit('Sternguard Veteran Squad', 'Space Marines');
    const special = variantsOf(stern).find((v) => /special weapon/i.test(v.name))!;
    const problems = validateLoadout(stern, {
      selections: [
        { variant: special.name, count: 1, choices: { [special.choices[0].name]: 'Lascannon' } },
      ],
    });
    expect(problems.some((p) => /is not an option/.test(p.message))).toBe(true);
  });

  it('extracts a wargear tree for nearly every multi-model unit', () => {
    // Single-model characters and vehicles have no variants to extract, so
    // measuring against the whole roster understates this badly. What matters
    // is units that can actually be built more than one way.
    const multiModel = units.filter((u) => {
      const sizes = (u.points ?? []).map((t) => t.models);
      return sizes.length > 0 && Math.min(...sizes) > 1;
    });
    const withTree = multiModel.filter((u) => (u.wargear ?? []).length > 0);

    expect(multiModel.length).toBeGreaterThan(300);
    expect(withTree.length / multiModel.length).toBeGreaterThan(0.9);
  });
});
