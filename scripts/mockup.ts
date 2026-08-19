/**
 * Build the mockup's data payload from the real engine.
 *
 * The previous payload was hand-rolled and drifted: it predated wargear-legal
 * loadouts, self-buffs, the Ork Boyz invulnerable fix, rule 24.02 stacking and
 * the +/-1 modifier cap, so the numbers on screen no longer matched what the
 * engine computed. Driving it through the same calls the app will make means
 * the mockup cannot silently diverge again.
 *
 * Run via `node scripts/gen-mockup.mjs`, which bundles this first -- the
 * engine is TypeScript and there is no TS loader in the plain node path.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BENCHMARK_TARGETS } from '../src/data/benchmarks';
import { type DataUnit, bulkProfile, toTarget } from '../src/engine/adapt';
import { resolveBuffs } from '../src/engine/conditions';
import { type RawDetachment, readDetachments } from '../src/engine/detachments';
import {
  type Modifiers,
  type Target,
  pointsDestroyed,
  pointsEfficiency,
  resolveLoadout,
} from '../src/engine/resolve';
import { automaticBuffs, readSelfBuffs } from '../src/engine/selfbuffs';
import {
  chooseModes,
  defaultLoadout,
  loadoutIsAssumed,
  loadoutEntries,
  loadoutSize,
  variantsOf,
} from '../src/engine/wargear';

const DATA = join(process.cwd(), 'public', 'data');

/**
 * Positional assumptions every cell is computed under.
 *
 * Half range is on by default: it is where Rapid Fire and Melta live, and with
 * it off every bolter and every melta unit reads far weaker than it plays --
 * Eradicators into a Rhino go from 13.1 damage to 9.1. The toolbar shows it as
 * a toggle so the assumption is visible rather than buried.
 */
const DEFAULT_SITUATION = { halfRange: true } as const;

/** The attackers on show. Chosen to span chaff-clearing, anti-elite and anti-tank. */
const ATTACKERS: Array<{ unit: string; faction: string; group: string }> = [
  { unit: 'Captain in Terminator Armour', faction: 'adeptus-astartes-space-marines', group: 'Character' },
  { unit: 'Intercessor Squad', faction: 'adeptus-astartes-space-marines', group: 'Infantry' },
  { unit: 'Hellblaster Squad', faction: 'adeptus-astartes-space-marines', group: 'Infantry' },
  { unit: 'Eradicator Squad', faction: 'adeptus-astartes-space-marines', group: 'Infantry' },
  { unit: 'Sternguard Veteran Squad', faction: 'adeptus-astartes-space-marines', group: 'Infantry' },
  { unit: 'Bladeguard Veteran Squad', faction: 'adeptus-astartes-space-marines', group: 'Infantry' },
  { unit: 'Terminator Squad', faction: 'adeptus-astartes-space-marines', group: 'Infantry' },
  { unit: 'Redemptor Dreadnought', faction: 'adeptus-astartes-space-marines', group: 'Vehicle' },
  { unit: 'Gladiator Lancer', faction: 'adeptus-astartes-space-marines', group: 'Vehicle' },
];

interface Faction {
  name: string;
  slug: string;
  units: DataUnit[];
}

function loadFactions(): Faction[] {
  const manifest = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8')) as {
    factions: Array<{ slug: string }>;
  };
  return manifest.factions.map(({ slug }) =>
    JSON.parse(readFileSync(join(DATA, `${slug}.json`), 'utf8'))
  );
}

function findUnit(factions: Faction[], name: string, slug?: string): DataUnit | null {
  const pool = slug ? factions.filter((f) => f.slug === slug) : factions;
  for (const faction of pool) {
    const unit = faction.units.find((u) => u.name === name);
    if (unit) return unit;
  }
  return null;
}

/** Points for a given model count, from the MFM pricing tiers. */
function pointsFor(unit: DataUnit, models: number): number {
  const tiers = unit.points ?? [];
  if (!tiers.length) return unit.basePoints ?? 0;
  const exact = tiers.find((t) => t.models === models);
  if (exact) return exact.points;
  return tiers.reduce((best, t) => (t.models <= models && t.points > best ? t.points : best), 0) ||
    tiers[0].points;
}

/** Weapon table rows for the loadout drop-down. */
function weaponRows(unit: DataUnit): string[][] {
  return unit.weapons.map((w) => [
    w.kind === 'melee' ? 'M' : 'R',
    w.name,
    w.range ?? (w.kind === 'melee' ? 'Melee' : '—'),
    w.attacks ?? '—',
    w.skill ?? 'N/A',
    w.strength ?? '—',
    w.ap ?? '0',
    w.damage ?? '—',
    (w.keywords ?? []).join(', '),
  ]);
}

/**
 * What the loadout actually fires, as counts.
 *
 * Merging every variant's weapons into one list read as though the unit
 * carried all of them at once -- an Intercessor squad showed "Bolt pistol +
 * Hand flamer +3", implying a squad holding both a hand flamer and everything
 * else in the sergeant's choice slot. Counting the resolved weapons instead
 * cannot misrepresent, because it is exactly what the engine rolled.
 */
function loadoutLabel(unit: DataUnit): string {
  const counts = new Map<string, number>();
  for (const entry of loadoutEntries(unit, defaultLoadout(unit))) {
    // Pistols and the default close combat weapon are on nearly every model
    // and say nothing about the build.
    if (/close combat weapon/i.test(entry.weapon.name)) continue;
    // The firing mode is chosen per target, so it belongs in the cell, not in
    // the description of what the squad carries: one Plasma Incinerator, not
    // a "Plasma Incinerator - Standard" the squad is stuck with.
    const name = entry.weapon.name.replace(/\s+-\s+[^-]*$/, '').trim();
    counts.set(name, (counts.get(name) ?? 0) + entry.models);
  }
  if (!counts.size) return '—';

  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${n}× ${name}`);
  return parts.length <= 3 ? parts.join(', ') : `${parts.slice(0, 3).join(', ')} +${parts.length - 3}`;
}


/** The unit's model variants and choice slots, for the loadout steppers. */
function wargearTree(unit: DataUnit) {
  return variantsOf(unit).map((v) => ({
    name: v.name,
    min: v.min ?? 0,
    max: v.max,
    maxRules: v.maxRules ?? null,
    fixed: v.fixed,
    choices: v.choices.map((c) => ({
      name: c.name,
      options: c.options,
      grants: c.grants ?? null,
    })),
  }));
}

function hasVariant(unit: DataUnit, name: string): boolean {
  return variantsOf(unit).some((v) => v.name === name);
}

function main() {
  const factions = loadFactions();

  // --- columns: the benchmark targets -------------------------------------
  const cols: Array<[string, number, number, number, number, number]> = [];
  const colTargets: Array<{ target: Target; points: number }> = [];

  for (const benchmark of BENCHMARK_TARGETS) {
    const unit = findUnit(factions, benchmark.unit, benchmark.faction);
    if (!unit) {
      console.warn(`  ! missing benchmark target: ${benchmark.unit}`);
      continue;
    }
    const target = toTarget(unit, undefined, benchmark.profile);
    if (!target) {
      console.warn(`  ! unreadable target: ${benchmark.unit}`);
      continue;
    }
    if (benchmark.overrides?.feelNoPain) target.feelNoPain = benchmark.overrides.feelNoPain;

    const model = bulkProfile(unit);
    const points = pointsFor(unit, target.models);
    cols.push([
      benchmark.label ?? unit.name,
      points,
      target.toughness,
      target.models,
      Number(String(model?.save ?? '7').replace('+', '')) || 7,
      target.invulnerable ?? 0,
    ]);
    colTargets.push({ target, points });
  }

  // Lowest toughness first, then by save -- Warp Spiders sit above Cadians
  // because a 3+ save reads very differently from a 5+ at the same toughness.
  const order = cols
    .map((c, i) => i)
    .sort((a, b) => cols[a][2] - cols[b][2] || cols[a][4] - cols[b][4] || cols[a][0].localeCompare(cols[b][0]));
  const sortedCols = order.map((i) => cols[i]);
  const sortedTargets = order.map((i) => colTargets[i]);

  // --- rows: the attackers -------------------------------------------------
  const rows: unknown[] = [];

  for (const spec of ATTACKERS) {
    const unit = findUnit(factions, spec.unit, spec.faction);
    if (!unit) {
      console.warn(`  ! missing attacker: ${spec.unit}`);
      continue;
    }

    const loadout = defaultLoadout(unit);
    const models = loadoutSize(loadout);
    const attackerPoints = pointsFor(unit, models);
    // Every firing mode, narrowed per target below: krak or frag, standard or
    // supercharge, is a decision made when the trigger is pulled.
    const entries = loadoutEntries(unit, loadout, undefined, true);

    const selfBuffs = readSelfBuffs(unit);
    const automatic = automaticBuffs(selfBuffs.buffs);

    const cells = sortedTargets.map(({ target, points }) => {
      // Buffs are resolved per target: Eradicators' re-rolls only fire against
      // Monsters and Vehicles, so the same unit reads differently per column.
      const melee = resolveBuffs(automatic, target.keywords, 'melee');
      const ranged = resolveBuffs(automatic, target.keywords, 'ranged');

      const perEntry = chooseModes(
        entries.map((entry) => ({
          ...entry,
          modifiers: {
            ...(entry.weapon.melee ? melee.modifiers : ranged.modifiers),
            ...entry.modifiers,
          } as Modifiers,
        })),
        target,
        DEFAULT_SITUATION
      );

      const result = resolveLoadout(perEntry, target, {
        attackingModels: models,
        ...DEFAULT_SITUATION,
      });
      if (!result) return [0, 0, 0, 0, 0, '—', []];

      const applied = [
        ...new Set([...melee.applied, ...ranged.applied].map((b) => b.source)),
      ];

      return [
        Number((pointsEfficiency(result, target, points, attackerPoints) * 100).toFixed(1)),
        Number(result.totalDamage.toFixed(2)),
        Number(result.expectedModelsSlain.toFixed(2)),
        Number((result.probabilityDestroyed * 100).toFixed(1)),
        Math.round(pointsDestroyed(result, target, points)),
        loadoutLabel(unit),
        applied,
      ];
    });

    rows.push([
      spec.group,
      unit.name,
      attackerPoints,
      models,
      weaponRows(unit),
      automatic.map((b) => b.source),
      selfBuffs.buffs.filter((b) => !automatic.includes(b)).map((b) => b.source),
      cells,
      // The wargear tree and the build it opens on, so the loadout panel can
      // offer per-model steppers bounded by what the datasheet allows.
      wargearTree(unit),
      loadout.selections.filter((s) => s.count > 0 || hasVariant(unit, s.variant)),
      // Caveats the cell cannot express on its own.
      {
        unpriced: unit.basePoints == null,
        assumedLoadout: loadoutIsAssumed(unit),
        unmodelled: selfBuffs.unparsed.map((a) => a.name),
      },
    ]);
  }

  // --- search index --------------------------------------------------------
  const search: Array<[string, string, number]> = [];
  for (const faction of factions) {
    for (const unit of faction.units) {
      if (unit.basePoints == null) continue;
      search.push([faction.name, unit.name, unit.basePoints]);
    }
  }
  search.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  // --- detachments for the attackers' faction ------------------------------
  // Only those that actually change an attack are listed; a detachment whose
  // rules are about movement or objectives has nothing to show in a damage
  // matrix. Each rule carries the wording that gates it so the toggle can say
  // why it is off.
  const marines = factions.find((f) => f.slug === 'adeptus-astartes-space-marines');
  const detachments = readDetachments(
    (marines as unknown as { detachments: RawDetachment[] })?.detachments
  )
    .map((d) => ({
      name: d.name,
      rules: d.rules
        .filter((r) => r.buff)
        .map((r) => ({
          name: r.name,
          scope: r.buff!.scope,
          summary: r.buff!.summary,
          optional: r.trigger !== 'always' && r.trigger !== 'target-keyword',
          condition: r.condition ?? null,
        })),
    }))
    .filter((d) => d.rules.length)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { cols: sortedCols, rows, search, detachments };
}

export default main;
