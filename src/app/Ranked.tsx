/**
 * The phone view.
 *
 * A grid of twenty columns does not survive a 375px screen, and two of the
 * three people using this only ever open it on a phone. So on a narrow screen
 * the matrix becomes what you would actually ask it there: one attacker at a
 * time, every target ranked best-first.
 *
 * The same cells, from the same engine — this is a different arrangement of
 * the answer, not a different answer.
 */

import { useMemo } from 'react';

import type { Detachment } from '../engine/detachments';
import type { Modifiers } from '../engine/resolve';
import {
  type Attacker,
  type TargetEntry,
  type WeaponScope,
  attackerContext,
  computeCell,
} from './board';
import { formatEfficiency, tint } from './theme';

interface Props {
  attackers: Attacker[];
  targets: TargetEntry[];
  modifiers: Modifiers;
  scope: WeaponScope;
  detachment: Detachment | null;
  active: number;
  onPick: (index: number) => void;
  onRemove: (id: string) => void;
}

export function Ranked({
  attackers,
  targets,
  modifiers,
  scope,
  detachment,
  active,
  onPick,
  onRemove,
}: Props) {
  const attacker = attackers[Math.min(active, attackers.length - 1)];

  const ranked = useMemo(() => {
    if (!attacker) return [];
    const context = attackerContext(attacker, detachment, scope);
    return targets
      .map((target) => ({ target, cell: computeCell(context, target, modifiers) }))
      .sort((a, b) => b.cell.efficiency - a.cell.efficiency);
  }, [attacker, targets, modifiers, scope, detachment]);

  if (!attacker) return null;

  return (
    <div className="ranked">
      <div className="phone-top">
        <select
          aria-label="Attacker"
          value={attacker.id}
          onChange={(e) => onPick(attackers.findIndex((a) => a.id === e.target.value))}
        >
          {attackers.map((a) => (
            <option key={a.id} value={a.id}>
              {a.unit.name}
              {a.leader ? ` + ${a.leader.name}` : ''}
            </option>
          ))}
        </select>
        <button type="button" className="rm" aria-label={`Remove ${attacker.unit.name}`} onClick={() => onRemove(attacker.id)}>
          ×
        </button>
      </div>

      <div className="phone-attacker">
        {attacker.unit.name}
        <small>{attackerContext(attacker, detachment, scope).label}</small>
      </div>

      {ranked.map(({ target, cell }) => (
        <div key={target.id} className="mcard" style={{ background: tint(cell.efficiency) }}>
          <div>
            <div className="t">{target.unit.name}</div>
            <div className="s">
              {cell.damage.toFixed(1)} dmg · {cell.modelsSlain.toFixed(1)} dead ·{' '}
              {cell.wipeChance.toFixed(0)}% wipe
            </div>
          </div>
          <div className="e">{formatEfficiency(cell.efficiency)}</div>
        </div>
      ))}

      {ranked.length === 0 ? (
        <p className="s">Add a target to score this unit against.</p>
      ) : null}
    </div>
  );
}
