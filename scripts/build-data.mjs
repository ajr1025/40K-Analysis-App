/**
 * Build the app's unit dataset from two community sources.
 *
 *   BSData/wh40k-11e      -> statlines, weapon profiles, keywords
 *   BSData/wh40k-11e-mfm  -> points, model-count tiers, leader attachments
 *
 * Emits one compact JSON per faction into public/data/, plus an index. The
 * raw BSData libraries are megabytes each; the output is small enough to load
 * over a phone connection.
 *
 *   node scripts/build-data.mjs [--fresh] [--faction <slug>]
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fetchCached } from './lib/fetch-cache.mjs';
import { buildIndex, extractDetachments, extractUnits } from './lib/bsdata.mjs';
import { basePoints, buildPointsIndex, firstSelectionTiers, lookupPoints } from './lib/mfm.mjs';
import { slugify, joinKey } from './lib/names.mjs';

const BS_REPO = 'BSData/wh40k-11e';
const MFM_REPO = 'BSData/wh40k-11e-mfm';
const OUT_DIR = join(process.cwd(), 'public', 'data');

const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const onlyFaction = args[args.indexOf('--faction') + 1] || null;

/**
 * BSData and the MFM name factions differently. Where slugifying the catalogue
 * name does not already land on an MFM slug, map it explicitly.
 */
const MFM_ALIASES = {
  'agents-of-the-imperium': 'imperial-agents',
  'titanicus-traitoris': 'chaos-titan-legions',
  'adeptus-titanicus': 'titan-legions',
  'tau-empire': 'tau-empire',
};

/**
 * Resolve a BSData catalogue name to an MFM faction slug.
 *
 * Space Marine chapters without their own MFM file (Imperial Fists, Iron
 * Hands, Ultramarines...) share the Space Marines points list -- their BSData
 * catalogues hold chapter-specific characters plus the common roster.
 */
function resolveMfmSlug(catalogueName, availableSlugs) {
  const stripped = catalogueName
    .replace(/^(Imperium|Chaos|Xenos|Aeldari)\s*-\s*/, '')
    .replace(/^Adeptus Astartes\s*-\s*/, '');
  const slug = slugify(stripped);

  if (availableSlugs.has(slug)) return slug;
  if (MFM_ALIASES[slug] && availableSlugs.has(MFM_ALIASES[slug])) return MFM_ALIASES[slug];
  if (/Adeptus Astartes/.test(catalogueName)) return 'space-marines';
  return slug;
}

/**
 * The profile representing the bulk of a unit.
 *
 * Mirrors `bulkProfile` in the app: BSData orders model profiles
 * inconsistently -- Ork Boyz list [Boy, Boss Nob] but Intercessors list
 * [Sergeant, Squad] -- so neither end of the list is safe. Drop the squad
 * leaders by name, then take the weakest of what remains.
 */
const LEADER_PROFILE =
  /\b(sergeant|sarge|nob|exarch|champion|leader|master|superior|alpha|pack leader|shas'?vre)\b/i;

function bulkModel(models) {
  if (!models?.length) return null;
  const rankAndFile = models.filter((m) => !LEADER_PROFILE.test(m.name ?? ''));
  const candidates = rankAndFile.length ? rankAndFile : models;
  return candidates.reduce((weakest, model) => {
    const a = Number(model.wounds);
    const b = Number(weakest.wounds);
    return (Number.isFinite(a) ? a : Infinity) < (Number.isFinite(b) ? b : Infinity)
      ? model
      : weakest;
  });
}

/**
 * Catalogues to read a faction's detachments from, besides its own.
 *
 * Several factions keep no detachments in their playable catalogue and reach
 * them through a linked library: Tyranids, Astra Militarum and Aeldari all
 * come back empty otherwise. Space Marine chapters are the same story with a
 * different parent -- a Blood Angels army picks from the Space Marines list,
 * which is where Liberator Assault Group lives.
 *
 * Only same-faction links are followed. `catalogueLinks` also covers allies,
 * and Astra Militarum links the Imperial Knights library; inheriting from
 * those would offer a Guard player a Knights detachment they cannot take.
 */
function detachmentSources(cat, cataloguesById) {
  const out = [];
  const own = coreName(cat.name);

  const libraries = (cat.catalogueLinks ?? [])
    .map((link) => cataloguesById.get(link.targetId))
    .filter((target) => target?.library);

  const related = libraries.filter((target) => {
    const theirs = coreName(target.name);
    return theirs === own || theirs.includes(own) || own.includes(theirs);
  });

  // A faction with exactly one library and no name overlap is still reading
  // its own rules from it: Drukhari share the Aeldari library, which carries
  // Kabalite Cartel and Skysplinter Assault alongside the Craftworld lists.
  out.push(...(related.length ? related : libraries.length === 1 ? libraries : []));

  // Chapter catalogues hold their own characters and inherit the rest.
  if (/Adeptus Astartes/.test(cat.name) && !/Space Marines/.test(cat.name)) {
    for (const c of cataloguesById.values()) {
      if (/Adeptus Astartes - Space Marines$/.test(c.name)) out.push(c);
    }
  }

  return out;
}

/** "Library - Tyranids", "Xenos - Tyranids" -> "tyranids". */
function coreName(name) {
  return slugify(
    name
      .replace(/^(Imperium|Chaos|Xenos|Aeldari)\s*-\s*/, '')
      .replace(/^Library\s*-\s*/i, '')
      .replace(/\s*-?\s*Library$/i, '')
  );
}

function dedupeDetachments(detachments) {
  const out = new Map();
  for (const d of detachments) {
    const key = d.name.toLowerCase();
    // Prefer whichever copy carries more rule text; a faction catalogue
    // sometimes lists the name with the library holding the detail.
    if (!out.has(key) || d.rules.length > out.get(key).rules.length) out.set(key, d);
  }
  return [...out.values()];
}

/**
 * Display names, where the catalogue's own name is not what a player calls it.
 *
 * BSData files the Craftworlds roster under the umbrella term "Aeldari", which
 * then reads as the parent of Drukhari rather than as a sibling of it. Naming
 * it Craftworlds and grouping both under Aeldari matches how the two are
 * actually picked -- and matches the source, which gives them one shared
 * detachment library holding Windrider Host and Kabalite Cartel side by side.
 *
 * Applied to display only. The MFM points join still runs off the catalogue
 * name, so renaming here cannot break pricing.
 */
const FACTION_DISPLAY = {
  aeldari: { name: 'Craftworlds', group: 'Aeldari' },
  drukhari: { group: 'Aeldari' },
};

function displayFaction(slug, catalogueName) {
  const bare = catalogueName.replace(/^(Imperium|Chaos|Xenos|Aeldari)\s*-\s*/, '');
  const override = FACTION_DISPLAY[slug] ?? {};
  return { name: override.name ?? bare, group: override.group ?? null };
}


/**
 * Separate two factions that share one library.
 *
 * BSData keeps a single Aeldari library holding both lists, so Craftworlds and
 * Drukhari each came back with all 24 detachments. Wahapedia splits them 15/9,
 * and the data agrees without needing that list hardcoded: every Drukhari
 * detachment names the DRUKHARI keyword in its rules and not one Craftworlds
 * detachment does.
 *
 * Applied only where a shared library is actually in play. Everywhere else the
 * faction's own catalogue is already the right scope.
 */
const SHARED_LIBRARY_SPLIT = {
  drukhari: { keyword: /\bdrukhari\b/i, keep: true },
  aeldari: { keyword: /\bdrukhari\b/i, keep: false },
};

function splitSharedDetachments(slug, detachments) {
  const split = SHARED_LIBRARY_SPLIT[slug];
  if (!split) return detachments;

  const filtered = detachments.filter((d) => {
    const text = d.rules.map((r) => r.text).join(' ');
    return split.keyword.test(text) === split.keep;
  });

  // If the signal ever disappears, keep the whole list rather than silently
  // emptying a faction.
  return filtered.length ? filtered : detachments;
}


/**
 * Entries that are not datasheets.
 *
 * Two kinds get through the extraction and then sit in the roster with no
 * points, reading as 0%-efficiency units rather than as data that does not
 * belong:
 *
 *  1. **Model profiles.** "Sister Novitiate (Autogun)" and "Nob on Smasha
 *     Squig" are rows inside a datasheet, not datasheets. Carrying no keywords
 *     at all is the reliable signal -- every real datasheet has some.
 *
 *  2. **Stale entries.** BSData still lists tenth-edition names the current
 *     points list has dropped: plain "Marneus Calgar" alongside the priced
 *     "Marneus Calgar in Armour of Antilochus". Detected as "absent from the
 *     MFM", which is what makes them unplayable in matched play.
 *
 * Crucible and Legends units are kept. They are genuinely unpriced -- separate
 * game modes -- but they are real units, and the UI already says so.
 */
function isDatasheet(unit) {
  if (!(unit.keywords ?? []).length) return false;
  if (unit.basePoints != null) return true;

  const crucible = (unit.keywords ?? []).some((k) => k.toLowerCase() === 'crucible');
  if (crucible || unit.legends) return true;

  // Units spawned during the game are free by rule, so they never appear in
  // the points list.
  return /spore|ripper|mucolid|spawn \(/i.test(unit.name);
}

/**
 * Units that can never produce an efficiency figure.
 *
 * Points are both halves of the ratio -- the attacker's cost and the value of
 * what it destroys -- so a unit without them is neither a usable attacker nor
 * a usable target. Crucible is a separate game mode, Legends are out of
 * matched play, and spawned units (Spore Mines, Ripper Swarms) are free by
 * rule. All three stay in the faction files as real datasheets; they are just
 * kept out of search.
 */
function isOutOfMatchedPlay(unit) {
  return (
    unit.basePoints == null ||
    unit.legends === true ||
    (unit.keywords ?? []).some((k) => k.toLowerCase() === 'crucible')
  );
}

/** Merge two name lists, matching case-insensitively but keeping display case. */
function union(a = [], b = []) {
  const out = new Map();
  for (const name of [...(a ?? []), ...(b ?? [])]) {
    const key = joinKey(name);
    if (!out.has(key)) out.set(key, name);
  }
  return [...out.values()].sort((x, y) => x.localeCompare(y));
}

async function listRepoFiles(repo, path = '') {
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const body = await fetchCached(url, { fresh });
  return JSON.parse(body);
}

async function main() {
  console.log('Fetching file listings...');
  const [bsFiles, mfmFiles] = await Promise.all([
    listRepoFiles(BS_REPO),
    listRepoFiles(MFM_REPO, 'data'),
  ]);

  const bsCatalogueFiles = bsFiles.filter(
    (f) => f.type === 'file' && f.name.endsWith('.json')
  );
  const mfmYamlFiles = mfmFiles.filter((f) => f.type === 'file' && f.name.endsWith('.yaml'));

  console.log(`  ${bsCatalogueFiles.length} BSData catalogues, ${mfmYamlFiles.length} MFM factions`);

  // --- points index -------------------------------------------------------
  console.log('Loading MFM points...');
  const mfmLoaded = await Promise.all(
    mfmYamlFiles.map(async (f) => ({
      slug: f.name.replace(/\.yaml$/, ''),
      text: await fetchCached(f.download_url, { fresh }),
    }))
  );
  const points = buildPointsIndex(mfmLoaded);
  const availableMfmSlugs = new Set(mfmLoaded.map((f) => f.slug));
  console.log(
    `  ${points.byName.size} unique unit names, ${points.ambiguous.size} ambiguous across factions`
  );

  // --- catalogues ---------------------------------------------------------
  // Every catalogue is loaded up front so cross-file `targetId` links resolve.
  console.log('Loading BSData catalogues (first run downloads ~80MB)...');
  const catalogues = [];
  for (const f of bsCatalogueFiles) {
    const text = await fetchCached(f.download_url, { fresh });
    const root = JSON.parse(text);
    // "Warhammer 40,000.json" is the game system: shared definitions that
    // catalogue links resolve into, but not a playable faction itself.
    const cat = root.catalogue ?? root.gameSystem;
    if (!cat) throw new Error(`${f.name}: no catalogue or gameSystem root`);
    catalogues.push({ file: f.name, cat, isGameSystem: !root.catalogue });
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  const { index, gameSystemNodes } = buildIndex(catalogues);
  console.log(`  indexed ${index.size} nodes`);

  const cataloguesById = new Map(catalogues.map(({ cat }) => [cat.id, cat]));

  // --- extract ------------------------------------------------------------
  // Wipe first: renaming a faction slug would otherwise leave the old file
  // behind and the app would happily serve stale data.
  if (!onlyFaction) await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  const manifest = [];
  const unmatched = [];
  const notDatasheets = [];
  const searchIndex = [];

  for (const { file, cat, isGameSystem } of catalogues) {
    if (isGameSystem) continue;
    if (cat.library) continue; // libraries are data stores, not playable factions

    const factionName = cat.name;
    const slug = slugify(
      factionName.replace(/^(Imperium|Chaos|Xenos|Aeldari)\s*-\s*/, '')
    );
    if (onlyFaction && slug !== onlyFaction) continue;

    const units = extractUnits(cat, index, gameSystemNodes);
    if (units.length === 0) continue;

    const mfmSlug = resolveMfmSlug(factionName, availableMfmSlugs);
    let matched = 0;

    for (const unit of units) {
      const p = lookupPoints(points, mfmSlug, unit.name);
      if (p) {
        matched += 1;
        unit.points = firstSelectionTiers(p.pricing);
        unit.basePoints = basePoints(unit.points);
        unit.role = p.role;
        // Neither source lists every attachment: the datasheet's [Leader] text
        // and the MFM's attachTo each cover cases the other misses, so take the
        // union and let the UI offer everything either one allows.
        unit.attachTo = union(unit.leaderAttachTo, p.attachTo);
      } else {
        unit.points = [];
        unit.basePoints = null;
        unit.attachTo = unit.leaderAttachTo ?? [];
        unmatched.push(`${factionName}: ${unit.name}`);
      }
    }

    const dropped = units.filter((u) => !isDatasheet(u));
    for (const u of dropped) notDatasheets.push(`${factionName}: ${u.name}`);
    const kept = units.filter(isDatasheet);

    const detachments = splitSharedDetachments(
      slug,
      dedupeDetachments(
        [cat, ...detachmentSources(cat, cataloguesById)].flatMap((c) =>
          extractDetachments(c, index)
        )
      )
    );
    const display = displayFaction(slug, factionName);
    const payload = {
      name: display.name,
      group: display.group,
      catalogue: factionName,
      slug,
      source: file,
      detachments,
      units: kept,
    };
    const outPath = join(OUT_DIR, `${slug}.json`);
    await writeFile(outPath, JSON.stringify(payload), 'utf8');

    for (const unit of kept) {
      // Crucible and Legends units stay in the faction files -- they are real
      // datasheets -- but they are kept out of search. Neither has matched-play
      // points, so a row for one could only ever show a blank efficiency.
      if (isOutOfMatchedPlay(unit)) continue;

      // The rank-and-file profile, chosen the same way the app does it:
      // skip the squad leader, then take the weakest of what is left.
      const model = bulkModel(unit.models);
      searchIndex.push({
        name: unit.name,
        faction: display.name,
        factionGroup: display.group,
        slug,
        points: unit.basePoints,
        models: unit.points?.length ? Math.min(...unit.points.map((t) => t.models)) : 1,
        toughness: model?.toughness ?? null,
        save: model?.save ?? null,
        wounds: model?.wounds ?? null,
        invulnerable: model?.invulnerable ?? null,
        legends: unit.legends,
        keywords: unit.keywords,
      });
    }

    const pct = Math.round((matched / kept.length) * 100);
    manifest.push({
      slug,
      name: display.name,
      group: display.group,
      units: kept.length,
      pointsMatched: matched,
    });
    console.log(`  ${display.name}: ${kept.length} units, ${pct}% priced`);
  }

  await writeFile(
    join(OUT_DIR, 'index.json'),
    JSON.stringify({ built: new Date().toISOString(), factions: manifest }),
    'utf8'
  );

  // A flat, lightweight roster so the app can search every unit by name
  // without downloading all 36 faction files. Carries just enough to render a
  // search result and then fetch the right faction on demand.
  await writeFile(
    join(OUT_DIR, 'search.json'),
    JSON.stringify({ built: new Date().toISOString(), units: searchIndex }),
    'utf8'
  );

  const totalUnits = manifest.reduce((n, f) => n + f.units, 0);
  const totalMatched = manifest.reduce((n, f) => n + f.pointsMatched, 0);
  console.log(
    `\n${manifest.length} factions, ${totalUnits} units, ` +
      `${Math.round((totalMatched / totalUnits) * 100)}% priced`
  );

  if (notDatasheets.length) {
    await writeFile(
      join(process.cwd(), '.cache', 'not-datasheets.txt'),
      notDatasheets.join('\n'),
      'utf8'
    );
    console.log(`${notDatasheets.length} non-datasheet entries dropped, listed in .cache/not-datasheets.txt`);
  }

  if (unmatched.length) {
    await writeFile(
      join(process.cwd(), '.cache', 'unmatched.txt'),
      unmatched.join('\n'),
      'utf8'
    );
    console.log(`${unmatched.length} unpriced units listed in .cache/unmatched.txt`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
