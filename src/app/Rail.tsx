/**
 * The detail rail: one matchup, spelled out.
 *
 * The cell shows a percentage because that is what you scan for. This is where
 * the three numbers behind it live — total damage, models killed, and the
 * chance the unit is wiped — plus the arithmetic the percentage came from, so
 * it can be argued with rather than taken on faith.
 */

import type { Attacker, Cell, TargetEntry } from './board';
import { DistributionChart } from './Distribution';

interface Props {
  detail: { attacker: Attacker; target: TargetEntry; cell: Cell };
}

export function Rail({ detail }: Props) {
  const { attacker, target, cell } = detail;

  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="rail-match">
          {attacker.unit.name} <em>into</em> {target.unit.name}
        </div>
        <div className="rail-weapon">{cell.loadout}</div>
      </div>

      <div className="rail-body">
        <div className="hero">
          <span className="big">{cell.efficiency.toFixed(0)}%</span>
          <span className="cap">
            points
            <br />
            efficiency
          </span>
        </div>
        <div className="heronote">
          {Math.round(cell.pointsDestroyed)} pts destroyed ÷ {Math.round(pointsSpent(cell))} pts
          spent
        </div>

        <div className="stats">
          <div className="stat">
            <span className="k">Total damage</span>
            <span className="v">{cell.damage.toFixed(2)}</span>
          </div>
          <div className="stat">
            <span className="k">Models killed</span>
            <span className="v">
              {cell.modelsSlain.toFixed(2)} <small>of {target.target.models}</small>
            </span>
          </div>
          <div className="stat">
            <span className="k">Chance to wipe</span>
            <span className="v">{cell.wipeChance.toFixed(1)}%</span>
          </div>
        </div>

        {cell.modelsSlainDistribution.size ? (
          <DistributionChart
            distribution={cell.modelsSlainDistribution}
            models={target.target.models}
            expected={cell.modelsSlain}
          />
        ) : null}

        {cell.damage > target.target.wounds * target.target.models ? (
          <div className="notice">
            <b>Overkill.</b> The attack throws {cell.damage.toFixed(1)} damage at a unit with{' '}
            {target.target.wounds * target.target.models} wounds. Damage is deliberately uncapped
            here so the waste stays visible.
          </div>
        ) : null}

        {cell.applied.length ? (
          <div className="notice">
            <b>Applied:</b> {cell.applied.join(', ')} — fires against this target.
          </div>
        ) : null}
      </div>
    </aside>
  );
}

/** Recovered from the ratio so the rail never disagrees with the cell. */
function pointsSpent(cell: Cell): number {
  if (!cell.efficiency) return 0;
  return (cell.pointsDestroyed / cell.efficiency) * 100;
}
