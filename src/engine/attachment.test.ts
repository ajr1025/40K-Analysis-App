/**
 * Attached leaders.
 *
 * The direction that gets missed is squad → leader: Asurmen joining Dire
 * Avengers picks up Bladestorm, and nothing on his own datasheet says so.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DataUnit } from './adapt';
import { toTarget } from './adapt';
import {
  attachableTo,
  attachedEffects,
  attachedLoadout,
  attachedModifiers,
  attachedPoints,
  canAttach,
} from './attachment';
import { pointsEfficiency, resolveLoadout } from './resolve';

const DATA = join(process.cwd(), 'public', 'data');
const hasData = existsSync(join(DATA, 'index.json'));
const describeWithData = hasData ? describe : describe.skip;

function load(): Array<DataUnit & { faction: string }> {
  const manifest = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8')) as {
    factions: Array<{ slug: string }>;
  };
  const out: Array<DataUnit & { faction: string }> = [];
  for (const { slug } of manifest.factions) {
    const p = join(DATA, `${slug}.json`);
    if (existsSync(p)) {
      const d = JSON.parse(readFileSync(p, 'utf8'));
      for (const u of d.units) out.push({ ...u, faction: d.name });
    }
  }
  return out;
}

describeWithData('attaching a leader', () => {
  const units = load();
  const unit = (n: string, f?: string) =>
    units.find((u) => u.name.toLowerCase() === n.toLowerCase() && (!f || u.faction.includes(f)))!;

  it('respects the datasheet attachment list', () => {
    const asurmen = unit('Asurmen');
    const avengers = unit('Dire Avengers');
    const intercessors = unit('Intercessor Squad', 'Space Marines');

    expect(canAttach(asurmen, avengers)).toBe(true);
    expect(canAttach(asurmen, intercessors)).toBe(false);
    expect(attachableTo(asurmen, units).map((u) => u.name)).toContain('Dire Avengers');
  });

  it('gives the leader the squad\'s own ability', () => {
    // Bladestorm reads "weapons equipped by models in this unit" — once
    // Asurmen joins, he is one of those models.
    const attachment = { leader: unit('Asurmen'), bodyguard: unit('Dire Avengers') };
    const effects = attachedEffects(attachment, 'ranged', { optional: ['Bladestorm'] });

    const bladestorm = effects.buffs.find((b) => /bladestorm/i.test(b.source));
    expect(bladestorm).toBeDefined();
    expect(bladestorm!.modifiers.grantSustainedHits).toBe(1);
  });

  it('leaves a half-range squad ability off until asked for', () => {
    const attachment = { leader: unit('Asurmen'), bodyguard: unit('Dire Avengers') };
    const off = attachedEffects(attachment, 'ranged');
    expect(off.buffs.some((b) => /bladestorm/i.test(b.source))).toBe(false);
    expect(off.optional.map((b) => b.source)).toContain('Bladestorm');
  });

  it('applies the leader\'s own grant to the squad', () => {
    // Adrax grants a melee wound reroll to the unit he leads.
    const adrax = unit('Adrax Agatone');
    const bladeguard = unit('Bladeguard Veteran Squad', 'Space Marines');
    expect(canAttach(adrax, bladeguard)).toBe(true);

    const melee = attachedModifiers({ leader: adrax, bodyguard: bladeguard }, {}, 'melee');
    expect(melee.modifiers.rerollWounds).toBe('failures');

    // ...and not to shooting, because the ability is melee-scoped.
    const ranged = attachedModifiers({ leader: adrax, bodyguard: bladeguard }, {}, 'ranged');
    expect(ranged.modifiers.rerollWounds).toBeUndefined();
  });

  it('charges the combined points cost', () => {
    const adrax = unit('Adrax Agatone');
    const bladeguard = unit('Bladeguard Veteran Squad', 'Space Marines');
    const combined = attachedPoints({ leader: adrax, bodyguard: bladeguard })!;
    expect(combined).toBe(adrax.basePoints! + bladeguard.basePoints!);
  });

  it('fires the leader\'s weapons alongside the squad\'s', () => {
    const attachment = { leader: unit('Asurmen'), bodyguard: unit('Dire Avengers') };
    const entries = attachedLoadout(attachment, 'ranged');
    expect(entries.length).toBeGreaterThan(1);
    // Every entry has a positive model count and a usable weapon.
    for (const e of entries) {
      expect(e.models).toBeGreaterThan(0);
      expect(e.weapon).toBeTruthy();
    }
  });

  it('scores an attached unit through the engine against combined points', () => {
    const adrax = unit('Adrax Agatone');
    const bladeguard = unit('Bladeguard Veteran Squad', 'Space Marines');
    const attachment = { leader: adrax, bodyguard: bladeguard };
    const marines = unit('Intercessor Squad', 'Space Marines');
    const target = { ...toTarget(marines)!, keywords: marines.keywords };

    const entries = attachedLoadout(attachment, 'melee');
    const { modifiers } = attachedModifiers(attachment, target, 'melee');
    const result = resolveLoadout(entries, target, modifiers)!;

    const combined = attachedPoints(attachment)!;
    const eff = pointsEfficiency(result, target, marines.basePoints!, combined);

    expect(result.totalDamage).toBeGreaterThan(0);
    // Efficiency must be measured against both units' points, not one.
    const wrong = pointsEfficiency(result, target, marines.basePoints!, bladeguard.basePoints!);
    expect(eff).toBeLessThan(wrong);
  });

  it('reports abilities it could not model rather than hiding them', () => {
    let reported = 0;
    for (const leader of units.filter((u) => (u.attachTo ?? []).length)) {
      const bodyguard = attachableTo(leader, units)[0];
      if (!bodyguard) continue;
      reported += attachedEffects({ leader, bodyguard }, 'ranged').unmodelled.length;
    }
    // Some exist; the point is that they surface at all.
    expect(reported).toBeGreaterThan(0);
  });
});
