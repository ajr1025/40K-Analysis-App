/**
 * The matrix.
 *
 * Rows are attackers, columns are targets, and every cell is computed live
 * from the engine — changing a loadout or a modifier re-runs the maths rather
 * than looking up a stored answer.
 *
 * Cells are recomputed per row via `useMemo` keyed on that row's context, so
 * editing one unit's wargear does not re-resolve the whole board.
 */

import { Fragment, useMemo } from 'react';

import type { ConditionalBuff } from '../engine/conditions';
import type { Detachment } from '../engine/detachments';
import type { Modifiers } from '../engine/resolve';
import {
  type Attacker,
  type Cell,
  type TargetEntry,
  type WeaponScope,
  attackerContext,
  computeCell,
} from './board';
import { formatEfficiency, ink, tint } from './theme';

interface Props {
  attackers: Attacker[];
  targets: TargetEntry[];
  modifiers: Modifiers;
  scope: WeaponScope;
  detachment: Detachment | null;
  armyRule: ConditionalBuff | null;
  visible: (target: TargetEntry) => boolean;
  selected: { row: number; col: number } | null;
  onSelect: (row: number, col: number) => void;
  onRemove: (id: string) => void;
  expanded: string | null;
  onToggleExpand: (id: string) => void;
  renderPanel: (attacker: Attacker, index: number) => React.ReactNode;
}

export function Matrix({
  attackers,
  targets,
  modifiers,
  scope,
  detachment,
  armyRule,
  visible,
  selected,
  onSelect,
  onRemove,
  expanded,
  onToggleExpand,
  renderPanel,
}: Props) {
  const shown = targets.filter(visible);

  return (
    <div className="matrix-shell">
      <table id="matrix">
        <thead>
          <tr>
            <th className="rowhead">
              <span className="label">Attacker / Target</span>
            </th>
            {shown.map((target) => (
              <th key={target.id}>
                <span className="thead-name">{target.unit.name}</span>
                <span className="thead-stat">{target.points} pts</span>
              </th>
            ))}
            <th>
              <span className="thead-name">Avg</span>
            </th>
            <th>
              <span className="thead-name">Best vs</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {attackers.map((attacker, row) => (
            <Row
              key={attacker.id}
              attacker={attacker}
              row={row}
              targets={shown}
              modifiers={modifiers}
              scope={scope}
              detachment={detachment}
              armyRule={armyRule}
              selected={selected}
              onSelect={onSelect}
              onRemove={onRemove}
              expanded={expanded === attacker.id}
              onToggleExpand={() => onToggleExpand(attacker.id)}
              panel={renderPanel(attacker, row)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface RowProps {
  attacker: Attacker;
  row: number;
  targets: TargetEntry[];
  modifiers: Modifiers;
  scope: WeaponScope;
  detachment: Detachment | null;
  armyRule: ConditionalBuff | null;
  selected: { row: number; col: number } | null;
  onSelect: (row: number, col: number) => void;
  onRemove: (id: string) => void;
  expanded: boolean;
  onToggleExpand: () => void;
  panel: React.ReactNode;
}

function Row({
  attacker,
  row,
  targets,
  modifiers,
  scope,
  detachment,
  armyRule,
  selected,
  onSelect,
  onRemove,
  expanded,
  onToggleExpand,
  panel,
}: RowProps) {
  const cells = useMemo(() => {
    const context = attackerContext(attacker, detachment, scope, armyRule);
    return targets.map((target) => computeCell(context, target, modifiers));
  }, [attacker, targets, modifiers, scope, detachment, armyRule]);

  const average = cells.length
    ? cells.reduce((sum, c) => sum + c.efficiency, 0) / cells.length
    : 0;
  const best = cells.reduce(
    (bestSoFar, cell, i) => (cell.efficiency > (cells[bestSoFar]?.efficiency ?? -1) ? i : bestSoFar),
    0
  );

  const span = targets.length + 3;

  return (
    <Fragment>
      <tr>
      <th className="rowhead">
        <div className="rowtop">
          <button
            type="button"
            className="disc"
            aria-expanded={expanded}
            aria-label={`Loadout for ${attacker.unit.name}`}
            onClick={onToggleExpand}
          >
            {expanded ? '▾' : '▸'}
          </button>
          <span className="rname">
            {attacker.unit.name}
            {attacker.leader ? <em> + {attacker.leader.name}</em> : null}
          </span>
          <button
            type="button"
            className="rm"
            aria-label={`Remove ${attacker.unit.name}`}
            onClick={() => onRemove(attacker.id)}
          >
            ×
          </button>
        </div>
      </th>

      {cells.map((cell, col) => (
        <td key={targets[col].id}>
          <button
            type="button"
            className={`cell${cell.efficiency < 1 ? ' nil' : ''}`}
            aria-selected={selected?.row === row && selected?.col === col}
            onClick={() => onSelect(row, col)}
          >
            <span className="fill" style={{ background: tint(cell.efficiency) }} />
            <span className="num" style={{ color: ink(cell.efficiency) }}>
              {formatEfficiency(cell.efficiency)}
              {cell.applied.length ? (
                <span className="fired" title={`Applies here: ${cell.applied.join(', ')}`}>
                  ◆
                </span>
              ) : null}
            </span>
          </button>
        </td>
      ))}

      <td className="summary">
        <span className="cell">
          <span className="num">{average.toFixed(0)}%</span>
        </span>
      </td>
      <td className="summary">
        <span className="best">{targets[best]?.unit.name ?? '—'}</span>
      </td>
      </tr>

      {/*
        The panel gets its own full-width row rather than living inside the
        first cell. Inside it, expanding the wargear widened the sticky column
        and squeezed every target out of view.
      */}
      {expanded ? (
        <tr className="panelrow">
          <td colSpan={span}>
            <div className="loadout">{panel}</div>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

/** The one cell the detail rail is describing. */
export function cellFor(
  attacker: Attacker,
  target: TargetEntry,
  modifiers: Modifiers,
  scope: WeaponScope,
  detachment: Detachment | null,
  armyRule: ConditionalBuff | null
): Cell {
  return computeCell(attackerContext(attacker, detachment, scope, armyRule), target, modifiers);
}
