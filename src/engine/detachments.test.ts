import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type RawDetachment, detachmentBuffs, optionalRules, readDetachments } from './detachments';
import { resolveBuffs } from './conditions';

const DATA = join(process.cwd(), 'public', 'data');
const hasData = existsSync(join(DATA, 'index.json'));
const describeWithData = hasData ? describe : describe.skip;

function faction(slug: string): { detachments?: RawDetachment[]; name: string } {
  return JSON.parse(readFileSync(join(DATA, `${slug}.json`), 'utf8'));
}

function factionSlugs(): string[] {
  const manifest = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8')) as {
    factions: Array<{ slug: string }>;
  };
  return manifest.factions.map((f) => f.slug).filter((s) => existsSync(join(DATA, `${s}.json`)));
}

describeWithData('detachments', () => {
  const marines = readDetachments(faction('adeptus-astartes-space-marines').detachments);

  it('extracts a faction\'s detachments with their rules', () => {
    expect(marines.length).toBeGreaterThan(20);
    expect(marines.map((d) => d.name)).toContain('Liberator Assault Group');
    expect(marines.map((d) => d.name)).toContain('Gladius Task Force');
  });

  it('reads the melee buff a detachment actually gives', () => {
    // The whole point: two armies can share Oath of Moment and play nothing
    // alike, because the detachment is where the difference lives.
    const liberator = marines.find((d) => d.name === 'Liberator Assault Group')!;
    const redThirst = liberator.rules.find((r) => /red thirst/i.test(r.name))!;

    expect(redThirst.buff).not.toBeNull();
    expect(redThirst.buff!.modifiers.strengthModifier).toBe(2);
    expect(redThirst.buff!.modifiers.attacksModifier).toBe(1);
    expect(redThirst.buff!.scope).toBe('melee');
  });

  it('gates a charge-dependent rule behind a toggle', () => {
    const liberator = marines.find((d) => d.name === 'Liberator Assault Group')!;
    const redThirst = liberator.rules.find((r) => /red thirst/i.test(r.name))!;
    expect(redThirst.trigger).toBe('charged');

    // Off by default...
    expect(detachmentBuffs(liberator)).toEqual([]);
    // ...and available as something to switch on.
    expect(optionalRules(liberator).map((r) => r.name)).toContain(redThirst.name);
    // ...which then applies.
    expect(detachmentBuffs(liberator, [redThirst.name])).toHaveLength(1);
  });

  it('applies a detachment buff only to the attacks it names', () => {
    const liberator = marines.find((d) => d.name === 'Liberator Assault Group')!;
    const redThirst = liberator.rules.find((r) => /red thirst/i.test(r.name))!;
    const buffs = detachmentBuffs(liberator, [redThirst.name]);

    const melee = resolveBuffs(buffs, [], 'melee');
    expect(melee.modifiers.strengthModifier).toBe(2);

    const ranged = resolveBuffs(buffs, [], 'ranged');
    expect(ranged.modifiers.strengthModifier).toBeUndefined();
  });

  it('distinguishes detachments within the same army rule', () => {
    // Blood Angels and Dark Angels both have Oath of Moment; the detachments
    // are what separate them.
    const liberator = marines.find((d) => d.name === 'Liberator Assault Group')!;
    const gladius = marines.find((d) => d.name === 'Gladius Task Force')!;
    expect(liberator.rules.map((r) => r.name)).not.toEqual(gladius.rules.map((r) => r.name));
  });

  it('never applies a situational detachment rule on its own', () => {
    for (const detachment of marines) {
      for (const buff of detachmentBuffs(detachment)) {
        const rule = detachment.rules.find((r) => r.name === buff.source)!;
        expect(rule.trigger === 'always' || rule.trigger === 'target-keyword').toBe(true);
      }
    }
  });

  it('finds detachments across the roster, not just one faction', () => {
    let total = 0;
    let withBuff = 0;
    for (const slug of factionSlugs()) {
      for (const d of readDetachments(faction(slug).detachments)) {
        total += 1;
        if (d.rules.some((r) => r.buff)) withBuff += 1;
      }
    }
    expect(total).toBeGreaterThan(800);
    // Many detachment rules are about movement or objectives rather than
    // damage, so only a share will parse into a buff.
    expect(withBuff).toBeGreaterThan(100);
  });

  it('covers every faction that has detachments in the source', () => {
    // Detachments are stored three different ways -- a top-level group, a
    // group nested inside a shared entry, or a linked library catalogue -- and
    // reading only one of them silently returned nothing for 29 of 36
    // factions rather than failing. Only Titans (no detachment group exists)
    // and Genestealer Cults (absent from this BSData snapshot) are expected
    // to be empty.
    const expectedEmpty = /titanicus|genestealer/i;
    const empty = factionSlugs().filter(
      (slug) => readDetachments(faction(slug).detachments).length === 0
    );
    expect(empty.filter((slug) => !expectedEmpty.test(slug))).toEqual([]);
  });

  it('reads a granted weapon keyword out of a detachment rule', () => {
    // "Melee weapons equipped by Orks models from your army have the
    // [SUSTAINED HITS 1] ability." BSData wraps that in ** and ^^ emphasis
    // markers; unstripped they split the phrase and nothing parses.
    const orks = readDetachments(faction('orks').detachments);
    const warHorde = orks.find((d) => d.name === 'War Horde')!;
    const getStuckIn = warHorde.rules.find((r) => r.name === 'Get Stuck In')!;

    expect(getStuckIn.text).not.toMatch(/[*^]/);
    expect(getStuckIn.buff?.modifiers.grantSustainedHits).toBe(1);
    expect(getStuckIn.buff?.scope).toBe('melee');
  });

  it('leaves the rulebook glossary out of the detachment', () => {
    // A detachment links the glossary entry for every keyword it mentions, so
    // Dread Mob arrived carrying the definitions of Sustained Hits and Lethal
    // Hits as if they were its own rules.
    for (const slug of factionSlugs()) {
      for (const d of readDetachments(faction(slug).detachments)) {
        for (const rule of d.rules) {
          expect(`${d.name}/${rule.name}`).not.toMatch(
            /\/(sustained hits|lethal hits|devastating wounds|twin-linked|blast|torrent|melta)$/i
          );
        }
      }
    }
  });

  it('names the Craftworlds roster and groups Drukhari beside it', () => {
    // BSData files Craftworlds under the umbrella term "Aeldari", which reads
    // as the parent of Drukhari rather than a sibling. Both share one
    // detachment library in the source, so both list all 24.
    const craftworlds = JSON.parse(
      readFileSync(join(DATA, 'aeldari.json'), 'utf8')
    ) as { name: string; group: string; detachments: RawDetachment[] };
    const drukhari = JSON.parse(
      readFileSync(join(DATA, 'drukhari.json'), 'utf8')
    ) as { name: string; group: string; detachments: RawDetachment[] };

    expect(craftworlds.name).toBe('Craftworlds');
    expect(craftworlds.group).toBe('Aeldari');
    expect(drukhari.name).toBe('Drukhari');
    expect(drukhari.group).toBe('Aeldari');

    // Cross-checked against Wahapedia, which splits the shared Aeldari library
    // 15 / 9. BSData tags neither, but every Drukhari detachment names the
    // DRUKHARI keyword in its rules and no Craftworlds one does, so the split
    // falls out of the data rather than a hardcoded list.
    const cw = craftworlds.detachments.map((d) => d.name);
    const de = drukhari.detachments.map((d) => d.name);

    expect(de).toContain('Kabalite Cartel');
    expect(de).toContain('Skysplinter Assault');
    expect(cw).toContain('Windrider Host');
    expect(cw).toContain('Aspect Host');

    // Neither list may contain the other's.
    expect(cw.filter((n) => de.includes(n))).toEqual([]);
    expect(craftworlds.detachments.length).toBe(15);
    expect(drukhari.detachments.length).toBe(9);
  });

  it('gives a Space Marine chapter the list it actually picks from', () => {
    // Blood Angels hold only their own characters; the detachments live in the
    // Space Marines catalogue they link to.
    const bloodAngels = readDetachments(faction('adeptus-astartes-blood-angels').detachments);
    expect(bloodAngels.map((d) => d.name)).toContain('Liberator Assault Group');
  });

  it('does not hand a faction an ally\'s detachments', () => {
    // Astra Militarum links the Imperial Knights library; a Guard player
    // cannot take a Knights detachment.
    const guard = readDetachments(faction('astra-militarum').detachments).map((d) => d.name);
    const knights = new Set(
      readDetachments(faction('imperial-knights').detachments).map((d) => d.name)
    );
    expect(guard.filter((n) => knights.has(n))).toEqual([]);
  });
});

describeWithData('defensive wording', () => {
  it('does not read a defensive rule as an attack buff', () => {
    // "Each time an attack targets an Adeptus Astartes unit from your army ...
    // subtract 1 from the Wound roll" protects the unit. Parsed as offensive
    // it became a -1 to wound on that unit's own attacks -- the exact opposite
    // of what the detachment does.
    const marines = readDetachments(faction('adeptus-astartes-space-marines').detachments);

    for (const name of ['Wrath of the Rock', 'Vindication Task Force']) {
      const detachment = marines.find((d) => d.name === name)!;
      for (const rule of detachment.rules) {
        expect(`${name}: ${rule.buff?.modifiers.woundModifier ?? 'none'}`).toBe(`${name}: none`);
      }
    }
  });

  it('keeps the offensive half of a rule that does both', () => {
    // Reclamation Force improves AP on melee attacks against objectives AND
    // gives a defensive bonus. Dropping the whole rule would lose the AP.
    const marines = readDetachments(faction('adeptus-astartes-space-marines').detachments);
    const reclamation = marines.find((d) => d.name === 'Reclamation Force')!;
    const oath = reclamation.rules.find((r) => /oath of reclamation/i.test(r.name))!;

    expect(oath.buff?.modifiers.apModifier).toBe(1);
    expect(oath.buff?.modifiers.woundModifier).toBeUndefined();
  });

  it('never turns a defensive rule into a negative attack buff anywhere', () => {
    for (const slug of factionSlugs()) {
      for (const d of readDetachments(faction(slug).detachments)) {
        for (const rule of d.rules) {
          if (!rule.buff) continue;
          if (!/each time an attack (?:is made against|targets)/i.test(rule.text)) continue;
          // A rule with defensive wording may still have an offensive clause,
          // but it must not have produced a penalty to its own rolls.
          const { hitModifier = 0, woundModifier = 0 } = rule.buff.modifiers;
          expect(
            `${d.name}/${rule.name}: hit ${hitModifier}, wound ${woundModifier}`
          ).toBe(`${d.name}/${rule.name}: hit ${Math.max(0, hitModifier)}, wound ${Math.max(0, woundModifier)}`);
        }
      }
    }
  });
});
