import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DataUnit } from './adapt';
import { collectArmyRules, rulesForFaction } from './armyrules';
import { readSelfBuffs } from './selfbuffs';

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

describeWithData('army rules', () => {
  const units = load();
  const rules = collectArmyRules(units);

  it('collects the army-wide rules once instead of per datasheet', () => {
    const oath = rules.find((r) => r.name === 'Oath of Moment');
    expect(oath).toBeDefined();
    // It is on hundreds of datasheets but is one rule.
    expect(oath!.units).toBeGreaterThan(200);
    expect(oath!.factions.length).toBeGreaterThan(1);
  });

  it('offers a faction only its own rules', () => {
    const marines = rulesForFaction(rules, 'Adeptus Astartes - Space Marines');
    expect(marines.map((r) => r.name)).toContain('Oath of Moment');

    const necrons = rulesForFaction(rules, 'Necrons');
    expect(necrons.map((r) => r.name)).toContain('Reanimation Protocols');
    expect(necrons.map((r) => r.name)).not.toContain('Oath of Moment');
  });

  it('never applies an attack buff without the player asking', () => {
    // Every army rule that actually changes damage needs the player to have
    // nominated a target, chosen a vow, or called a Waaagh! — applying those
    // automatically would inflate an entire faction. Rules with no attack
    // buff (Reanimation Protocols heals) are allowed to be unconditional
    // because they change nothing here.
    for (const rule of rules) {
      if (rule.buff) expect(`${rule.name}: ${rule.conditional}`).toBe(`${rule.name}: true`);
    }
  });

  it('parses the buffs the big army rules actually give', () => {
    const oath = rules.find((r) => r.name === 'Oath of Moment')!;
    expect(oath.buff?.modifiers.rerollHits).toBe('failures');

    const waaagh = rules.find((r) => r.name === 'Waaagh!')!;
    expect(waaagh.buff?.modifiers.attacksModifier).toBe(1);
    expect(waaagh.buff?.modifiers.strengthModifier).toBe(1);
  });

  it('keeps them out of per-unit self-buffs', () => {
    // Otherwise every Space Marine datasheet reports Oath of Moment as its
    // own ability, and a vanilla Intercessor squad shows Templar Vows it
    // would only have in a Templar army.
    for (const unit of units) {
      const names = readSelfBuffs(unit).buffs.map((b) => b.source.toLowerCase());
      expect(names).not.toContain('oath of moment');
      expect(names).not.toContain('templar vows');
    }
  });
});
