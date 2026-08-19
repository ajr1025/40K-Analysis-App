import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type SearchEntry, searchUnits } from './search';

const PATH = join(process.cwd(), 'public', 'data', 'search.json');
const hasData = existsSync(PATH);
const describeWithData = hasData ? describe : describe.skip;

describeWithData('unit search', () => {
  const index: SearchEntry[] = JSON.parse(readFileSync(PATH, 'utf8')).units;

  it('covers the matched-play roster', () => {
    // Not the whole roster: Crucible, Legends and free spawned units carry no
    // matched-play points, and points are both halves of the efficiency ratio,
    // so a search hit for one could never produce a number.
    expect(index.length).toBeGreaterThan(1000);
    expect(index.every((u) => u.points != null)).toBe(true);
  });

  it('stays small enough to load on a phone', () => {
    // It is fetched before the first search, so it must not be a faction file.
    const kb = readFileSync(PATH).byteLength / 1024;
    expect(kb).toBeLessThan(600);
  });

  it('finds a unit by name', () => {
    const hits = searchUnits(index, 'sanguinary guard');
    expect(hits[0].name.toLowerCase()).toContain('sanguinary guard');
    expect(hits[0].points).not.toBeNull();
    expect(hits[0].toughness).not.toBeNull();
  });

  it('finds a unit from a partial name', () => {
    expect(searchUnits(index, 'sangui').some((u) => /sanguinary guard/i.test(u.name))).toBe(true);
    expect(searchUnits(index, 'termag').some((u) => /termagants/i.test(u.name))).toBe(true);
  });

  it('ranks an exact name above a longer one that contains it', () => {
    const hits = searchUnits(index, 'terminator squad');
    expect(hits[0].name.toLowerCase()).toBe('terminator squad');
  });

  it('ignores accents and punctuation', () => {
    // "Khârn the Betrayer" should be reachable by typing plain ASCII.
    const hits = searchUnits(index, 'kharn');
    expect(hits.some((u) => /kh.rn/i.test(u.name))).toBe(true);
  });

  it('can restrict to one faction', () => {
    const hits = searchUnits(index, 'terminator', { faction: 'adeptus-astartes-space-marines' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((u) => u.slug === 'adeptus-astartes-space-marines')).toBe(true);
  });

  it('can drop unpriced units, which cannot be scored', () => {
    const all = searchUnits(index, 'squad', { limit: 500 });
    const priced = searchUnits(index, 'squad', { limit: 500, pricedOnly: true });
    expect(priced.every((u) => u.points != null)).toBe(true);
    expect(priced.length).toBeLessThanOrEqual(all.length);
  });

  it('hides Legends units unless asked for them', () => {
    const hidden = searchUnits(index, 'a', { limit: 2000 });
    expect(hidden.every((u) => !u.legends)).toBe(true);
    const shown = searchUnits(index, 'a', { limit: 2000, includeLegends: true });
    expect(shown.length).toBeGreaterThanOrEqual(hidden.length);
  });

  it('falls back to matching keywords', () => {
    // Useful for "show me something with the Fly keyword".
    expect(searchUnits(index, 'battleline').length).toBeGreaterThan(0);
  });

  it('returns nothing for an empty query', () => {
    expect(searchUnits(index, '   ')).toEqual([]);
  });

  it('carries everything needed to render a result row', () => {
    for (const hit of searchUnits(index, 'intercessor', { pricedOnly: true })) {
      expect(hit.faction).toBeTruthy();
      expect(hit.slug).toBeTruthy();
      expect(hit.models).toBeGreaterThan(0);
      expect(hit.toughness).toBeTruthy();
    }
  });
});
