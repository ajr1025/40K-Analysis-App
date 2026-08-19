/**
 * The modifier drawer.
 *
 * Grouped the way the game treats them, because the grouping is the rule:
 * roll modifiers cap at a net +/-1 however many you stack, characteristic
 * modifiers do not cap at all, and Benefit of Cover sits outside both because
 * it worsens Ballistic Skill rather than the roll — which is why cover and a
 * -1 to hit combine to an effective -2.
 */

import { type Detachment, optionalRules } from '../engine/detachments';
import type { Modifiers } from '../engine/resolve';
import {
  CONTROL_GROUPS,
  type ModifierControl,
  MODIFIER_CONTROLS,
} from '../data/modifier-controls';

interface Props {
  modifiers: Modifiers;
  onChange: (next: Modifiers) => void;
  detachment: Detachment | null;
}

export function ModifierDrawer({ modifiers, onChange, detachment }: Props) {
  const set = (field: keyof Modifiers, value: unknown) =>
    onChange({ ...modifiers, [field]: value } as Modifiers);

  return (
    <div className="drawer">
      <div className="mgrid">
        {CONTROL_GROUPS.map((group) => {
          const controls = MODIFIER_CONTROLS.filter((c) => c.group === group.id);
          if (!controls.length) return null;
          return (
            <div className="mgroup" key={group.id}>
              <div className="gt">{group.label}</div>
              {group.note ? <div className="gn">{group.note}</div> : null}
              {controls.map((control) => (
                <Control
                  key={control.field}
                  control={control}
                  value={modifiers[control.field as keyof Modifiers]}
                  onChange={(value) => set(control.field as keyof Modifiers, value)}
                />
              ))}
            </div>
          );
        })}

        <div className="mgroup">
          <div className="gt">Detachment rules</div>
          <div className="gn">
            {detachment
              ? `${detachment.name}. Conditional rules stay off until you switch them on beneath the unit.`
              : 'No detachment selected — nothing added.'}
          </div>
          {optionalRules(detachment).map((rule) => (
            <div className="mrow" key={rule.name}>
              <span>
                {rule.name}
                <small>
                  {rule.buff?.summary}
                  {rule.buff && rule.buff.scope !== 'all' ? ` · ${rule.buff.scope}` : ''}
                </small>
              </span>
              <span className="mval off">{rule.condition ? `needs ${rule.condition}` : 'Off'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface ControlProps {
  control: ModifierControl;
  value: unknown;
  onChange: (value: unknown) => void;
}

function Control({ control, value, onChange }: ControlProps) {
  if (control.kind === 'toggle') {
    const on = value === true;
    return (
      <div className="mrow">
        <span>{control.label}</span>
        <button
          type="button"
          className={`mval ${on ? 'on' : 'off'}`}
          onClick={() => onChange(!on)}
          title={control.hint}
        >
          {on ? 'On' : 'Off'}
        </button>
      </div>
    );
  }

  if (control.kind === 'choice') {
    const current = (value as string | null) ?? control.options[0]?.value ?? '';
    return (
      <div className="mrow">
        <span>{control.label}</span>
        <select
          value={String(current)}
          onChange={(e) => onChange(e.target.value === 'none' ? undefined : e.target.value)}
        >
          {control.options.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  const current = typeof value === 'number' ? value : 0;
  const clamp = (n: number) => Math.max(control.min, Math.min(control.max, n));

  return (
    <div className="mrow">
      <span>{control.label}</span>
      <span className={`mval ${current === 0 ? 'off' : 'on'}`}>
        {current > 0 ? `+${current}` : current}
        <span className="stepper">
          <b role="button" tabIndex={0} onClick={() => onChange(clamp(current - 1))}>
            −
          </b>
          <b role="button" tabIndex={0} onClick={() => onChange(clamp(current + 1))}>
            +
          </b>
        </span>
      </span>
    </div>
  );
}
