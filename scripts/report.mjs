/**
 * Dataset reports for eyeballing what the app will show.
 *
 *   node scripts/report.mjs toughness   -- unit counts per toughness band
 *   node scripts/report.mjs band 4      -- the units sitting at a given toughness
 *
 * Reads the generated public/data, so run `npm run data` first.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA = join(process.cwd(), 'public', 'data');

function loadAll() {
  const units = [];
  for (const file of readdirSync(DATA)) {
    if (file === 'index.json') continue;
    const faction = JSON.parse(readFileSync(join(DATA, file), 'utf8'));
    for (const unit of faction.units) units.push({ ...unit, faction: faction.name });
  }
  return units;
}

/** The bulk profile: the last listed model is the squad body, not the sergeant. */
function profileOf(unit) {
  const model = unit.models.at(-1);
  if (!model) return null;
  const toughness = Number(model.toughness);
  const wounds = Number(model.wounds);
  if (!Number.isFinite(toughness) || !Number.isFinite(wounds)) return null;
  return { toughness, wounds, save: model.save, invuln: model.invulnerable };
}

function isInfantryish(unit) {
  const kw = unit.keywords.map((k) => k.toLowerCase());
  return kw.includes('infantry') || kw.includes('beast') || kw.includes('swarm');
}

const units = loadAll();
const command = process.argv[2] ?? 'toughness';

if (command === 'audit') {
  // Flag anything outside the range a real datasheet can hold. These are data
  // problems, not engine problems, and they would surface as silently wrong
  // numbers rather than as errors.
  const problems = { statline: [], weapons: [], points: [] };
  let weaponCount = 0;
  let unmodellable = 0;

  for (const unit of units) {
    const p = profileOf(unit);
    if (!p) {
      problems.statline.push(`${unit.name}: no readable statline`);
    } else {
      // Bounds are set by the largest real datasheets -- a Warlord Titan is
      // W100, S32 and 3500pts -- so anything outside these is a data fault.
      if (p.toughness < 1 || p.toughness > 20) problems.statline.push(`${unit.name}: T${p.toughness}`);
      if (p.wounds < 1 || p.wounds > 120) problems.statline.push(`${unit.name}: W${p.wounds}`);
      const save = Number(String(p.save).replace('+', ''));
      if (!Number.isFinite(save) || save < 2 || save > 7) {
        problems.statline.push(`${unit.name}: Sv${p.save}`);
      }
    }

    if (unit.basePoints != null && (unit.basePoints < 5 || unit.basePoints > 4000)) {
      problems.points.push(`${unit.name}: ${unit.basePoints}pts`);
    }

    for (const w of unit.weapons) {
      weaponCount += 1;
      const s = Number(w.strength);
      if (!Number.isFinite(s)) { unmodellable += 1; continue; }
      if (s < 1 || s > 40) problems.weapons.push(`${unit.name} / ${w.name}: S${w.strength}`);
      const ap = Number(String(w.ap ?? '0').replace('-', ''));
      if (Number.isFinite(ap) && ap > 6) problems.weapons.push(`${unit.name} / ${w.name}: AP${w.ap}`);
      if (w.kind === 'ranged' && !w.keywords.some((k) => /torrent/i.test(k))) {
        const skill = Number(String(w.skill ?? '').replace('+', ''));
        if (Number.isFinite(skill) && (skill < 2 || skill > 6)) {
          problems.weapons.push(`${unit.name} / ${w.name}: BS${w.skill}`);
        }
      }
    }
  }

  console.log(`\n${units.length} units, ${weaponCount} weapon profiles`);
  console.log(`${unmodellable} weapons with a non-numeric Strength (profile-dependent "*")\n`);

  for (const [label, list] of Object.entries(problems)) {
    console.log(`${label}: ${list.length} problems`);
    for (const item of list.slice(0, 10)) console.log('   ' + item);
    if (list.length > 10) console.log(`   ... and ${list.length - 10} more`);
  }
  console.log();
}

if (command === 'toughness') {
  const bands = new Map();
  let unreadable = 0;

  for (const unit of units) {
    const profile = profileOf(unit);
    if (!profile) {
      unreadable += 1;
      continue;
    }
    const entry = bands.get(profile.toughness) ?? { total: 0, infantry: 0, priced: 0 };
    entry.total += 1;
    if (isInfantryish(unit)) entry.infantry += 1;
    if (unit.basePoints != null) entry.priced += 1;
    bands.set(profile.toughness, entry);
  }

  console.log(`\n${units.length} units, ${unreadable} without a readable statline\n`);
  console.log('  T    units   infantry/beasts   priced');
  console.log('  ' + '-'.repeat(40));
  for (const t of [...bands.keys()].sort((a, b) => a - b)) {
    const e = bands.get(t);
    console.log(
      `  ${String(t).padStart(2)}   ${String(e.total).padStart(5)}   ${String(e.infantry).padStart(15)}   ${String(e.priced).padStart(6)}`
    );
  }
  console.log();
}

if (command === 'yardstick') {
  // Proposed benchmark targets: recognisable units that between them span the
  // toughness / save / wounds space an attacker actually cares about.
  const PROPOSED = [
    // Chaff: cheap bodies, poor saves. What horde-clearing weapons want.
    'Cadian Shock Troops',
    'Necron Warriors',
    // Line infantry: the classic "marine equivalent" benchmark.
    'Intercessor Squad',
    'Boyz',
    // Elite infantry: multi-wound, strong saves, often invulnerable.
    'Bladeguard Veteran Squad',
    'Terminator Squad',
    'Custodian Guard',
    'Canoptek Wraiths',
    // The T7-T8 crossover: light vehicles and walkers.
    'Scout Sentinels',
    'Trukk',
    // Armour.
    'Rhino',
    'Predator Destructor',
    'Redemptor Dreadnought',
    'Leman Russ Vanquisher',
    'Land Raider',
    'Wraithknight',
  ];

  console.log('\nproposed yardstick targets\n');
  console.log(
    '  ' + 'unit'.padEnd(28) + 'pts'.padStart(5) + '  ' + 'profile'.padEnd(22) + 'models  faction'
  );
  console.log('  ' + '-'.repeat(86));

  for (const name of PROPOSED) {
    const matches = units.filter((u) => u.name.toLowerCase() === name.toLowerCase());
    if (!matches.length) {
      console.log(`  ${name.padEnd(28)}   --  NOT FOUND`);
      continue;
    }
    // Prefer a priced entry; several factions can share a unit name.
    const unit = matches.find((u) => u.basePoints != null) ?? matches[0];
    const p = profileOf(unit);
    const models = unit.points?.length ? Math.min(...unit.points.map((t) => t.models)) : 1;
    console.log(
      `  ${unit.name.slice(0, 27).padEnd(28)}` +
        `${String(unit.basePoints ?? '?').padStart(5)}  ` +
        `${(p ? `T${p.toughness} Sv${p.save}${p.invuln ? '/' + p.invuln : ''} W${p.wounds}` : '?').padEnd(22)}` +
        `${String(models).padStart(6)}  ` +
        `${unit.faction.replace(/^(Imperium|Chaos|Xenos)\s*-\s*/, '').replace(/^Adeptus Astartes - /, '')}`
    );
  }

  const covered = new Set();
  for (const name of PROPOSED) {
    const u = units.find((x) => x.name.toLowerCase() === name.toLowerCase());
    const p = u && profileOf(u);
    if (p) covered.add(p.toughness);
  }
  console.log(`\n  toughness values covered: ${[...covered].sort((a, b) => a - b).join(', ')}`);
  console.log();
}

if (command === 'band') {
  const wanted = Number(process.argv[3]);
  const matches = units
    .map((unit) => ({ unit, profile: profileOf(unit) }))
    .filter(({ profile }) => profile && profile.toughness === wanted)
    .filter(({ unit }) => unit.basePoints != null);

  const infantry = matches.filter(({ unit }) => isInfantryish(unit));
  console.log(`\nT${wanted}: ${matches.length} priced units, ${infantry.length} infantry/beasts\n`);

  const show = infantry.length ? infantry : matches;
  show.sort((a, b) => a.unit.basePoints - b.unit.basePoints);
  for (const { unit, profile } of show.slice(0, 60)) {
    console.log(
      `  ${unit.name.slice(0, 32).padEnd(34)}` +
        `${String(unit.basePoints).padStart(4)}pts  ` +
        `T${profile.toughness} W${profile.wounds} Sv${profile.save}` +
        `${profile.invuln ? '/' + profile.invuln : ''}  ` +
        `${unit.faction.replace(/^(Imperium|Chaos|Xenos)\s*-\s*/, '')}`
    );
  }
  if (show.length > 60) console.log(`  ... and ${show.length - 60} more`);
  console.log();
}
