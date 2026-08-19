/**
 * The yardstick targets every attacker is measured against.
 *
 * A curated list rather than "every unit at this toughness", because clicking
 * T4 would otherwise produce 286 columns. These are chosen to vary save and
 * wounds *within* each toughness as well as across it -- Necron Warriors and
 * Cadians are both chaff but 4+ against 5+, and a Predator and a Redemptor are
 * both T10 but 3+ against 2+. That spread is what makes a row of numbers tell
 * you which weapon to point where.
 *
 * Editing this list is expected. It is data, not logic.
 */

import { type DataUnit, toTarget } from '../engine/adapt';
import type { Target } from '../engine/resolve';

export interface Benchmark {
  /** Unit name as it appears in the dataset. */
  unit: string;
  /**
   * Faction slug, where the name alone is ambiguous. "Terminator Squad" exists
   * in both Space Marines and Black Templars with identical profiles.
   */
  faction?: string;
  /**
   * Pins a specific model profile. Needed where the bulk profile is not the
   * interesting one -- Assault Terminators list a 4-wound storm shield model
   * alongside a 3-wound lightning claw model.
   */
  profile?: string;
  /** Short label for the column header. */
  label?: string;
  /**
   * Deliberate departures from the printed datasheet, for cases where the
   * unit is almost always fielded with a buff. Each one needs a stated reason.
   */
  overrides?: {
    feelNoPain?: number;
    reason?: string;
  };
}

export const BENCHMARK_TARGETS: Benchmark[] = [
  // --- chaff: cheap bodies, poor saves -------------------------------------
  { unit: 'Cadian Shock Troops', faction: 'astra-militarum' },
  { unit: 'Necron Warriors', faction: 'necrons' },
  {
    // T3 but a 3+ save, so it reads very differently from the other chaff.
    unit: 'Warp Spiders',
    faction: 'aeldari',
  },

  // --- line infantry -------------------------------------------------------
  { unit: 'Intercessor Squad', faction: 'adeptus-astartes-space-marines' },
  { unit: 'Boyz', faction: 'orks' },

  // --- elite infantry: multi-wound, strong saves, often invulnerable -------
  { unit: 'Bladeguard Veteran Squad', faction: 'adeptus-astartes-space-marines' },
  { unit: 'Terminator Squad', faction: 'adeptus-astartes-space-marines' },
  {
    unit: 'Terminator Assault Squad',
    faction: 'adeptus-astartes-space-marines',
    profile: 'Storm Shield',
    label: 'Assault Termies (TH/SS)',
  },
  { unit: 'Custodian Guard', faction: 'adeptus-custodes' },
  {
    unit: 'Canoptek Wraiths',
    faction: 'necrons',
    overrides: {
      feelNoPain: 5,
      reason: 'Almost always fielded with a Technomancer, which grants Feel No Pain 5+.',
    },
  },

  // --- the T7-T8 crossover: light vehicles and walkers ---------------------
  { unit: 'Scout Sentinels', faction: 'astra-militarum' },
  { unit: 'Trukk', faction: 'orks' },

  // --- armour --------------------------------------------------------------
  { unit: 'Rhino', faction: 'adeptus-astartes-space-marines' },
  { unit: 'Predator Destructor', faction: 'adeptus-astartes-space-marines' },
  { unit: 'Gladiator Lancer', faction: 'adeptus-astartes-space-marines' },
  { unit: 'Redemptor Dreadnought', faction: 'adeptus-astartes-space-marines' },
  { unit: 'Leman Russ Vanquisher', faction: 'astra-militarum' },

  // --- the top end: big multi-wound centrepieces ---------------------------
  { unit: "C'tan Shard of the Nightbringer", faction: 'necrons' },
  { unit: 'Fulgrim', faction: 'emperors-children' },
  { unit: 'Land Raider', faction: 'adeptus-astartes-space-marines' },
  { unit: 'Wraithknight', faction: 'aeldari' },
];

/**
 * Build the engine target for a benchmark, applying its pinned profile and any
 * declared overrides.
 *
 * Overrides exist because the printed datasheet is not always what you face
 * across the table -- Canoptek Wraiths are nearly always screened by a
 * Technomancer, so measuring them without Feel No Pain would flatter every
 * weapon aimed at them.
 */
export function benchmarkTarget(
  benchmark: Benchmark,
  unit: DataUnit,
  modelCount?: number
): Target | null {
  const target = toTarget(unit, modelCount, benchmark.profile);
  if (!target) return null;

  return {
    ...target,
    name: benchmark.label ?? target.name,
    feelNoPain: benchmark.overrides?.feelNoPain ?? target.feelNoPain,
  };
}
