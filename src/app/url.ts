/**
 * The board in the address bar.
 *
 * The point of the app is a link three people can open, so the board has to
 * live in the URL rather than in local storage. Everything the matrix shows is
 * derived from a handful of choices — which units, which loadouts, which
 * toggles — so those are what get encoded, and the engine recomputes the rest
 * on load.
 *
 * Kept terse rather than readable: a board of ten units against twenty targets
 * still has to fit in a link someone can paste into a message.
 */

import type { Modifiers } from '../engine/resolve';
import type { Attacker, TargetEntry, WeaponScope } from './board';

export interface BoardState {
  attackers: Array<{
    slug: string;
    name: string;
    /** Variant name -> count, plus chosen options, only where changed. */
    loadout?: Array<[string, number, Record<string, string>]>;
    leader?: [string, string];
    enabled?: string[];
  }>;
  targets: Array<{ slug: string; name: string }>;
  modifiers: Modifiers;
  scope: WeaponScope;
  armyRule: string | null;
  detachment: string | null;
  /** Kept so links made before bands replaced filtering still decode. */
  toughness?: number[];
}

export function encodeBoard(
  attackers: Attacker[],
  targets: TargetEntry[],
  modifiers: Modifiers,
  scope: WeaponScope,
  armyRule: string | null,
  detachment: string | null
): string {
  const state: BoardState = {
    attackers: attackers.map((a) => ({
      slug: a.faction.slug,
      name: a.unit.name,
      loadout: a.loadout.selections
        .filter((s) => s.count > 0)
        .map((s) => [s.variant, s.count, s.choices] as [string, number, Record<string, string>]),
      ...(a.leader ? { leader: [a.faction.slug, a.leader.name] as [string, string] } : {}),
      ...(a.enabled.length ? { enabled: a.enabled } : {}),
    })),
    targets: targets.map((t) => ({ slug: t.faction.slug, name: t.unit.name })),
    modifiers,
    scope,
    armyRule,
    detachment,
  };

  return compress(JSON.stringify(state));
}

export function decodeBoard(hash: string): BoardState | null {
  if (!hash) return null;
  try {
    return JSON.parse(decompress(hash)) as BoardState;
  } catch {
    // A truncated or hand-edited link should open an empty board, not an
    // error page.
    return null;
  }
}

/**
 * URL-safe base64 of the UTF-8 bytes.
 *
 * `btoa` only handles Latin-1, and unit names carry accents and apostrophes
 * ("Kharn", "Ghazghkull Mag Uruk Thraka"), so the string is encoded first.
 */
function compress(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decompress(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
