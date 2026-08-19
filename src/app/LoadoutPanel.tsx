/**
 * What a unit is carrying, and what that costs.
 *
 * Built the way the datasheet is: counts of model variants, each with its
 * choice slots. Counting weapon profiles instead would let a squad hold more
 * fists than it has hands, and it is model variants that carry the legality
 * rules — including the caps that open up as the squad grows, which is how a
 * ten-model Terminator Squad reaches two cyclone missile launchers.
 */

import type { DataUnit } from '../engine/adapt';
import type { Detachment } from '../engine/detachments';
import {
  type Loadout,
  type WargearVariant,
  effectiveMax,
  loadoutEntries,
  loadoutSize,
  validateLoadout,
  variantsOf,
} from '../engine/wargear';
import { optionalRules } from '../engine/detachments';
import { type Attacker, attackerContext, unitBuffs } from './board';

interface Props {
  attacker: Attacker;
  detachment: Detachment | null;
  leaders: DataUnit[];
  onChange: (next: Attacker) => void;
}

export function LoadoutPanel({ attacker, detachment, leaders, onChange }: Props) {
  const variants = variantsOf(attacker.unit);
  const size = loadoutSize(attacker.loadout);
  const problems = validateLoadout(attacker.unit, attacker.loadout);
  const context = attackerContext(attacker, detachment, 'all');
  const { optional } = unitBuffs(attacker);
  const detachmentRules = optionalRules(detachment);

  const setCount = (variant: string, count: number) => {
    onChange({
      ...attacker,
      loadout: withCount(attacker.loadout, variant, Math.max(0, count)),
    });
  };

  const setChoice = (variant: string, slot: string, option: string) => {
    onChange({
      ...attacker,
      loadout: {
        selections: attacker.loadout.selections.map((s) =>
          s.variant === variant ? { ...s, choices: { ...s.choices, [slot]: option } } : s
        ),
      },
    });
  };

  const toggle = (name: string) => {
    const enabled = attacker.enabled.includes(name)
      ? attacker.enabled.filter((n) => n !== name)
      : [...attacker.enabled, name];
    onChange({ ...attacker, enabled });
  };

  return (
    <>
      <div className="lmeta">
        {context.points} pts · {context.models} {context.models === 1 ? 'model' : 'models'}
      </div>

      <div className="builder">
        {variants.map((variant) => (
          <VariantRow
            key={variant.name}
            variant={variant}
            count={countOf(attacker.loadout, variant.name)}
            choices={choicesOf(attacker.loadout, variant.name)}
            squadSize={size}
            onCount={(n) => setCount(variant.name, n)}
            onChoice={(slot, option) => setChoice(variant.name, slot, option)}
          />
        ))}
        <div className={`assigned${problems.length ? ' over' : ''}`}>
          {size} {size === 1 ? 'model' : 'models'}
          {problems.length ? ` — ${problems[0].message}` : ''}
        </div>
      </div>

      <WeaponTable attacker={attacker} />

      {leaders.length ? (
        <div className="leadrow">
          <span className="label">Leader</span>
          <select
            value={attacker.leader?.name ?? ''}
            onChange={(e) => {
              const found = leaders.find((l) => l.name === e.target.value) ?? null;
              onChange({ ...attacker, leader: found });
            }}
          >
            <option value="">None</option>
            {leaders.map((leader) => (
              <option key={leader.name} value={leader.name}>
                {leader.name}
                {leader.basePoints != null ? ` (${leader.basePoints})` : ''}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {optional.length || detachmentRules.length ? (
        <div className="chiprow">
          {optional.map((buff) => (
            <button
              key={buff.source}
              type="button"
              className="buffchip"
              aria-pressed={attacker.enabled.includes(buff.source)}
              title={buff.summary}
              onClick={() => toggle(buff.source)}
            >
              {buff.source}
              {buff.scope !== 'all' ? <span className="scopebadge">{buff.scope}</span> : null}
            </button>
          ))}
          {detachmentRules.map((rule) => (
            <button
              key={rule.name}
              type="button"
              className="buffchip"
              aria-pressed={attacker.enabled.includes(rule.name)}
              title={rule.condition ? `Requires: ${rule.condition}` : (rule.buff?.summary ?? rule.name)}
              onClick={() => toggle(rule.name)}
            >
              {rule.name}
              <span className="scopebadge">detachment</span>
            </button>
          ))}
        </div>
      ) : null}

      <Caveats attacker={attacker} />
    </>
  );
}

interface VariantProps {
  variant: WargearVariant;
  count: number;
  choices: Record<string, string>;
  squadSize: number;
  onCount: (n: number) => void;
  onChoice: (slot: string, option: string) => void;
}

function VariantRow({ variant, count, choices, squadSize, onCount, onChoice }: VariantProps) {
  // The cap is read at the size the squad would be after the change, so the
  // stepper opens up as you grow the unit rather than a step behind it.
  const cap = effectiveMax(variant, Math.max(squadSize, squadSize + 1));
  const scales = (variant.maxRules ?? []).length > 0;

  return (
    <div className={`brow${count === 0 ? ' zero' : ''}`}>
      <span className="qty">
        <button type="button" aria-label={`Fewer ${variant.name}`} disabled={count <= 0} onClick={() => onCount(count - 1)}>
          −
        </button>
        <span className="n">{count}</span>
        <button
          type="button"
          aria-label={`More ${variant.name}`}
          disabled={cap != null && count >= cap}
          onClick={() => onCount(count + 1)}
        >
          +
        </button>
      </span>
      <span className="bname">
        {variant.name}
        <small>
          {variant.min}–{cap ?? '∞'}
          {scales ? <em className="scales"> scales with squad size</em> : null} ·{' '}
          {variant.fixed.join(', ') || 'choice only'}
        </small>
      </span>
      {variant.choices.length ? (
        <span className="bpicks">
          {variant.choices.map((choice) => (
            <label key={choice.name} className="bpick">
              <span>{choice.name}</span>
              <select
                disabled={count === 0}
                value={choices[choice.name] ?? choice.options[0]}
                onChange={(e) => onChoice(choice.name, e.target.value)}
              >
                {choice.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </span>
      ) : null}
    </div>
  );
}

/** Stats for the weapons the current build is actually holding. */
function WeaponTable({ attacker }: { attacker: Attacker }) {
  const carried = new Map<string, number>();
  for (const entry of loadoutEntries(attacker.unit, attacker.loadout)) {
    carried.set(entry.weapon.name, (carried.get(entry.weapon.name) ?? 0) + entry.models);
  }

  const rows = (attacker.unit.weapons ?? []).filter(
    (w) => carried.has(w.name) || carried.has(baseName(w.name))
  );

  return (
    <table className="wtable">
      <thead>
        <tr>
          <th>Models</th>
          <th>Weapon</th>
          <th>Rng</th>
          <th>A</th>
          <th>Sk</th>
          <th>S</th>
          <th>AP</th>
          <th>D</th>
          <th>Keywords</th>
        </tr>
      </thead>
      <tbody>
        {rows.length ? (
          rows.map((w) => (
            <tr key={w.name}>
              <td>
                <span className="mcount">{carried.get(w.name) ?? carried.get(baseName(w.name))}</span>
              </td>
              <td>
                {w.kind === 'melee' ? '⚔ ' : ''}
                {w.name}
              </td>
              <td>{w.range ?? (w.kind === 'melee' ? 'Melee' : '—')}</td>
              <td>{w.attacks ?? '—'}</td>
              <td>{w.skill ?? 'N/A'}</td>
              <td>{w.strength ?? '—'}</td>
              <td>{w.ap ?? '0'}</td>
              <td>{w.damage ?? '—'}</td>
              <td className="kw">{(w.keywords ?? []).join(', ') || '—'}</td>
            </tr>
          ))
        ) : (
          <tr>
            <td colSpan={9} className="kw">
              No models assigned.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** What the number cannot tell you about itself. */
function Caveats({ attacker }: { attacker: Attacker }) {
  const context = attackerContext(attacker, null, 'all');
  const notes: string[] = [];

  if (attacker.unit.basePoints == null) {
    notes.push('No points in the Munitorum Field Manual, so efficiency cannot be computed.');
  }
  if (context.assumedLoadout) {
    notes.push(
      'The source records no weapon options for this datasheet, so it is fielding everything it lists — an overestimate. Take the extras off above.'
    );
  }
  if (context.unmodelled.length) {
    notes.push(`Not modelled: ${context.unmodelled.join(', ')}. The number is incomplete.`);
  }
  if (!notes.length) return null;

  return (
    <div className="caveats">
      {notes.map((note) => (
        <div key={note}>{note}</div>
      ))}
    </div>
  );
}

function baseName(name: string): string {
  return name.replace(/\s+-\s+[^-]*$/, '').trim();
}

function countOf(loadout: Loadout, variant: string): number {
  return loadout.selections.find((s) => s.variant === variant)?.count ?? 0;
}

function choicesOf(loadout: Loadout, variant: string): Record<string, string> {
  return loadout.selections.find((s) => s.variant === variant)?.choices ?? {};
}

function withCount(loadout: Loadout, variant: string, count: number): Loadout {
  const known = loadout.selections.some((s) => s.variant === variant);
  return {
    selections: known
      ? loadout.selections.map((s) => (s.variant === variant ? { ...s, count } : s))
      : [...loadout.selections, { variant, count, choices: {} }],
  };
}
