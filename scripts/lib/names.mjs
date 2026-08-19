/**
 * Name handling shared by both data sources.
 *
 * BSData and the MFM scraper spell the same unit differently often enough that
 * a naive join only lands about half the roster. The differences are
 * systematic, not random: accents, ampersands, and BSData's bracketed
 * `[Legends]` / `[Crucible]` suffixes.
 */

/** Strip BSData's bracketed and parenthesised qualifiers: "Cobra [Legends]". */
const QUALIFIER = /\s*[[(](legends|crucible|legacy|forge world|index)[\])]\s*/gi;

export function stripQualifiers(name) {
  return name.replace(QUALIFIER, ' ').trim();
}

/** True if BSData tagged this entry as a Legends unit. */
export function isLegends(name) {
  return /\[legends\]/i.test(name);
}

/**
 * Aggressive normalisation used only as a join key -- never for display.
 * Folds accents ("Khârn" -> "kharn"), drops punctuation, collapses spaces.
 */
export function joinKey(name) {
  return stripQualifiers(name)
    // BSData and the MFM disagree on spelling: "Ancient in Terminator Armor"
    // against "Ancient In Terminator Armour". Left alone the unit joins to
    // nothing and reads as having no points at all.
    .replace(/armor/gi, 'armour')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(name) {
  return joinKey(name).replace(/ /g, '-');
}
