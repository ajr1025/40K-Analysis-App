/**
 * Simulation benchmarks for cross-checking against another engine.
 *
 * Every assumption is stated: unit size, exact weapon profile, target profile,
 * and which modifiers are switched on. Ambiguity here is what made the first
 * attempt at this useless -- unit abilities and half-range Melta were silently
 * absent, so the numbers were not comparable to anything.
 *
 *   npx vitest run src/engine/benchmarkspecs.test.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { type DataUnit, toTarget, toWeapon } from './adapt';
import { type LoadoutEntry, type Modifiers, pointsEfficiency, resolveLoadout } from './resolve';

const DATA = join(process.cwd(), 'public', 'data');
const manifest = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8')) as {
  factions: Array<{ slug: string }>;
};
const units: Array<DataUnit & { faction: string }> = [];
for (const { slug } of manifest.factions) {
  const p = join(DATA, `${slug}.json`);
  if (existsSync(p)) {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    for (const u of d.units) units.push({ ...u, faction: d.name });
  }
}
const unit = (n: string, f?: string) =>
  units.find((u) => u.name.toLowerCase() === n.toLowerCase() && (!f || u.faction.includes(f)))!;

interface Spec {
  id: string;
  varies: string;
  attacker: string;
  attackerFaction?: string;
  /** weapon name, how many models carry it, optional kind for duplicate names */
  guns: Array<[string, number, ('ranged' | 'melee')?]>;
  target: string;
  targetFaction?: string;
  mods?: Modifiers;
  abilities?: string;
}

const SPECS: Spec[] = [
  { id: 'S1', varies: 'Baseline. No abilities, no modifiers.',
    attacker: 'Intercessor Squad', attackerFaction: 'Space Marines', guns: [['Bolt Rifle', 5]],
    target: 'Cadian Shock Troops' },

  { id: 'S2', varies: 'Same attack, +1 to hit.',
    attacker: 'Intercessor Squad', attackerFaction: 'Space Marines', guns: [['Bolt Rifle', 5]],
    target: 'Cadian Shock Troops', mods: { hitModifier: 1 } },

  { id: 'S3', varies: 'Same attack, target in cover (worsens BS by 1).',
    attacker: 'Intercessor Squad', attackerFaction: 'Space Marines', guns: [['Bolt Rifle', 5]],
    target: 'Cadian Shock Troops', mods: { cover: true } },

  { id: 'S4', varies: 'Overkill: D6 damage into 1-wound bodies.',
    attacker: 'Eradicator Squad', attackerFaction: 'Space Marines', guns: [['Melta rifle', 3]],
    target: 'Cadian Shock Troops', mods: { halfRange: true } },

  { id: 'S5', varies: 'Melta into armour. Half range ON, no abilities.',
    attacker: 'Eradicator Squad', attackerFaction: 'Space Marines', guns: [['Melta rifle', 3]],
    target: 'Rhino', targetFaction: 'Space Marines', mods: { halfRange: true } },

  { id: 'S6', varies: 'S5 plus Total Obliteration (reroll hit + wound + damage).',
    attacker: 'Eradicator Squad', attackerFaction: 'Space Marines', guns: [['Melta rifle', 3]],
    target: 'Rhino', targetFaction: 'Space Marines',
    mods: { halfRange: true, rerollHits: 'failures', rerollWounds: 'failures', rerollDamage: true },
    abilities: 'Total Obliteration (vs Vehicle)' },

  { id: 'S7', varies: 'Mixed loadout: 2 melta rifles + 1 multi-melta.',
    attacker: 'Eradicator Squad', attackerFaction: 'Space Marines',
    guns: [['Melta rifle', 2], ['Multi-melta', 1]],
    target: 'Rhino', targetFaction: 'Space Marines',
    mods: { halfRange: true, rerollHits: 'failures', rerollWounds: 'failures', rerollDamage: true },
    abilities: 'Total Obliteration (vs Vehicle)' },

  { id: 'S8', varies: 'Strong save + invuln + Hazardous weapon.',
    attacker: 'Hellblaster Squad', attackerFaction: 'Space Marines',
    guns: [['Plasma incinerator - supercharge', 5]],
    target: 'Terminator Squad', targetFaction: 'Space Marines' },

  { id: 'S9', varies: 'Torrent (auto-hit) into a 5+ save horde.',
    attacker: 'Sternguard Veteran Squad', attackerFaction: 'Space Marines', guns: [['Pyrecannon', 5]],
    target: 'Boyz' },

  { id: 'S10', varies: 'Melee, Anti-Vehicle 3+ and Lance, on the charge.',
    attacker: 'Shining Spears', guns: [['Laser Lance', 3, 'melee']],
    target: 'Land Raider', targetFaction: 'Space Marines', mods: { charged: true } },
];

describe('benchmark specs', () => {
  it('prints ten cross-checkable simulations', () => {
    const lines: string[] = [];
    const say = (s = '') => { lines.push(s); console.log(s); };

    for (const spec of SPECS) {
      const a = unit(spec.attacker, spec.attackerFaction);
      const t = unit(spec.target, spec.targetFaction);
      const target = { ...toTarget(t)!, keywords: t.keywords };

      const entries: LoadoutEntry[] = [];
      const shown: string[] = [];
      let ok = true;
      for (const [name, models, kind] of spec.guns) {
        const raw = a.weapons.find(
          (w) => w.name.toLowerCase() === name.toLowerCase() && (!kind || w.kind === kind)
        );
        if (!raw) { say(`${spec.id}: weapon "${name}" not found on ${a.name}`); ok = false; break; }
        const w = toWeapon(raw)!;
        entries.push({ weapon: w, models });
        shown.push(
          `${models}x ${raw.name} — A${raw.attacks} ${raw.kind === 'melee' ? 'WS' : 'BS'}${raw.skill} ` +
          `S${raw.strength} AP${raw.ap} D${raw.damage}` +
          `${raw.keywords.length ? ' [' + raw.keywords.join(', ') + ']' : ''}`
        );
      }
      if (!ok) continue;

      const r = resolveLoadout(entries, target, spec.mods ?? {})!;
      const eff = pointsEfficiency(r, target, t.basePoints!, a.basePoints!) * 100;

      say(`${spec.id}  ${spec.varies}`);
      say(`   attacker  ${a.name} (${a.basePoints}pts)`);
      for (const s of shown) say(`             ${s}`);
      say(`   target    ${t.name} x${target.models} (${t.basePoints}pts) — T${target.toughness} ` +
          `Sv${target.save}+${target.invulnerable ? '/' + target.invulnerable + '++' : ''} W${target.wounds}` +
          `${target.feelNoPain ? ' FNP' + target.feelNoPain + '+' : ''}` +
          `${target.damageReduction ? ' -' + target.damageReduction + 'dmg' : ''}`);
      say(`   modifiers ${spec.mods && Object.keys(spec.mods).length
        ? Object.entries(spec.mods).map(([k, v]) => `${k}=${v}`).join(', ') : 'none'}`);
      say(`   abilities ${spec.abilities ?? 'none applied'}`);
      say(`   PREDICT   damage ${r.totalDamage.toFixed(2)} | slain ${r.expectedModelsSlain.toFixed(3)}/${target.models}` +
          ` | wipe ${(r.probabilityDestroyed * 100).toFixed(1)}% | efficiency ${eff.toFixed(1)}%`);
      say('');
    }

    say('efficiency = (models slain / target models) x target points / attacker points');
    writeReport('benchmarks.txt', lines.join('\n'));
  });
});

/**
 * Dump a report for eyeballing, without letting it fail the run.
 *
 * `.cache` is gitignored, so on a fresh clone the directory does not exist and
 * the write throws. That is how a suite passing on my machine every time
 * failed the first moment CI ran it: the directory had been sitting there
 * since the first data build. The report is a convenience; the assertions
 * above are the test.
 */
function writeReport(name: string, text: string): void {
  try {
    const dir = join(process.cwd(), '.cache');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), text, 'utf8');
  } catch {
    // The numbers are in the console output either way.
  }
}
