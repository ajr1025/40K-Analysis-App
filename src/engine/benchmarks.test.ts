/**
 * Verify every benchmark target resolves against the real dataset.
 *
 * These names are typed by hand, and the upstream data changes under us. A
 * renamed or removed unit would otherwise just quietly vanish from the matrix,
 * so this fails loudly instead.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BENCHMARK_TARGETS } from '../data/benchmarks';
import { type DataUnit, bulkProfile, defaultModelCount, parseInteger, toTarget } from './adapt';

const DATA_DIR = join(process.cwd(), 'public', 'data');
const hasData = existsSync(join(DATA_DIR, 'index.json'));
const describeWithData = hasData ? describe : describe.skip;

function loadFaction(slug: string): DataUnit[] | null {
  const path = join(DATA_DIR, `${slug}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')).units;
}

function loadAll(): DataUnit[] {
  const index = JSON.parse(readFileSync(join(DATA_DIR, 'index.json'), 'utf8'));
  const out: DataUnit[] = [];
  for (const faction of index.factions) {
    out.push(...(loadFaction(faction.slug) ?? []));
  }
  return out;
}

/** Resolve a benchmark entry to the unit it names. */
function resolve(benchmark: (typeof BENCHMARK_TARGETS)[number], all: DataUnit[]) {
  const pool = benchmark.faction ? (loadFaction(benchmark.faction) ?? []) : all;
  return pool.find((u) => u.name.toLowerCase() === benchmark.unit.toLowerCase()) ?? null;
}

describeWithData('benchmark targets', () => {
  const all = loadAll();

  it('every entry resolves to a real unit', () => {
    const missing = BENCHMARK_TARGETS.filter((b) => !resolve(b, all)).map(
      (b) => `${b.unit}${b.faction ? ` (${b.faction})` : ''}`
    );
    expect(missing).toEqual([]);
  });

  it('every entry has points and a usable statline', () => {
    const problems: string[] = [];
    for (const benchmark of BENCHMARK_TARGETS) {
      const unit = resolve(benchmark, all);
      if (!unit) continue;
      if (unit.basePoints == null) problems.push(`${benchmark.unit}: no points`);
      const target = toTarget(unit, undefined, benchmark.profile);
      if (!target) problems.push(`${benchmark.unit}: unreadable statline`);
    }
    expect(problems).toEqual([]);
  });

  it('every pinned profile actually exists on its unit', () => {
    const problems: string[] = [];
    for (const benchmark of BENCHMARK_TARGETS) {
      if (!benchmark.profile) continue;
      const unit = resolve(benchmark, all);
      if (!unit) continue;
      const found = unit.models.some((m) =>
        m.name?.toLowerCase().includes(benchmark.profile!.toLowerCase())
      );
      if (!found) {
        problems.push(
          `${benchmark.unit}: no profile matching "${benchmark.profile}" ` +
            `(has: ${unit.models.map((m) => m.name).join(', ')})`
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('picks the rank and file rather than the squad leader', () => {
    // The case that exposed the bug: BSData lists Boyz as [Boy, Boss Nob] but
    // Intercessors as [Sergeant, Squad], so neither end of the list is safe.
    const boyz = resolve({ unit: 'Boyz', faction: 'orks' }, all)!;
    expect(parseInteger(bulkProfile(boyz)!.wounds)).toBe(1);

    const intercessors = resolve(
      { unit: 'Intercessor Squad', faction: 'adeptus-astartes-space-marines' },
      all
    )!;
    expect(bulkProfile(intercessors)!.name).not.toMatch(/sergeant/i);

    const warpSpiders = resolve({ unit: 'Warp Spiders', faction: 'aeldari' }, all)!;
    expect(bulkProfile(warpSpiders)!.name).not.toMatch(/exarch/i);
    expect(parseInteger(bulkProfile(warpSpiders)!.wounds)).toBe(1);
  });

  it('honours a pinned profile over the bulk one', () => {
    // Assault Terminators: storm shields are 4 wounds, lightning claws 3.
    const unit = resolve(
      { unit: 'Terminator Assault Squad', faction: 'adeptus-astartes-space-marines' },
      all
    )!;
    const pinned = toTarget(unit, undefined, 'Storm Shield')!;
    const bulk = toTarget(unit)!;

    expect(pinned.wounds).toBe(4);
    expect(bulk.wounds).toBe(3);
  });

  it('spans a wide range of toughness without gaps', () => {
    const toughness = new Set<number>();
    for (const benchmark of BENCHMARK_TARGETS) {
      const unit = resolve(benchmark, all);
      if (!unit) continue;
      const target = toTarget(unit, undefined, benchmark.profile);
      if (target) toughness.add(target.toughness);
    }
    // Continuous cover from chaff to heavy armour; gaps would leave a
    // toughness button with nothing behind it.
    for (const t of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(toughness.has(t)).toBe(true);
    }
  });

  it('documents a reason for every departure from the datasheet', () => {
    for (const benchmark of BENCHMARK_TARGETS) {
      if (!benchmark.overrides) continue;
      expect(benchmark.overrides.reason ?? '').not.toBe('');
    }
  });

  it('keeps the default model count to the smallest legal squad', () => {
    for (const benchmark of BENCHMARK_TARGETS) {
      const unit = resolve(benchmark, all);
      if (!unit || !unit.points?.length) continue;
      const smallest = Math.min(...unit.points.map((t) => t.models));
      expect(defaultModelCount(unit)).toBe(smallest);
    }
  });
});
