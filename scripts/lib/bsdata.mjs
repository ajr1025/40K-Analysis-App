/**
 * BSData catalogue -> flat unit records.
 *
 * The shape here is BattleScribe's XML mechanically converted to JSON, which
 * means two things the extraction has to cope with:
 *
 *  1. Faction catalogues are mostly empty shells. "Aeldari - Craftworlds.json"
 *     is 24KB of `entryLinks` pointing into "Aeldari - Aeldari Library.json",
 *     which is 6.3MB. Anything that reads a faction file alone finds no units.
 *
 *  2. A unit's statline is frequently NOT on the unit entry. Dire Avengers
 *     carries only an Abilities profile; the actual models live in
 *     `selectionEntryGroups` ("4-9 Dire Avengers", "Dire Avenger Exarch").
 *     Walking `selectionEntries` alone silently drops a large chunk of the
 *     roster, so the walk has to cover groups and links too.
 */

import { isLegends, stripQualifiers } from './names.mjs';

const UNIT_PROFILE = 'Unit';
const RANGED_PROFILE = 'Ranged Weapons';
const MELEE_PROFILE = 'Melee Weapons';
const ABILITY_PROFILE = 'Abilities';

/**
 * Subtrees that hang off a datasheet without belonging to it.
 *
 * **Enhancements** are detachment upgrades bought with points. **Crusade** is
 * the narrative campaign mode, carrying its own relics and abilities. Both are
 * linked from every eligible unit, so following them attaches other people's
 * wargear to the datasheet: the Crusade archeotech relic "Syntaxik Charger"
 * (A8, Anti-Infantry 2+, Devastating Wounds) reached 39 Adeptus Mechanicus
 * units including aircraft, and was strong enough to distort every score it
 * touched.
 *
 * Matched on whole words. Without the boundaries "crusade" also matches
 * "Crusaders", so a Black Templars Crusader Squad had its own model group
 * treated as foreign content and thrown away.
 */
const FOREIGN_SUBTREE = /\b(enhancements?|crusade)\b/i;

function isForeignLink(link, target) {
  return FOREIGN_SUBTREE.test(link?.name ?? '') || FOREIGN_SUBTREE.test(target?.name ?? '');
}

/**
 * Core weapon keywords whose rule text BSData links onto any unit carrying a
 * weapon with that keyword.
 *
 * These are glossary definitions, not unit abilities -- a Plague Marine does
 * not "have Torrent", one of its weapons does. The keyword is already captured
 * on the weapon profile, so keeping the definition here would bury the unit's
 * real abilities under boilerplate and skew any scan of what a unit can do.
 */
const WEAPON_KEYWORD_RULES = new Set(
  [
    'anti',
    'assault',
    'blast',
    'close-quarters',
    'cleave',
    'devastating wounds',
    'extra attacks',
    'hazardous',
    'heavy',
    'ignores cover',
    'indirect fire',
    'lance',
    'lethal hits',
    'melta',
    'one shot',
    'pistol',
    'precision',
    'psychic',
    'rapid fire',
    'sustained hits',
    'torrent',
    'twin-linked',
  ].map((k) => k.toLowerCase())
);

/** Strip any trailing value so "Sustained Hits 1" matches "sustained hits". */
function isWeaponKeywordRule(name) {
  const base = String(name ?? '')
    .toLowerCase()
    .replace(/\s*\[?\d+\+?\]?$/, '')
    .replace(/\s*d\d+$/, '')
    .replace(/[[\]]/g, '')
    .trim();
  return WEAPON_KEYWORD_RULES.has(base);
}

/** Pull the `$text` of a named characteristic off a profile. */
function characteristic(profile, name) {
  const c = (profile.characteristics ?? []).find((x) => x.name === name);
  return c?.$text ?? null;
}

/**
 * Index every addressable node in a set of catalogues by id, so `targetId`
 * links can be resolved regardless of which file the target lives in.
 */
export function buildIndex(catalogues) {
  const index = new Map();
  // Nodes belonging to the game system rather than to any faction. Units link
  // to its config toggles ("Show Legends", "Weapon Modifications"), and
  // following those transitively drags in the handful of weapon profiles it
  // defines -- which is how "Vortex Grenade" ended up on 75% of the roster.
  const gameSystemNodes = new WeakSet();

  const add = (node) => {
    if (node?.id && !index.has(node.id)) index.set(node.id, node);
  };

  for (const { cat, isGameSystem } of catalogues) {
    for (const key of [
      'sharedSelectionEntries',
      'sharedSelectionEntryGroups',
      'sharedProfiles',
      'sharedRules',
      'sharedInfoGroups',
      'categoryEntries',
    ]) {
      for (const node of cat[key] ?? []) add(node);
    }
    // Nested shared entries can themselves be link targets.
    walkAll(cat, (node) => {
      add(node);
      if (isGameSystem) gameSystemNodes.add(node);
    });
  }
  return { index, gameSystemNodes };
}

/** Depth-first visit of every object that could carry an id. */
function walkAll(node, visit, seen = new Set()) {
  if (!node || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const child of node) walkAll(child, visit, seen);
    return;
  }
  visit(node);
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') walkAll(value, visit, seen);
  }
}

/**
 * Collect every profile reachable from a selection entry, following the three
 * containers BattleScribe uses interchangeably: direct children, groups, and
 * links into shared entries.
 */
function collectProfiles(entry, index, seen = new Set(), out = []) {
  if (!entry || typeof entry !== 'object') return out;
  if (seen.has(entry)) return out;
  seen.add(entry);

  for (const p of entry.profiles ?? []) out.push(p);

  for (const child of entry.selectionEntries ?? []) {
    collectProfiles(child, index, seen, out);
  }
  for (const group of entry.selectionEntryGroups ?? []) {
    collectProfiles(group, index, seen, out);
  }
  for (const link of [...(entry.entryLinks ?? []), ...(entry.infoLinks ?? [])]) {
    const target = index.get(link.targetId);
    if (isForeignLink(link, target)) continue;

    if (target) {
      // A link may point straight at a shared profile rather than at an entry
      // that contains one. Fire Dragons put the statline directly on the model
      // entry; Dragon Knights infoLink out to a shared "Unit" profile. Missing
      // this second form silently drops the whole unit for want of a statline.
      if (isProfile(target)) out.push(target);
      else collectProfiles(target, index, seen, out);
    }
    // A link may also carry inline profile overrides.
    for (const p of link.profiles ?? []) out.push(p);
  }
  return out;
}

/**
 * Detachments and the rules they bring.
 *
 * A detachment changes a unit's output as much as its own abilities do —
 * Blood Angels and Dark Angels both have Oath of Moment, but a Liberator
 * Assault Group is a very different melee proposition to a Gladius. They are
 * deliberately kept off the datasheets (every unit in the faction links every
 * detachment, so attaching them per unit is both noise and wrong) and
 * collected once per faction for the player to pick from.
 */
export function extractDetachments(catalogue, index) {
  const detachments = [];

  // Catalogues disagree about where detachments live and how they carry their
  // rules. Space Marines put them in a top-level shared group with the rule
  // text inline; Necrons nest a "Detachment" group inside a shared entry of
  // the same name and reach the text through infoLinks. Walking for the group
  // by name, and reading both rule sources, covers both without hardcoding a
  // shape per faction.
  for (const group of detachmentGroups(catalogue)) {
    for (const entry of group.selectionEntries ?? []) {
      const rules = detachmentRules(entry, index);

      // A detachment without rules is a name in a list; nothing to model.
      if (!rules.length) continue;
      detachments.push({ name: stripQualifiers(entry.name ?? ''), rules });
    }
  }

  return dedupeBy(detachments, (d) => d.name.toLowerCase());
}

/**
 * Groups that hold detachments, wherever the catalogue chose to put them.
 *
 * Matched on the group name rather than on position, because the position
 * varies by faction but the name does not. The name check is what keeps
 * Enhancements out: those sit in sibling groups and, now that linked rules are
 * read, would otherwise look exactly like detachments -- Necrons would report
 * "Enaegic Dermal Bond" granting Feel No Pain 4+ as a detachment.
 */
const DETACHMENT_GROUP = /^detachments?$/i;

function detachmentGroups(catalogue) {
  const groups = (catalogue.sharedSelectionEntryGroups ?? []).filter((g) =>
    DETACHMENT_GROUP.test(g.name ?? '')
  );
  for (const entry of catalogue.sharedSelectionEntries ?? []) {
    for (const group of entry.selectionEntryGroups ?? []) {
      if (DETACHMENT_GROUP.test(group.name ?? '')) groups.push(group);
    }
  }
  return groups;
}

/**
 * A detachment's rules, from inline `rules` or from the shared rules its
 * infoLinks point at. The linked form is not a fallback — it is how most
 * factions store them, and reading only inline rules silently drops those
 * detachments rather than failing.
 */
function detachmentRules(entry, index) {
  const out = [];

  for (const rule of entry.rules ?? []) {
    out.push({ name: rule.name ?? '', text: rule.description ?? '' });
  }

  for (const link of entry.infoLinks ?? []) {
    const target = index?.get(link.targetId);
    if (!target) continue;
    if (isProfile(target)) {
      const description = (target.characteristics ?? []).find((c) =>
        /description|ability/i.test(c.name ?? '')
      );
      out.push({ name: link.name ?? target.name ?? '', text: description?.$text ?? '' });
      continue;
    }
    out.push({
      name: applyNameModifiers(link.name ?? target.name ?? '', link.modifiers),
      text: target.description ?? '',
    });
  }

  return (
    out
      .map((r) => ({ name: r.name.trim(), text: cleanRuleText(r.text) }))
      .filter((r) => r.name && r.text)
      // Detachments link the glossary entry for every keyword they mention, so
      // a Dread Mob arrives carrying the rulebook definitions of Sustained
      // Hits and Lethal Hits as though they were its own rules.
      .filter((r) => !isWeaponKeywordRule(r.name))
  );
}

/**
 * BSData marks emphasis inside rule text with `**` and `^^`, sometimes
 * unclosed ("^^**Destroyer Cult^^**"). Left in, it splits the phrases the
 * effect parser matches on -- "**[SUSTAINED HITS 1]**" does not read as a
 * granted keyword.
 */
function cleanRuleText(text) {
  return (text ?? '')
    .replace(/[*^]{1,2}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A profile node carries characteristics; a selection entry does not. */
function isProfile(node) {
  return typeof node.typeName === 'string' && Array.isArray(node.characteristics);
}

/**
 * Collect a unit's *innate* abilities.
 *
 * Deliberately narrower than `collectProfiles`: it follows `infoLinks` but not
 * `entryLinks`. That distinction is what separates what a unit has from what
 * it could buy -- a Librarian in Terminator Armour carries "Veil of Time"
 * directly, while "Fire Discipline", "Artificer Armour" and the rest of the
 * faction's Enhancements hang off an `entryLink` named "Enhancements". Walking
 * entry links here would make every leader appear to grant every enhancement
 * in its faction.
 */
function collectAbilities(entry, index, seen = new Set(), out = []) {
  if (!entry || typeof entry !== 'object' || seen.has(entry)) return out;
  seen.add(entry);

  for (const p of entry.profiles ?? []) {
    if (p.typeName === ABILITY_PROFILE) out.push(p);
  }
  for (const child of entry.selectionEntries ?? []) collectAbilities(child, index, seen, out);
  for (const group of entry.selectionEntryGroups ?? []) collectAbilities(group, index, seen, out);

  // infoLinks reference shared profiles and rules; they never introduce a
  // purchasable option.
  for (const link of entry.infoLinks ?? []) {
    const target = index.get(link.targetId);
    if (!target) continue;

    // Detachment rules are linked onto every unit in the faction, but they
    // belong to the detachment you chose, not to the unit -- the same
    // separation that keeps Enhancements and Crusade content out. Including
    // them would put "Command Protocols" on every Necron datasheet.
    if (/detachment/i.test(link.name ?? '') || /detachment/i.test(target.name ?? '')) continue;
    if (isForeignLink(link, target)) continue;

    if (isProfile(target)) {
      if (target.typeName === ABILITY_PROFILE) out.push(target);
      continue;
    }

    // A linked *rule* carries its value in the link's modifiers rather than in
    // its text. Feel No Pain is stored as the generic rule plus an "append 5+
    // to the name" modifier, so the rule text alone never says 5+ and reading
    // only profiles misses the ability completely.
    if (link.type === 'rule' && (target.description || target.name)) {
      const name = applyNameModifiers(link.name ?? target.name ?? '', link.modifiers);
      if (!isWeaponKeywordRule(name)) {
        out.push({
          name,
          typeName: ABILITY_PROFILE,
          characteristics: [{ name: 'Description', $text: target.description ?? '' }],
        });
      }
      continue;
    }

    collectAbilities(target, index, seen, out);
  }
  return out;
}

/**
 * Rebuild a link's effective name from its modifiers.
 *
 * BattleScribe expresses "Feel No Pain 5+" and "Deadly Demise D6" as the base
 * rule plus a modifier appending the value, so the value only exists once the
 * modifier is applied.
 */
function applyNameModifiers(name, modifiers) {
  let out = name;
  for (const modifier of modifiers ?? []) {
    if (modifier.field !== 'name') continue;
    if (modifier.type === 'append') out = `${out} ${modifier.value}`.trim();
    else if (modifier.type === 'set') out = String(modifier.value);
  }
  return out;
}

/** Flatten a profile's characteristics into one text blob. */
function profileText(profile) {
  return (profile.characteristics ?? [])
    .map((c) => c.$text ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The units a leader may attach to, read from the [Leader] ability text.
 *
 * Reads like: "This model can be attached to the following units: * ASSAULT
 * INTERCESSOR SQUAD * BLADEGUARD VETERAN SQUAD ...", bulleted with a literal
 * black-square character.
 */
function parseLeaderTargets(abilities) {
  const leader = abilities.find((a) => /^leader$/i.test(a.name ?? ''));
  if (!leader) return [];

  const text = profileText(leader);
  const after = text.split(/following units:/i)[1];
  if (!after) return [];

  return after
    .split(/[■▪•]/)
    .map((part) => part.replace(/\.$/, '').trim())
    .filter((part) => part.length > 1 && part.length < 60)
    .map((part) => titleCase(part));
}

/** BSData shouts attach targets in caps; the rest of the app uses title case. */
function titleCase(text) {
  return text
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bOf\b/g, 'of')
    .replace(/\bThe\b/g, 'the')
    .trim();
}

/**
 * Read a unit's wargear tree: which model variants it contains, how many of
 * each are legal, and what each one carries.
 *
 * This is what stops the app offering loadouts that cannot be fielded. A
 * Sternguard squad lists a Pyrecannon among its options, but only ONE model
 * may take it -- the constraint lives on the "w/ Special Weapon" variant
 * (max 1), not on the weapon. Reading the flat weapon list and letting the
 * user put five Pyrecannons in a squad produces a confident number for an
 * illegal unit.
 *
 * Shape mirrors the datasheet: groups hold model variants, variants carry
 * fixed weapons plus choice slots ("Weapon Option: pick one of two").
 */

/**
 * Caps that change with squad size.
 *
 * A ten-model Terminator Squad takes two cyclone missile launchers, not one,
 * and the same "double the squad, double the special weapons" pattern runs
 * through Scouts, Seraphim, Strike Squads, Sword Brethren and Crusaders.
 * BSData stores it as a `set` modifier that rewrites a named max constraint
 * when the squad reaches a given size:
 *
 *   constraint: { id: "80a-...", type: "max", value: 1 }
 *   modifier:   { type: "set", field: "80a-...", value: 2,
 *                 conditions: [{ field: "selections", type: "equalTo", value: 10 }] }
 *
 * Reading only the constraint caps a full-strength squad at the small squad's
 * allowance.
 *
 * The scope of the condition is what a rule means. Scoped to the datasheet it
 * counts models in the squad -- a squad ratio. Scoped to the roster or force
 * it is an army-list limit ("at most 2 of this datasheet"). Scoped to a single
 * model it is self-limiting ("if the sergeant already took a combi-weapon,
 * this slot is closed"), and reading that as a squad ratio would have zeroed
 * out every sergeant's weapon options the moment the squad had a model in it.
 */
function maxRules(node, unitId) {
  const maxIds = new Set(
    (node.constraints ?? []).filter((c) => c.type === 'max').map((c) => c.id)
  );
  if (!maxIds.size) return [];

  const rules = [];
  for (const modifier of node.modifiers ?? []) {
    if (modifier.type !== 'set' || !maxIds.has(modifier.field)) continue;
    for (const condition of modifier.conditions ?? []) {
      if (condition.field !== 'selections') continue;
      if (condition.scope !== unitId) continue;
      const models = Number(condition.value);
      const max = Number(modifier.value);
      if (!Number.isFinite(models) || !Number.isFinite(max)) continue;
      rules.push({ when: condition.type, models, max });
    }
  }
  return rules;
}


/**
 * Every container that directly holds model entries.
 *
 * Model entries sit in a group on most datasheets, but some hang them straight
 * off the unit (Wraithguard and Rangers among 137 others), and some nest them
 * further down: a Crusader Squad reads Crusaders -> Initiates -> the models,
 * and an Indomitor Kill Team goes deeper still. Stopping at the top level
 * found one Sword Brother in a twenty-model squad and nothing at all in the
 * Kill Team, so the rest of those units fielded no weapons.
 *
 * Enhancement and Crusade subtrees are skipped for the usual reason: they hang
 * off every eligible datasheet and belong to none of them.
 */
function modelContainers(entry) {
  const containers = [];
  const seen = new Set();

  const visit = (node, name) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (FOREIGN_SUBTREE.test(node.name ?? '')) return;

    if ((node.selectionEntries ?? []).some((e) => e.type === 'model')) {
      containers.push(
        node.selectionEntryGroups || node.constraints
          ? node
          : { name, constraints: [], selectionEntries: node.selectionEntries }
      );
    }

    for (const child of node.selectionEntries ?? []) {
      if (child.type !== 'model') visit(child, child.name ?? name);
    }
    for (const group of node.selectionEntryGroups ?? []) visit(group, group.name ?? name);
  };

  visit(entry, entry.name ?? '');
  return containers;
}

function extractWargear(entry, index) {
  const groups = [];

  const unitId = entry.id;

  const containers = modelContainers(entry);

  for (const group of containers) {
    const variants = [];

    for (const model of group.selectionEntries ?? []) {
      if (model.type !== 'model') continue;

      const fixed = [];
      for (const link of model.entryLinks ?? []) {
        const target = index.get(link.targetId);
        if (target && carriesWeapon(target, index)) fixed.push(stripQualifiers(link.name ?? ''));
      }
      // A model's built-in weapon is often an inline `upgrade` entry rather
      // than a link: a "Windrider with Scatter Laser" links only its close
      // combat weapon and holds the scatter laser as a child entry. Reading
      // links alone left 326 variants carrying nothing but the weapon in
      // their own name -- they fired a knife and the unit read as harmless.
      for (const child of model.selectionEntries ?? []) {
        if (child.type === 'model') continue;
        if (carriesWeapon(child, index)) fixed.push(stripQualifiers(child.name ?? ''));
      }

      const choices = [];
      for (const slot of model.selectionEntryGroups ?? []) {
        const options = [];
        // An option whose name is not itself a weapon needs the weapons it
        // grants recorded, or the loadout resolves to nothing.
        const grants = {};
        // Some caps sit on the individual option rather than on the slot or the
        // model: a Sword Brethren Squad allows two Pyre Pistols, four once it
        // is ten strong, and none below five. Read from the option itself
        // because that is where BSData puts them.
        const optionCaps = {};

        // An option reached by link keeps its cap in two places: the link
        // carries the plain max, while the squad-size rule usually lives on the
        // shared entry it points at, scoped back to this datasheet. Reading
        // only the link missed the Chaos Terminators' power fists entirely.
        const capOf = (node, name, target) => {
          const own = constraint(node, 'max');
          const rules = [...maxRules(node, unitId), ...(target ? maxRules(target, unitId) : [])];
          if (own == null && !rules.length) return;
          optionCaps[name] = { max: own, ...(rules.length ? { maxRules: rules } : {}) };
        };

        for (const link of slot.entryLinks ?? []) {
          const target = index.get(link.targetId);
          if (!target || !carriesWeapon(target, index)) continue;

          // A link to a *group* offers alternatives, not a bundle: the War
          // Walkers' "Heavy Weapons" lists five guns to pick one from.
          // Bundling them armed a single walker with all five.
          if (isGroup(link, target)) {
            options.push(...grantedWeapons(target, index));
            continue;
          }

          const name = stripQualifiers(link.name ?? '');
          options.push(name);
          const parts = grantedWeapons(target, index);
          if (parts.length > 1 || parts[0] !== name) grants[name] = parts;
          capOf(link, name, target);
        }
        for (const child of slot.selectionEntries ?? []) {
          if (!carriesWeapon(child, index)) continue;
          const name = stripQualifiers(child.name ?? '');
          options.push(name);
          const parts = grantedWeapons(child, index);
          if (parts.length > 1 || parts[0] !== name) grants[name] = parts;
          capOf(child, name);
        }

        if (!options.length) continue;
        const slotScaling = maxRules(slot, unitId);
        choices.push({
          name: slot.name ?? '',
          min: constraint(slot, 'min') ?? 0,
          max: constraint(slot, 'max') ?? 1,
          options: [...new Set(options)],
          ...(Object.keys(grants).length ? { grants } : {}),
          ...(slotScaling.length ? { maxRules: slotScaling } : {}),
          ...(Object.keys(optionCaps).length ? { optionCaps } : {}),
        });
      }

      const scaling = maxRules(model, unitId);
      variants.push({
        name: stripQualifiers(model.name ?? ''),
        min: constraint(model, 'min') ?? 0,
        max: constraint(model, 'max') ?? null,
        fixed: [...new Set(fixed)],
        choices,
        ...(scaling.length ? { maxRules: scaling } : {}),
      });
    }

    if (!variants.length) continue;
    const groupScaling = maxRules(group, unitId);
    groups.push({
      name: group.name ?? '',
      min: constraint(group, 'min') ?? 0,
      max: constraint(group, 'max') ?? null,
      variants,
      ...(groupScaling.length ? { maxRules: groupScaling } : {}),
    });
  }

  return groups;
}

/** Read a min/max constraint, preferring the one scoped to the parent. */
function constraint(node, type) {
  const all = (node.constraints ?? []).filter((c) => c.type === type);
  if (!all.length) return null;
  const parent = all.find((c) => !c.scope || c.scope === 'parent');
  const value = Number((parent ?? all[0]).value);
  return Number.isFinite(value) ? value : null;
}

/** True when this entry resolves to something with a weapon profile. */
function carriesWeapon(node, index, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return false;
  seen.add(node);

  for (const p of node.profiles ?? []) {
    if (p.typeName === RANGED_PROFILE || p.typeName === MELEE_PROFILE) return true;
  }
  for (const link of node.infoLinks ?? []) {
    const target = index.get(link.targetId);
    if (target && (target.typeName === RANGED_PROFILE || target.typeName === MELEE_PROFILE)) return true;
  }
  for (const child of node.selectionEntries ?? []) {
    if (carriesWeapon(child, index, seen)) return true;
  }
  // Some options are bundles that hold their weapons only as links: the
  // Terminators' "Cyclone Missile Launcher & Storm Bolter" has no profile of
  // its own and links the two guns. Judged weaponless, it was dropped, and the
  // cyclone missile launcher vanished from the datasheet entirely.
  for (const link of node.entryLinks ?? []) {
    if (carriesWeapon(index.get(link.targetId), index, seen)) return true;
  }
  return false;
}

/**
 * True when a node is a group of alternatives rather than a single selection.
 *
 * BSData marks the link, not always the target, so both are checked. Groups
 * hold options you choose between; entries hold things you take.
 */
function isGroup(link, target) {
  return link?.type === 'selectionEntryGroup' || target?.type === 'selectionEntryGroup';
}

/**
 * The weapons an option actually grants.
 *
 * Usually just itself. A bundle grants several -- and the storm bolter inside
 * the cyclone bundle is the whole reason a Terminator keeps shooting after
 * taking the launcher, which is additive rather than a swap.
 */
function grantedWeapons(node, index) {
  const names = [];
  const own = stripQualifiers(node.name ?? '');

  for (const link of node.entryLinks ?? []) {
    const target = index.get(link.targetId);
    if (target && carriesWeapon(target, index)) names.push(stripQualifiers(link.name ?? target.name ?? ''));
  }
  for (const child of node.selectionEntries ?? []) {
    if (carriesWeapon(child, index)) names.push(stripQualifiers(child.name ?? ''));
  }

  const unique = [...new Set(names.filter(Boolean))];
  return unique.length && !(unique.length === 1 && unique[0] === own) ? unique : [own];
}

/** Unit keywords come from category links, not from a profile. */
function collectKeywords(entry, index, seen = new Set(), out = new Set()) {
  if (!entry || typeof entry !== 'object' || seen.has(entry)) return out;
  seen.add(entry);

  for (const link of entry.categoryLinks ?? []) {
    const name = link.name ?? index.get(link.targetId)?.name;
    if (name) out.add(name.replace(/^Faction:\s*/i, '').trim());
  }
  for (const child of entry.selectionEntries ?? []) collectKeywords(child, index, seen, out);
  for (const group of entry.selectionEntryGroups ?? []) collectKeywords(group, index, seen, out);
  return out;
}

/** Blank characteristics come through as "" or "-"; normalise both to null. */
function clean(value) {
  const v = (value ?? '').trim();
  return v === '' || v === '-' ? null : v;
}

/**
 * Normalise a weapon keyword's capitalisation.
 *
 * BSData is inconsistent about it -- "Sustained Hits 1" and "Sustained hits 1",
 * "Anti-INFANTRY 4+" and "Anti-Infantry 4+" all appear. Parsing is
 * case-insensitive so this does not change behaviour, but leaving it alone
 * breaks case-sensitive de-duplication and looks sloppy in the UI.
 */
function normaliseKeyword(keyword) {
  return keyword
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[A-Za-z']+/g, (word) =>
      word.length <= 1 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1).toLowerCase()
    );
}

function parseWeapon(profile, kind) {
  const keywords = (characteristic(profile, 'Keywords') ?? '')
    .split(',')
    .map((k) => normaliseKeyword(k))
    .filter((k) => k && k !== '-');

  // BSData prefixes a weapon's alternate firing modes with an arrow:
  // "➤ Plasma pistol - supercharge". Keep the distinction, drop the glyph.
  const rawName = stripQualifiers(profile.name ?? '');
  const isMode = rawName.startsWith('➤');
  const range = clean(characteristic(profile, 'Range'));

  // A handful of profiles are filed under the wrong profile type -- the
  // Greater Blight Drone's plague probe is a "Ranged Weapons" profile with a
  // range of "Melee". Trust the Range characteristic over the filing, since
  // that is what decides whether the weapon uses BS or WS.
  const actualKind = /melee/i.test(range ?? '') ? 'melee' : kind;

  return {
    name: rawName.replace(/^➤\s*/, ''),
    mode: isMode,
    kind: actualKind,
    range,
    attacks: clean(characteristic(profile, 'A')),
    skill: clean(characteristic(profile, kind === 'ranged' ? 'BS' : 'WS')),
    strength: clean(characteristic(profile, 'S')),
    ap: clean(characteristic(profile, 'AP')),
    damage: clean(characteristic(profile, 'D')),
    keywords,
  };
}

function parseModel(profile) {
  return {
    name: stripQualifiers(profile.name ?? ''),
    movement: clean(characteristic(profile, 'M')),
    toughness: clean(characteristic(profile, 'T')),
    save: clean(characteristic(profile, 'Sv')),
    wounds: clean(characteristic(profile, 'W')),
    leadership: clean(characteristic(profile, 'LD')),
    objectiveControl: clean(characteristic(profile, 'OC')),
    invulnerable: clean(characteristic(profile, 'InSv')),
  };
}

/**
 * Extract unit records from a faction catalogue plus its linked libraries.
 * Returns only entries that resolve to at least one model statline -- upgrades,
 * detachments and enhancements are not units.
 */
export function extractUnits(factionCatalogue, index, gameSystemNodes = new WeakSet()) {
  const units = [];
  const emitted = new Set();

  const candidates = [];
  // Units the faction owns outright.
  for (const entry of factionCatalogue.sharedSelectionEntries ?? []) {
    candidates.push(entry);
  }
  // Units the faction pulls in from a library.
  for (const link of factionCatalogue.entryLinks ?? []) {
    const target = index.get(link.targetId);
    if (target) candidates.push(target);
  }

  for (const entry of candidates) {
    if (!['unit', 'model'].includes(entry.type)) continue;
    if (emitted.has(entry.id)) continue;
    // "Deathwatch Veteran w/ stalker bolt rifle" is a loadout option inside a
    // Kill Team, not a unit you can field -- it has no points of its own.
    if (/\sw\/\s/i.test(entry.name ?? '')) continue;

    const profiles = collectProfiles(entry, index).filter((p) => !gameSystemNodes.has(p));
    const models = profiles.filter((p) => p.typeName === UNIT_PROFILE).map(parseModel);
    if (models.length === 0) continue;

    const weapons = [
      ...profiles.filter((p) => p.typeName === RANGED_PROFILE).map((p) => parseWeapon(p, 'ranged')),
      ...profiles.filter((p) => p.typeName === MELEE_PROFILE).map((p) => parseWeapon(p, 'melee')),
    ];

    const abilityProfiles = dedupeBy(
      collectAbilities(entry, index).filter((p) => !gameSystemNodes.has(p)),
      (p) => p.name
    );
    const abilities = abilityProfiles.map((p) => ({
      name: stripQualifiers(p.name ?? ''),
      text: profileText(p),
    }));

    emitted.add(entry.id);
    units.push({
      id: entry.id,
      name: stripQualifiers(entry.name ?? ''),
      legends: isLegends(entry.name ?? ''),
      models: dedupeBy(models, (m) => m.name),
      // Case-insensitive: BSData carries both "Power fist" and "Power Fist"
      // on the same datasheet, which a case-sensitive key would keep as two.
      weapons: dedupeBy(weapons, (w) => `${w.kind}:${w.name.toLowerCase()}`),
      keywords: [...collectKeywords(entry, index)],
      wargear: extractWargear(entry, index),
      abilities,
      // Read off the [Leader] ability text; cross-checked against the MFM
      // attachTo list in build-data.mjs.
      leaderAttachTo: parseLeaderTargets(abilityProfiles),
    });
  }

  return units;
}

function dedupeBy(items, key) {
  const seen = new Map();
  for (const item of items) {
    const k = key(item);
    if (!seen.has(k)) seen.set(k, item);
  }
  return [...seen.values()];
}
