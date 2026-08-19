/**
 * Unit search across every faction.
 *
 * The matrix is built from a curated benchmark list, but sometimes you want a
 * specific opponent -- "how do I do into Sanguinary Guard?" -- so any of the
 * 1683 units has to be findable and addable as a column.
 *
 * Backed by `public/data/search.json`, a flat index the pipeline emits
 * alongside the per-faction files. It carries only enough to render a result
 * row and identify which faction file to fetch, so searching never means
 * downloading all 36 faction files.
 */

export interface SearchEntry {
  name: string;
  /** Display faction, with the Imperium/Chaos/Xenos prefix stripped. */
  faction: string;
  /** Faction file to load for the full datasheet. */
  slug: string;
  points: number | null;
  /** Smallest legal unit size. */
  models: number;
  toughness: string | null;
  save: string | null;
  wounds: string | null;
  invulnerable: string | null;
  legends: boolean;
  keywords: string[];
}

/** Fold accents and punctuation so "Khârn" matches a plain-ASCII query. */
function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SearchOptions {
  limit?: number;
  /** Restrict to a faction slug. */
  faction?: string;
  /** Drop units with no points, which cannot be scored for efficiency. */
  pricedOnly?: boolean;
  /** Legends units are excluded by default; most players cannot field them. */
  includeLegends?: boolean;
}

/**
 * Rank matches so the unit you meant comes first.
 *
 * Typing "guard" should surface Custodian Guard before Guardian Defenders, so
 * an exact name wins, then a prefix, then a word boundary, then any substring.
 */
export function searchUnits(
  index: SearchEntry[],
  query: string,
  options: SearchOptions = {}
): SearchEntry[] {
  const { limit = 25, faction, pricedOnly = false, includeLegends = false } = options;
  const needle = fold(query);
  if (!needle) return [];

  const scored: Array<{ entry: SearchEntry; score: number }> = [];

  for (const entry of index) {
    if (faction && entry.slug !== faction) continue;
    if (pricedOnly && entry.points == null) continue;
    if (!includeLegends && entry.legends) continue;

    const name = fold(entry.name);
    let score: number;

    if (name === needle) score = 0;
    else if (name.startsWith(needle)) score = 1;
    else if (new RegExp(`\\b${escapeRegExp(needle)}`).test(name)) score = 2;
    else if (name.includes(needle)) score = 3;
    else if (fold(entry.keywords.join(' ')).includes(needle)) score = 4;
    else continue;

    scored.push({ entry, score });
  }

  scored.sort(
    (a, b) => a.score - b.score || a.entry.name.length - b.entry.name.length ||
      a.entry.name.localeCompare(b.entry.name)
  );

  return scored.slice(0, limit).map((s) => s.entry);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Load the search index. The caller decides how to cache it. */
export async function loadSearchIndex(baseUrl = '/data'): Promise<SearchEntry[]> {
  const response = await fetch(`${baseUrl}/search.json`);
  if (!response.ok) throw new Error(`search index: ${response.status}`);
  const body = (await response.json()) as { units: SearchEntry[] };
  return body.units;
}
