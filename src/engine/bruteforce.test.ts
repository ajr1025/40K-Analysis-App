/**
 * Full cross-product sweep: every unit's every weapon against every unit.
 *
 * Roughly 1683 x 1683 matchups. Raw numbers on their own prove nothing, so
 * this checks *invariants* that must hold for every pair -- a violation is a
 * real bug -- and surfaces outliers, which in practice means bad upstream data
 * rather than a good unit. The Ork Boyz wounds bug looked exactly like an
 * outlier before anyone noticed it was wrong.
 *
 * Identical profiles are computed once and reused. That is not a shortcut in
 * coverage: two weapons with the same characteristics against two targets with
 * the same profile provably produce the same result, so memoising by profile
 * covers the entire cross-product exactly.
 *
 *   npx vitest run src/engine/bruteforce.test.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type DataUnit, toTarget, toWeapon } from './adapt';
import { type Result, type Target, type Weapon, resolveAttack } from './resolve';

const DATA = join(process.cwd(), 'public', 'data');
const hasData = existsSync(join(DATA, 'index.json'));
const describeWithData = hasData ? describe : describe.skip;

function loadAll(): Array<DataUnit & { faction: string }> {
  const manifest = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8')) as {
    factions: Array<{ slug: string }>;
  };
  const out: Array<DataUnit & { faction: string }> = [];
  for (const { slug } of manifest.factions) {
    const path = join(DATA, `${slug}.json`);
    if (!existsSync(path)) continue;
    const d = JSON.parse(readFileSync(path, 'utf8'));
    for (const u of d.units) out.push({ ...u, faction: d.name });
  }
  return out;
}

/** Identity of a weapon for memoisation: everything the maths reads. */
function weaponKey(w: Weapon): string {
  return [
    w.attacks, w.skill, w.strength, w.ap, w.damage,
    w.sustainedHits ?? 0, w.lethalHits ? 1 : 0, w.devastatingWounds ? 1 : 0,
    w.torrent ? 1 : 0, w.twinLinked ? 1 : 0, w.critWoundOn ?? 6,
    w.blast ?? 0, w.rapidFire ?? 0, w.melta ?? 0, w.lance ? 1 : 0,
    w.melee ? 1 : 0, w.ignoresCover ? 1 : 0,
    (w.anti ?? []).map((a) => `${a.keyword}:${a.critOn}`).sort().join(','),
  ].join('|');
}

/** Identity of a target: the profile plus the keywords Anti-X can match. */
function targetKey(t: Target): string {
  return [
    t.toughness, t.save, t.invulnerable ?? 0, t.wounds, t.models,
    t.feelNoPain ?? 0, t.damageReduction ?? 0,
    (t.keywords ?? []).map((k) => k.toLowerCase()).sort().join(','),
  ].join('|');
}

describeWithData('full cross-product sweep', () => {
  it(
    'holds every invariant across every matchup',
    () => {
      const started = Date.now();
      const units = loadAll();

      // Resolve each unit once into its engine forms.
      const attackers: Array<{ unit: string; faction: string; points: number | null; weapons: Weapon[] }> = [];
      const targets: Array<{ unit: string; points: number | null; target: Target }> = [];

      for (const unit of units) {
        const weapons = unit.weapons.map(toWeapon).filter((w): w is Weapon => w !== null);
        if (weapons.length) {
          attackers.push({ unit: unit.name, faction: unit.faction, points: unit.basePoints, weapons });
        }
        const target = toTarget(unit);
        if (target) targets.push({ unit: unit.name, points: unit.basePoints, target });
      }

      const totalWeapons = attackers.reduce((n, a) => n + a.weapons.length, 0);
      console.log(
        `\n${attackers.length} attackers (${totalWeapons} weapon profiles) x ${targets.length} targets` +
          `\n= ${(attackers.length * targets.length).toLocaleString()} unit matchups, ` +
          `${(totalWeapons * targets.length).toLocaleString()} weapon resolutions\n`
      );

      // Pre-key the targets once; they are reused for every attacker.
      const keyedTargets = targets.map((t) => ({ ...t, key: targetKey(t.target) }));

      const cache = new Map<string, Result | null>();
      const violations: string[] = [];
      const outliers: Array<{ eff: number; line: string }> = [];
      const slow: string[] = [];

      let resolutions = 0;
      let cacheHits = 0;
      let nullResults = 0;
      let done = 0;

      for (const attacker of attackers) {
        const keyedWeapons = attacker.weapons.map((w) => ({ weapon: w, key: weaponKey(w) }));

        for (const t of keyedTargets) {
          for (const { weapon, key } of keyedWeapons) {
            const cacheKey = key + '#' + t.key;
            let result = cache.get(cacheKey);

            if (result === undefined) {
              const t0 = performance.now();
              result = resolveAttack(weapon, t.target);
              const ms = performance.now() - t0;
              resolutions += 1;
              cache.set(cacheKey, result);
              if (ms > 60) {
                slow.push(`${ms.toFixed(0)}ms  ${attacker.unit} / ${weapon.name} -> ${t.unit}`);
              }
            } else {
              cacheHits += 1;
            }

            if (result === null) {
              nullResults += 1;
              continue;
            }

            const where = `${attacker.unit} / ${weapon.name} -> ${t.unit}`;
            const pool = t.target.models * t.target.wounds;

            // --- invariants -------------------------------------------------
            if (!Number.isFinite(result.totalDamage)) violations.push(`non-finite damage: ${where}`);
            if (result.totalDamage < 0) violations.push(`negative damage: ${where}`);
            if (result.woundsRemoved < -1e-9) violations.push(`negative wounds removed: ${where}`);
            if (result.woundsRemoved > pool + 1e-6) {
              violations.push(`wounds removed ${result.woundsRemoved.toFixed(3)} > pool ${pool}: ${where}`);
            }
            if (result.expectedModelsSlain > t.target.models + 1e-6) {
              violations.push(`models slain > unit size: ${where}`);
            }
            if (result.totalDamage < result.woundsRemoved - 1e-6) {
              violations.push(`damage thrown < wounds removed: ${where}`);
            }
            if (result.probabilityDestroyed < -1e-9 || result.probabilityDestroyed > 1 + 1e-9) {
              violations.push(`wipe probability out of range: ${where}`);
            }
            if (result.fractionDestroyed > 1 + 1e-6) violations.push(`fraction > 1: ${where}`);

            // --- efficiency outliers ---------------------------------------
            if (attacker.points && t.points) {
              const eff = (result.expectedModelsSlain / t.target.models) * t.points / attacker.points;
              if (eff > 3) {
                outliers.push({
                  eff,
                  line: `${(eff * 100).toFixed(0).padStart(5)}%  ${where} (${attacker.points}pts vs ${t.points}pts)`,
                });
              }
            }
          }
        }

        done += 1;
        if (done % 200 === 0) {
          const secs = (Date.now() - started) / 1000;
          console.log(
            `  ${done}/${attackers.length} attackers · ${resolutions.toLocaleString()} resolved · ` +
              `${cacheHits.toLocaleString()} cached · ${secs.toFixed(0)}s`
          );
        }
      }

      const secs = (Date.now() - started) / 1000;
      const totalPairs = resolutions + cacheHits;

      console.log(
        `\ndone in ${secs.toFixed(0)}s` +
          `\n  ${totalPairs.toLocaleString()} weapon-vs-target pairs evaluated` +
          `\n  ${resolutions.toLocaleString()} unique profile combinations computed` +
          `\n  ${cacheHits.toLocaleString()} reused (identical profiles)` +
          `\n  ${nullResults.toLocaleString()} unmodellable (returned null, not a wrong number)` +
          `\n  ${violations.length} invariant violations` +
          `\n  ${outliers.length} efficiency outliers over 300%` +
          `\n  ${slow.length} resolutions slower than 60ms\n`
      );

      outliers.sort((a, b) => b.eff - a.eff);
      if (outliers.length) {
        console.log('top efficiency outliers (check these for bad data):');
        for (const o of outliers.slice(0, 25)) console.log('   ' + o.line);
      }
      if (slow.length) {
        console.log('\nslowest resolutions:');
        for (const s of slow.slice(0, 10)) console.log('   ' + s);
      }
      if (violations.length) {
        console.log('\nVIOLATIONS:');
        for (const v of violations.slice(0, 40)) console.log('   ' + v);
      }

      writeFileSync(
        join(process.cwd(), '.cache', 'bruteforce-report.txt'),
        [
          `pairs: ${totalPairs}`,
          `unique: ${resolutions}`,
          `null: ${nullResults}`,
          `violations: ${violations.length}`,
          '',
          ...violations.slice(0, 500),
          '',
          'OUTLIERS',
          ...outliers.slice(0, 200).map((o) => o.line),
        ].join('\n'),
        'utf8'
      );

      expect(violations).toEqual([]);
    },
    30 * 60 * 1000
  );
});
