/**
 * Standing guard over the data that feeds the engine.
 *
 * The upstream repos change under us, and every problem caught here was one
 * that produced a confidently wrong number rather than an error: weapons
 * silently dropped for an unreadable characteristic, duplicated profiles,
 * keywords whose capitalisation defeated de-duplication. Thresholds are set
 * just above where the data sits today, so a regression trips them without
 * routine upstream churn causing noise.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type DataUnit, bulkProfile, toTarget, toWeapon } from './adapt';
import { parseDice } from './dice';

const DATA = join(process.cwd(), 'public', 'data');
const hasData = existsSync(join(DATA, 'index.json'));
const describeWithData = hasData ? describe : describe.skip;

/**
 * Load every faction listed in the manifest.
 *
 * Driven by index.json rather than by globbing the directory, because the
 * pipeline also writes meta files there (search.json) whose shape is nothing
 * like a faction's -- globbing picked those up and crashed on the first unit.
 */
function loadAll(): Array<DataUnit & { faction: string }> {
  const manifest = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8')) as {
    factions: Array<{ slug: string }>;
  };

  const out: Array<DataUnit & { faction: string }> = [];
  for (const { slug } of manifest.factions) {
    const path = join(DATA, `${slug}.json`);
    if (!existsSync(path)) continue;
    const d = JSON.parse(readFileSync(path, 'utf8'));
    for (const u of d.units) out.push({ ...u, faction: d.name });
  }
  return out;
}

describeWithData('data integrity', () => {
  const units = loadAll();
  const weapons = units.flatMap((u) => u.weapons.map((w) => ({ unit: u, weapon: w })));

  it('has a plausible number of units and weapons', () => {
    // A collapse here means the extraction broke, not that GW deleted the game.
    expect(units.length).toBeGreaterThan(1500);
    expect(weapons.length).toBeGreaterThan(10_000);
  });

  it('lists every faction file in the manifest', () => {
    // The manifest is what the app navigates by, so a faction written to disk
    // but missing from it would be invisible.
    const manifest = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8')) as {
      factions: Array<{ slug: string }>;
    };
    const missing = manifest.factions.filter((f) => !existsSync(join(DATA, `${f.slug}.json`)));
    expect(missing.map((f) => f.slug)).toEqual([]);
    expect(manifest.factions.length).toBeGreaterThan(30);
  });

  it('keeps the search index in step with the faction files', () => {
    const search = JSON.parse(readFileSync(join(DATA, 'search.json'), 'utf8')) as {
      units: Array<{ name: string; slug: string }>;
    };
    // Every unit should be searchable, and every search hit should resolve.
    // Search is the matched-play subset: everything in it must be a real unit
    // in a faction file, but the roster also holds Crucible, Legends and free
    // spawned units that are deliberately not searchable.
    const playable = units.filter(
      (u) =>
        u.basePoints != null &&
        !u.legends &&
        !(u.keywords ?? []).some((k) => k.toLowerCase() === 'crucible')
    );
    expect(search.units.length).toBe(playable.length);
    const slugs = new Set(search.units.map((u) => u.slug));
    for (const slug of slugs) {
      expect(existsSync(join(DATA, `${slug}.json`))).toBe(true);
    }
  });

  it('converts every weapon profile into something the engine can resolve', () => {
    const failures = weapons
      .filter(({ weapon }) => toWeapon(weapon) === null)
      .map(({ unit, weapon }) => `${unit.name} / ${weapon.name} (S=${weapon.strength})`);
    expect(failures).toEqual([]);
  });

  it('converts every unit into a target', () => {
    const failures = units.filter((u) => !toTarget(u)).map((u) => u.name);
    expect(failures).toEqual([]);
  });

  it('has readable Attacks and Damage on every weapon', () => {
    const failures = weapons
      .filter(({ weapon }) => !parseDice(weapon.attacks) || !parseDice(weapon.damage))
      .map(({ unit, weapon }) => `${unit.name} / ${weapon.name}`);
    expect(failures).toEqual([]);
  });

  it('does not list the same weapon twice on one unit', () => {
    // BSData carries both "Power fist" and "Power Fist"; a case-sensitive key
    // kept them as two separate options.
    const duplicates: string[] = [];
    for (const unit of units) {
      const seen = new Set<string>();
      for (const w of unit.weapons) {
        const key = `${w.kind}:${w.name.toLowerCase()}`;
        if (seen.has(key)) duplicates.push(`${unit.name}: ${key}`);
        seen.add(key);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it('spells weapon keywords consistently', () => {
    // Parsing is case-insensitive, but inconsistent casing breaks grouping and
    // de-duplication, and looks wrong in the UI.
    const variants = new Map<string, Set<string>>();
    for (const { weapon } of weapons) {
      for (const k of weapon.keywords) {
        const lower = k.toLowerCase();
        if (!variants.has(lower)) variants.set(lower, new Set());
        variants.get(lower)!.add(k);
      }
    }
    const inconsistent = [...variants.entries()]
      .filter(([, v]) => v.size > 1)
      .map(([k, v]) => `${k}: ${[...v].join(' | ')}`);
    expect(inconsistent).toEqual([]);
  });

  it('agrees between a weapon"s kind and its range', () => {
    const mismatches = weapons
      .filter(({ weapon }) => weapon.kind === 'ranged' && /melee/i.test(weapon.range ?? ''))
      .map(({ unit, weapon }) => `${unit.name} / ${weapon.name}`);
    expect(mismatches).toEqual([]);
  });

  it('keeps statlines inside the range real datasheets use', () => {
    // Bounds come from the largest real models: a Warlord Titan is W100.
    const problems: string[] = [];
    for (const unit of units) {
      const t = toTarget(unit);
      if (!t) continue;
      if (t.toughness < 1 || t.toughness > 20) problems.push(`${unit.name}: T${t.toughness}`);
      if (t.wounds < 1 || t.wounds > 120) problems.push(`${unit.name}: W${t.wounds}`);
      if (t.save < 2 || t.save > 7) problems.push(`${unit.name}: Sv${t.save}`);
      if (t.invulnerable != null && (t.invulnerable < 2 || t.invulnerable > 6)) {
        problems.push(`${unit.name}: invuln ${t.invulnerable}`);
      }
      if (t.feelNoPain != null && (t.feelNoPain < 2 || t.feelNoPain > 6)) {
        problems.push(`${unit.name}: FNP ${t.feelNoPain}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('does not grant an invulnerable save from a situational ability', () => {
    // Ork Boyz have no invulnerable save on their statline, but [Waaagh!]
    // mentions one. Reading that as permanent gave every Boy a 5++ and
    // under-counted damage against them by about 20% -- caught by comparing
    // against another engine, not by any test here. 47 units were affected.
    const boyz = units.find((u) => u.name === 'Boyz');
    if (boyz) expect(toTarget(boyz)!.invulnerable).toBeNull();

    const beastSnagga = units.find((u) => u.name === 'Beast Snagga Boyz');
    if (beastSnagga) expect(toTarget(beastSnagga)!.invulnerable).toBeNull();

    // Nothing carrying a once-per-battle or phase-scoped ability should end
    // up with a permanent invulnerable save derived from its text.
    const phantom: string[] = [];
    for (const unit of units) {
      const model = unit.models.at(-1);
      const onStatline = model?.invulnerable != null && model.invulnerable !== '';
      if (onStatline) continue;
      const target = toTarget(unit);
      if (target?.invulnerable == null) continue;

      const source = unit.abilities.find((a) => /(\d)\+\s*invulnerable save/i.test(a.text ?? ''));
      if (source && /once per|at the start of|until the|you can call/i.test(source.text)) {
        phantom.push(`${unit.name} — [${source.name}]`);
      }
    }
    expect(phantom).toEqual([]);
  });

  it('models a character as itself, not as its attendant', () => {
    // Ghazghkull Thraka's datasheet carries Makari, a one-wound grot. The
    // "weakest rank-and-file profile" rule that correctly picks the Boy over
    // the Boss Nob picks the grot over the warboss, turning a 235-point
    // character into something a 25-point Datasmith deletes. Found by the full
    // cross-product sweep as a 931% efficiency outlier.
    const named: Array<[string, number]> = [
      ['Ghazghkull Thraka', 10],
      ['The Silent King', 16],
      ['Fabius Bile', 5],
    ];

    for (const [name, expectedWounds] of named) {
      const unit = units.find((u) => u.name === name);
      if (!unit) continue;
      const target = toTarget(unit)!;
      expect(`${name}: W${target.wounds}`).toBe(`${name}: W${expectedWounds}`);
      // And the attendant must not inflate the wound pool either.
      expect(target.models).toBe(1);
    }
  });

  it('never picks a wildly weaker profile than the unit has', () => {
    // Generalises the case above: if a datasheet's chosen profile is a small
    // fraction of its strongest, something is being mis-selected.
    const problems: string[] = [];
    for (const unit of units) {
      if (unit.models.length < 2) continue;
      const wounds = unit.models
        .map((m) => Number(m.wounds))
        .filter((n) => Number.isFinite(n));
      if (wounds.length < 2) continue;

      const chosen = Number(bulkProfile(unit)?.wounds);
      const max = Math.max(...wounds);
      if (Number.isFinite(chosen) && max >= chosen * 3 && max - chosen >= 4) {
        problems.push(`${unit.name}: chose W${chosen} of a possible W${max}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('prices most of the roster', () => {
    // The name join between BSData and the MFM is the fragile part of the
    // pipeline; a drop here means it broke rather than that GW dropped units.
    const priced = units.filter((u) => u.basePoints != null).length;
    expect(priced / units.length).toBeGreaterThan(0.9);
  });

  it('finds defensive abilities on a reasonable share of the roster', () => {
    // Feel No Pain is stored two different ways and one of them was missed
    // entirely, so guard the count rather than trusting the parser.
    const withFnp = units.filter((u) => toTarget(u)?.feelNoPain != null).length;
    const withInvuln = units.filter((u) => toTarget(u)?.invulnerable != null).length;
    expect(withFnp).toBeGreaterThan(150);
    expect(withInvuln).toBeGreaterThan(600);
  });

  it('does not attach detachment rules or weapon glossary to datasheets', () => {
    const polluted = units
      .filter((u) =>
        u.abilities.some((a) =>
          /^(torrent|blast|rapid fire|anti|pistol|heavy|assault|melta|precision|command protocols|power matrix)$/i.test(
            a.name
          )
        )
      )
      .map((u) => u.name);
    expect(polluted).toEqual([]);
  });

  it('joins units whose name the two sources spell differently', () => {
    // BSData and the MFM disagree on spelling and on number. Neither mismatch
    // errors -- the unit simply arrives with no points, which reads in the
    // matrix as 0% efficiency rather than as missing data.
    const marines = units.filter((u) => u.faction.includes('Space Marines'));
    const ancient = marines.find((u) => /Ancient in Terminator Arm/i.test(u.name))!;
    expect(ancient.basePoints).toBe(65); // MFM spells it "Armour"

    const dg = units.filter((u) => u.faction.includes('Death Guard'));
    const hauler = dg.find((u) => /Myphitic Blight-hauler/i.test(u.name))!;
    expect(hauler.basePoints).toBe(100); // MFM prices "Blight-Haulers"
  });

  it('leaves only units the points list genuinely does not cover', () => {
    // Crucible is a separate game mode and Legends units are out of matched
    // play, so neither has points by design. What is left should stay small.
    const unpriced = units.filter((u) => u.basePoints == null);
    const scored = unpriced.filter(
      (u) =>
        !(u.keywords ?? []).some((k) => k.toLowerCase() === 'crucible') &&
        !u.legends &&
        (u.keywords ?? []).length > 0 &&
        !/spore|ripper|mucolid|spawn \(/i.test(u.name)
    );
    expect(scored.length).toBeLessThanOrEqual(16);
  });

  it('keeps model profiles and stale entries out of the roster', () => {
    // "Sister Novitiate (Autogun)" is a row inside a datasheet, not a
    // datasheet; plain "Marneus Calgar" is a tenth-edition name the current
    // points list has dropped in favour of "in Armour of Antilochus". Both
    // used to sit in the roster reading as 0%-efficiency units.
    const names = new Set(units.map((u) => u.name));
    for (const gone of [
      'Marneus Calgar',
      'Captain Sicarius',
      'Sister Novitiate (Autogun)',
      'Geminae Superia',
      'Runtherd',
    ]) {
      expect(`${gone}: ${names.has(gone)}`).toBe(`${gone}: false`);
    }

    // The replacements are still there.
    expect(names.has('Marneus Calgar in Armour of Antilochus')).toBe(true);
    expect(names.has('Cato Sicarius')).toBe(true);

    // Every remaining unit carries keywords -- that is what marks a datasheet.
    expect(units.filter((u) => !(u.keywords ?? []).length)).toEqual([]);
  });

  it('prices every unit on its own, at the first-selection rate', () => {
    // 11e charges more for repeat selections, but the app compares units one
    // at a time, so only the price of a unit taken on its own is kept. Values
    // confirmed by the rulebook owner against the printed list.
    const ba = units.filter((u) => u.faction.includes('Blood Angels'));
    const cases: Array<[string, number, number]> = [
      ['Death Company Marines', 85, 160],
      ['Death Company Marines with Bolt Rifles', 80, 155],
      ['Death Company Marines with Jump Packs', 120, 230],
    ];

    for (const [name, five, ten] of cases) {
      const unit = ba.find((u) => u.name === name)!;
      expect(unit.basePoints).toBe(five);
      expect(unit.points?.find((t) => t.models === 5)?.points).toBe(five);
      expect(unit.points?.find((t) => t.models === 10)?.points).toBe(ten);
    }

    const champion = units.find(
      (u) => u.name === "Emperor's Champion" && u.faction.includes('Black Templars')
    )!;
    expect(champion.basePoints).toBe(90);
  });

  it('does not price a unit by one of its add-ons', () => {
    // The MFM lists optional attachments alongside the unit price: a Tidewall
    // Shieldline is 85 points with a 20-point Defence Platform available.
    // Read as a pricing tier the add-on became the cheapest way to field the
    // unit, and the Shieldline was priced at 20.
    const tidewall = units.find((u) => /Tidewall Shieldline/.test(u.name))!;
    expect(tidewall.basePoints).toBe(85);

    const outriders = units.find(
      (u) => u.name === 'Outrider Squad' && u.faction.includes('Space Marines')
    )!;
    expect(outriders.basePoints).toBe(70); // not the 60-point Invader ATV

    // Two prices for the same model count make a lookup ambiguous. The only
    // legitimate case is a unit with two compositions of equal size: Wolf
    // Guard Headtakers field six as either six Headtakers or three plus three
    // Hunting Wolves.
    const ambiguous = units.filter((u) => {
      const seen = new Set<number>();
      return (u.points ?? []).some((t) => {
        if (seen.has(t.models)) return true;
        seen.add(t.models);
        return false;
      });
    });
    expect(ambiguous.map((u) => u.name)).toEqual(
      ambiguous.map(() => 'Wolf Guard Headtakers')
    );
  });
});
