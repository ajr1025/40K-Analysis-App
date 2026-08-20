/**
 * Attack Efficiency.
 *
 * A board of attackers against targets, scored as points destroyed over points
 * spent. It starts empty: the value is in comparing the handful of units you
 * are actually deciding between, not in a wall of every datasheet in the game.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { DataUnit } from '../engine/adapt';
import { attachableTo } from '../engine/attachment';
import { type Detachment, readDetachments } from '../engine/detachments';
import { collectArmyRules, rulesForFaction } from '../engine/armyrules';
import type { Modifiers } from '../engine/resolve';
import { BENCHMARK_TARGETS } from '../data/benchmarks';
import { defaultModifiers } from '../data/modifier-controls';
import { type SearchEntry, searchUnits } from '../data/search';
import {
  type Attacker,
  type TargetEntry,
  type WeaponScope,
  makeAttacker,
  makeTarget,
  sortTargets,
} from './board';
import { type Faction, loadFaction, loadSearch } from './data';
import { LoadoutPanel } from './LoadoutPanel';
import { Matrix, cellFor } from './Matrix';
import { ModifierDrawer } from './ModifierDrawer';
import { Rail } from './Rail';
import { Ranked } from './Ranked';
import { decodeBoard, encodeBoard } from './url';
import './app.css';

/**
 * Half range is on by default.
 *
 * It is where Rapid Fire and Melta live, and with it off every bolter and
 * every melta unit reads far weaker than it plays — Eradicators into a Rhino
 * go from 13.1 damage to 9.1. The toolbar states it so the assumption is
 * visible rather than buried in the drawer.
 */
function startingModifiers(): Modifiers {
  return { ...defaultModifiers(), halfRange: true };
}

let nextId = 0;
const newId = () => `u${(nextId += 1)}`;

/**
 * The board arrives in the hash, and the effect that keeps the hash in step
 * runs before the one that restores from it. Read once at module load, before
 * React can write an empty board over the link someone just opened.
 */
const INCOMING = typeof window !== 'undefined' ? window.location.hash.slice(1) : '';

export default function App() {
  const [index, setIndex] = useState<SearchEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [attackers, setAttackers] = useState<Attacker[]>([]);
  const [targets, setTargets] = useState<TargetEntry[]>([]);
  const [modifiers, setModifiers] = useState<Modifiers>(startingModifiers);
  const [scope, setScope] = useState<WeaponScope>('all');
  const [armyRule, setArmyRule] = useState<string | null>(null);
  const [detachmentName, setDetachmentName] = useState<string | null>(null);
  const [factions, setFactions] = useState<Faction[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [phoneUnit, setPhoneUnit] = useState(0);
  // Nothing is written to the address bar until any incoming board is restored.
  const [restored, setRestored] = useState(!INCOMING);
  // The matrix works on a phone -- it scrolls sideways with the unit column
  // pinned -- so it is the default everywhere. The ranked list stays as a
  // choice for when you want one unit measured against everything.
  const [view, setView] = useState<'matrix' | 'ranked'>('matrix');

  useEffect(() => {
    loadSearch().then(setIndex).catch((e: Error) => setLoadError(e.message));
  }, []);

  const rememberFaction = useCallback((faction: Faction) => {
    setFactions((current) =>
      current.some((f) => f.slug === faction.slug) ? current : [...current, faction]
    );
  }, []);

  const addAttacker = useCallback(
    async (hit: SearchEntry) => {
      const faction = await loadFaction(hit.slug);
      const unit = faction.units.find((u) => u.name === hit.name);
      if (!unit) return;
      rememberFaction(faction);
      setAttackers((current) => [...current, makeAttacker(unit, faction, newId())]);
    },
    [rememberFaction]
  );

  const addTarget = useCallback(
    async (hit: SearchEntry) => {
      const faction = await loadFaction(hit.slug);
      const unit = faction.units.find((u) => u.name === hit.name);
      if (!unit) return;
      const entry = makeTarget(unit, faction, newId());
      if (!entry) return;
      rememberFaction(faction);
      setTargets((current) => sortTargets([...current, entry]));
    },
    [rememberFaction]
  );

  /**
   * The yardstick targets.
   *
   * A curated spread rather than "every unit at this toughness" — Necron
   * Warriors and Cadians are both chaff but 4+ against 5+, a Predator and a
   * Redemptor are both T10 but 3+ against 2+. That spread is what makes a row
   * of numbers tell you where to point the unit. They were sitting in the
   * codebase with no way to put them on the board.
   */
  const addYardstick = useCallback(
    async (spec: { unit: string; faction?: string; profile?: string; label?: string }) => {
      const slug = spec.faction;
      if (!slug) return;
      const faction = await loadFaction(slug);
      const unit = faction.units.find((u) => u.name === spec.unit);
      if (!unit) return;
      const entry = makeTarget(unit, faction, newId());
      if (!entry) return;
      rememberFaction(faction);
      setTargets((current) =>
        current.some((t) => t.unit.name === unit.name)
          ? current
          : sortTargets([...current, entry])
      );
    },
    [rememberFaction]
  );

  // --- army rules and detachments come from the factions on the board ------
  const armyRules = useMemo(() => {
    const units = factions.flatMap((f) => f.units.map((u) => ({ ...u, faction: f.name })));
    return collectArmyRules(units);
  }, [factions]);

  const availableRules = useMemo(() => {
    const names = new Set<string>();
    for (const attacker of attackers) {
      for (const rule of rulesForFaction(armyRules, attacker.faction.name)) names.add(rule.name);
    }
    return [...names].sort();
  }, [armyRules, attackers]);

  const detachments = useMemo(() => {
    const slugs = new Set(attackers.map((a) => a.faction.slug));
    return factions
      .filter((f) => slugs.has(f.slug))
      .flatMap((f) => readDetachments(f.detachments))
      .filter((d) => d.rules.some((r) => r.buff))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [factions, attackers]);

  const detachment: Detachment | null =
    detachments.find((d) => d.name === detachmentName) ?? null;

  // Nearly every army rule is conditional — a nominated target, an active vow,
  // a called Waaagh! — so picking one is the player asserting the condition is
  // met, the same standing assumption as half range.
  const armyRuleBuff = useMemo(
    () => armyRules.find((r) => r.name === armyRule)?.buff ?? null,
    [armyRules, armyRule]
  );

  // --- share link -----------------------------------------------------------
  useEffect(() => {
    if (!restored) return;
    const encoded = encodeBoard(
      attackers,
      targets,
      modifiers,
      scope,
      armyRule,
      detachmentName,
    );
    const next = attackers.length || targets.length ? `#${encoded}` : '';
    if (window.location.hash !== next) {
      window.history.replaceState(null, '', `${window.location.pathname}${next}`);
    }
  }, [restored, attackers, targets, modifiers, scope, armyRule, detachmentName]);

  // Restore a shared board once the search index is available.
  useEffect(() => {
    if (!index.length || restored) return;
    const state = decodeBoard(INCOMING);
    if (!state) {
      setRestored(true);
      return;
    }

    let cancelled = false;
    (async () => {
      const restoredAttackers: Attacker[] = [];
      for (const spec of state.attackers) {
        const faction = await loadFaction(spec.slug);
        const unit = faction.units.find((u) => u.name === spec.name);
        if (!unit) continue;
        rememberFaction(faction);
        const attacker = makeAttacker(unit, faction, newId());
        if (spec.loadout) {
          attacker.loadout = {
            selections: spec.loadout.map(([variant, count, choices]) => ({
              variant,
              count,
              choices,
            })),
          };
        }
        if (spec.leader) {
          const home = await loadFaction(spec.leader[0]);
          attacker.leader = home.units.find((u) => u.name === spec.leader![1]) ?? null;
        }
        attacker.enabled = spec.enabled ?? [];
        restoredAttackers.push(attacker);
      }

      const restoredTargets: TargetEntry[] = [];
      for (const spec of state.targets) {
        const faction = await loadFaction(spec.slug);
        const unit = faction.units.find((u) => u.name === spec.name);
        if (!unit) continue;
        rememberFaction(faction);
        const entry = makeTarget(unit, faction, newId());
        if (entry) restoredTargets.push(entry);
      }

      if (cancelled) return;
      setAttackers(restoredAttackers);
      setTargets(sortTargets(restoredTargets));
      setModifiers(state.modifiers ?? startingModifiers());
      setScope(state.scope ?? 'all');
      setArmyRule(state.armyRule ?? null);
      setDetachmentName(state.detachment ?? null);
      setRestored(true);
    })();

    return () => {
      cancelled = true;
    };
    // Runs once, when the index first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index.length > 0]);

  /**
   * The yardsticks, grouped by toughness.
   *
   * Toughness is the axis you actually think along — "what handles T10?" — so
   * the bands are how the standard targets get onto the board, rather than a
   * separate list of names to pick through. Counts come from the search index,
   * which is already loaded, so no faction file is fetched to draw this.
   */
  const bands = useMemo(() => {
    const byName = new Map(index.map((e) => [`${e.slug}:${e.name}`, e]));
    const groups = new Map<number, typeof BENCHMARK_TARGETS>();
    for (const spec of BENCHMARK_TARGETS) {
      const entry = byName.get(`${spec.faction}:${spec.unit}`);
      const t = Number(entry?.toughness);
      if (!Number.isFinite(t)) continue;
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t)!.push(spec);
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]);
  }, [index]);

  const onBoard = useCallback(
    (spec: { unit: string }) => targets.some((t) => t.unit.name === spec.unit),
    [targets]
  );

  /** A band is on when every yardstick in it is on the board. */
  const toggleBand = useCallback(
    async (specs: typeof BENCHMARK_TARGETS) => {
      const names = new Set(specs.map((s) => s.unit));
      if (specs.every(onBoard)) {
        setTargets((current) => current.filter((t) => !names.has(t.unit.name)));
        return;
      }
      for (const spec of specs) await addYardstick(spec);
    },
    [addYardstick, onBoard]
  );

  // Turning a toughness band off removes its targets, so there is nothing
  // further to filter -- what is on the board is what you see.
  const shownTargets = targets;
  const detail =
    selected && attackers[selected.row] && shownTargets[selected.col]
      ? {
          attacker: attackers[selected.row],
          target: shownTargets[selected.col],
          cell: cellFor(
            attackers[selected.row],
            shownTargets[selected.col],
            modifiers,
            scope,
            detachment,
            armyRuleBuff
          ),
        }
      : null;

  const empty = attackers.length === 0;

  return (
    <div className="wrap">
      <div className="masthead">
        <h1>Attack Efficiency</h1>
        <div className="sub">Warhammer 40,000 · Eleventh Edition</div>
        <div className="masthead-rule" />
      </div>

      <div className="panel">
        <div className="toolbar">
          <div className="seg" role="group" aria-label="View">
            {(['matrix', 'ranked'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() => setView(option)}
              >
                {option === 'matrix' ? 'Matrix' : 'Ranked'}
              </button>
            ))}
          </div>

          <div className="seg" role="group" aria-label="Weapons">
            {(['all', 'ranged', 'melee'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={scope === option}
                onClick={() => setScope(option)}
              >
                {option === 'all' ? 'Both' : option === 'ranged' ? 'Ranged' : 'Melee'}
              </button>
            ))}
          </div>

          <div className="assume" title="Every cell is computed within half range">
            <span className="dot" />
            Within half range
          </div>

          <div className="spacer" />

          {availableRules.length ? (
            <div className="field">
              <span className="label">Army rule</span>
              <select value={armyRule ?? ''} onChange={(e) => setArmyRule(e.target.value || null)}>
                <option value="">None</option>
                {availableRules.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {detachments.length ? (
            <div className="field">
              <span className="label">Detachment</span>
              <select
                value={detachmentName ?? ''}
                onChange={(e) => setDetachmentName(e.target.value || null)}
              >
                <option value="">None</option>
                {detachments.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <button type="button" className="btn" onClick={() => setDrawerOpen((o) => !o)}>
            Modifiers
          </button>

          <button
            type="button"
            className="btn"
            disabled={empty && targets.length === 0}
            onClick={() => {
              void navigator.clipboard?.writeText(window.location.href);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            }}
          >
            {copied ? 'Link copied' : 'Copy link'}
          </button>
        </div>

        <div className="zones">
          <SearchZone
            id="a"
            title="Attackers"
            hint="search to add a row"
            placeholder="Search a unit — try “Term”"
            index={index}
            already={(name) => attackers.some((a) => a.unit.name === name)}
            onPick={addAttacker}
          />
          <SearchZone
            id="t"
            title="Targets"
            hint="inserted in toughness order"
            placeholder="Search a unit — try “Rhino”"
            index={index}
            already={(name) => targets.some((t) => t.unit.name === name)}
            onPick={addTarget}
          />
        </div>

        {bands.length ? (
          <div className="filters">
            <span className="label" style={{ marginRight: 4 }}>
              Toughness
            </span>
            <button
              type="button"
              className="tchip"
              aria-pressed={BENCHMARK_TARGETS.every(onBoard)}
              onClick={() => void toggleBand(BENCHMARK_TARGETS)}
            >
              All <i>{BENCHMARK_TARGETS.length}</i>
            </button>
            {bands.map(([band, specs]) => (
              <button
                key={band}
                type="button"
                className="tchip"
                aria-pressed={specs.every(onBoard)}
                title={specs.map((sp) => sp.label ?? sp.unit).join(', ')}
                onClick={() => void toggleBand(specs)}
              >
                T{band} <i>×{specs.length}</i>
              </button>
            ))}
          </div>
        ) : null}

        {drawerOpen ? (
          <ModifierDrawer modifiers={modifiers} onChange={setModifiers} detachment={detachment} />
        ) : null}
      </div>

      {loadError ? (
        <div className="panel empty open">
          <h2>Could not load the dataset</h2>
          <p>{loadError}</p>
        </div>
      ) : null}

      <div className={`board${detail ? ' with-rail' : ''}`}>
        <div>
          {view === 'ranked' && !empty ? (
            <Ranked
              attackers={attackers}
              targets={shownTargets}
              modifiers={modifiers}
              scope={scope}
              detachment={detachment}
              armyRule={armyRuleBuff}
              active={phoneUnit}
              onPick={setPhoneUnit}
              onRemove={(id) => {
                setAttackers((current) => current.filter((a) => a.id !== id));
                setPhoneUnit(0);
              }}
            />
          ) : empty || shownTargets.length === 0 ? (
            <div className="panel empty open">
              <h2>Nothing on the board yet</h2>
              <p>
                Search for a unit above to add it as a row, and a target to score it against. The
                board starts empty so it only ever shows what you asked for.
              </p>
            </div>
          ) : (
            <Matrix
              attackers={attackers}
              targets={targets}
              modifiers={modifiers}
              scope={scope}
              detachment={detachment}
              armyRule={armyRuleBuff}
              selected={selected}
              onSelect={(row, col) => setSelected({ row, col })}
              onRemove={(id) => {
                setAttackers((current) => current.filter((a) => a.id !== id));
                setSelected(null);
              }}
              expanded={expanded}
              onToggleExpand={(id) => setExpanded((current) => (current === id ? null : id))}
              renderPanel={(attacker) => (
                <LoadoutPanel
                  attacker={attacker}
                  detachment={detachment}
                  leaders={leadersFor(attacker, factions)}
                  modifiers={modifiers}
                  onChange={(next) =>
                    setAttackers((current) =>
                      current.map((a) => (a.id === next.id ? next : a))
                    )
                  }
                />
              )}
            />
          )}
        </div>
        {detail ? <Rail detail={detail} /> : null}
      </div>
    </div>
  );
}

/** Characters from the loaded factions that may lead this unit. */
function leadersFor(attacker: Attacker, factions: Faction[]): DataUnit[] {
  const home = factions.find((f) => f.slug === attacker.faction.slug);
  if (!home) return [];
  return home.units.filter((u) => attachableTo(u, [attacker.unit]).length > 0);
}

interface ZoneProps {
  id: string;
  title: string;
  hint: string;
  placeholder: string;
  index: SearchEntry[];
  already: (name: string) => boolean;
  onPick: (hit: SearchEntry) => void;
  children?: React.ReactNode;
}

function SearchZone({ id, title, hint, placeholder, index, already, onPick, children }: ZoneProps) {
  const [query, setQuery] = useState('');
  const hits = useMemo(
    () => (query.trim() ? searchUnits(index, query, { limit: 40 }) : []),
    [index, query]
  );

  const byFaction = useMemo(() => {
    const groups = new Map<string, SearchEntry[]>();
    for (const hit of hits) {
      if (!groups.has(hit.faction)) groups.set(hit.faction, []);
      groups.get(hit.faction)!.push(hit);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [hits]);

  return (
    <div className={`zone ${id === 'a' ? 'attacker' : 'target'}`}>
      <div className="zonehead">
        <span className="t">{title}</span>
        <span className="s">{hint}</span>
      </div>
      <label className="search">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          value={query}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className={`results${query.trim() ? ' open' : ''}`}>
        {query.trim() && !hits.length ? <div className="rfaction">No match</div> : null}
        {byFaction.map(([faction, entries]) => (
          <div key={faction}>
            <div className="rfaction">{faction}</div>
            {entries.map((hit) => (
              <button
                key={`${hit.slug}:${hit.name}`}
                type="button"
                className="rhit"
                onClick={() => {
                  onPick(hit);
                  setQuery('');
                }}
              >
                <span>{hit.name}</span>
                <span className="pts">
                  {already(hit.name) ? 'on board' : `${hit.points ?? '—'} pts`}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}
