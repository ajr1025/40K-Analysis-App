/**
 * Loading the dataset in the browser.
 *
 * The whole dataset is 7MB, which is not something to hand a phone up front.
 * It is split per faction, so the app fetches the 500KB search index once and
 * pulls a faction file only when a unit from it is actually added to the
 * board. Each file is fetched at most once and shared by every consumer,
 * including concurrent callers -- two units added from the same faction in
 * quick succession must not trigger two downloads.
 */

import type { DataUnit } from '../engine/adapt';
import type { RawDetachment } from '../engine/detachments';
import { type SearchEntry, loadSearchIndex } from '../data/search';

export interface Faction {
  name: string;
  group: string | null;
  slug: string;
  detachments: RawDetachment[];
  units: DataUnit[];
}

const BASE = `${import.meta.env.BASE_URL}data`.replace(/\/{2,}/g, '/');

const factions = new Map<string, Promise<Faction>>();

export function loadFaction(slug: string): Promise<Faction> {
  const cached = factions.get(slug);
  if (cached) return cached;

  const pending = fetch(`${BASE}/${slug}.json`).then((response) => {
    if (!response.ok) throw new Error(`Could not load ${slug} (${response.status})`);
    return response.json() as Promise<Faction>;
  });

  // Stored before it resolves so concurrent callers share one request; dropped
  // again on failure so a transient error does not poison the slug forever.
  factions.set(slug, pending);
  pending.catch(() => factions.delete(slug));
  return pending;
}

export function loadSearch(): Promise<SearchEntry[]> {
  return loadSearchIndex(BASE);
}

/** A unit plus the faction it came from, which the UI needs for labelling. */
export interface LoadedUnit {
  unit: DataUnit;
  faction: Faction;
}

export async function loadUnit(slug: string, name: string): Promise<LoadedUnit | null> {
  const faction = await loadFaction(slug);
  const unit = faction.units.find((u) => u.name === name);
  return unit ? { unit, faction } : null;
}
