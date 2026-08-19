/**
 * Munitorum Field Manual points data.
 *
 * BSData carries points in `costs`, but the MFM scraper is closer to the
 * source of truth: it reads GW's published manual directly and a scheduled job
 * re-scrapes it whenever points change. It also gives us two things BSData
 * does not expose cleanly -- per-model-count pricing tiers, and which leaders
 * may attach to which bodyguard units.
 */

import { parse } from 'yaml';
import { joinKey } from './names.mjs';

/**
 * Build a lookup of unit name -> points info across every faction file.
 *
 * Keyed both faction-scoped and globally. Some unit names ("Captain",
 * "Librarian") recur across factions with different costs, so a global-only
 * lookup would silently attach the wrong points; callers should try the
 * faction-scoped key first.
 */
export function buildPointsIndex(files) {
  const byFactionAndName = new Map();
  const byName = new Map();
  const ambiguous = new Set();

  for (const { slug, text } of files) {
    const doc = parse(text);
    for (const unit of doc.units ?? []) {
      const key = joinKey(unit.name);
      const record = {
        name: unit.name,
        faction: doc.name,
        factionSlug: slug,
        legends: unit.legends === true,
        role: unit.role ?? null,
        attachTo: unit.attachTo ?? [],
        pricing: normalisePricing(unit.pricing),
      };

      byFactionAndName.set(`${slug}::${key}`, record);

      if (byName.has(key)) {
        const existing = byName.get(key);
        if (JSON.stringify(existing.pricing) !== JSON.stringify(record.pricing)) {
          ambiguous.add(key);
        }
      } else {
        byName.set(key, record);
      }
    }
  }

  return { byFactionAndName, byName, ambiguous };
}

/**
 * Flatten MFM's pricing blocks to a tier list.
 *
 * 11th edition prices some units on a sliding scale -- your 1st-3rd Rhino cost
 * 65pts each, your 4th onwards cost 75. That lives in the block's `range`, so
 * dropping it would collapse the two tiers into indistinguishable duplicates.
 */
function normalisePricing(pricing) {
  const tiers = [];
  for (const block of pricing ?? []) {
    for (const cost of block.costs ?? []) {
      // An add-on is the price of attaching something to the unit, not the
      // price of the unit: a Tidewall Shieldline is 85 points, with a 20-point
      // Defence Platform available. Read as a tier it became the cheapest way
      // to field the unit, and the Shieldline was priced at 20.
      if (cost.addon) continue;
      tiers.push({
        models: cost.models,
        points: cost.points,
        range: block.range ?? null,
        label: block.label ?? null,
      });
    }
  }
  return tiers;
}

/**
 * The cost the app compares against by default: the smallest legal unit at the
 * first (undiscounted) tier.
 */
/**
 * Keep only the price of a unit taken on its own.
 *
 * 11e charges more for repeat selections, and the MFM encodes it as a pricing
 * range: "[1,2]" is your first and second unit, "[3,)" every one after. 380
 * units carry the escalation and Meganobz jump 60 -> 80 for a third copy.
 *
 * The app compares units one at a time, so the repeat prices are not just
 * unused -- keeping them makes a lookup by model count ambiguous, since a
 * five-model squad matches both an 85 and a 95 tier and picks whichever the
 * source happened to list first.
 */
const FIRST_SELECTION = /^\[1[,\]]/;

export function firstSelectionTiers(tiers) {
  const first = (tiers ?? []).filter((t) => FIRST_SELECTION.test(t.range ?? '[1,)'));
  return first.length ? first : (tiers ?? []);
}

export function basePoints(tiers) {
  if (!tiers?.length) return null;
  const minModels = Math.min(...tiers.map((t) => t.models));
  const candidates = tiers.filter((t) => t.models === minModels);
  return Math.min(...candidates.map((t) => t.points));
}

/** Look up points for a unit, preferring a faction-scoped match. */
export function lookupPoints(index, factionSlug, unitName) {
  const key = joinKey(unitName);
  const direct = find(index, factionSlug, key);
  if (direct) return direct;

  // The two sources also disagree on number: BSData lists a "Myphitic
  // Blight-hauler", the MFM prices "Myphitic Blight-Haulers". Try the other
  // form before giving up and reporting the unit as unpriced.
  const alternate = key.endsWith('s') ? key.slice(0, -1) : `${key}s`;
  return find(index, factionSlug, alternate);
}

function find(index, factionSlug, key) {
  return (
    index.byFactionAndName.get(`${factionSlug}::${key}`) ??
    (index.ambiguous.has(key) ? null : index.byName.get(key)) ??
    null
  );
}
