/**
 * The efficiency ramp.
 *
 * Red to green is hard for protanopes to separate in the middle, so the
 * percentage is always printed on top and stays the authoritative read —
 * colour is the fast scan, not the answer. The anchors are mid-dark so bone
 * ink stays legible on every step and never has to flip to black.
 */

const STOPS: Array<[number, [number, number, number]]> = [
  [0, [179, 38, 30]],
  [20, [212, 85, 47]],
  [45, [224, 160, 46]],
  [70, [124, 160, 58]],
  [100, [31, 122, 77]],
];

function anchor(efficiency: number): [number, number, number] {
  const value = Math.max(0, Math.min(100, efficiency));
  for (let i = 1; i < STOPS.length; i += 1) {
    if (value <= STOPS[i][0]) {
      const [low, from] = STOPS[i - 1];
      const [high, to] = STOPS[i];
      const k = (value - low) / (high - low);
      return from.map((c, j) => Math.round(c + (to[j] - c) * k)) as [number, number, number];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

/** Laid over graphite with enough opacity to carry colour, well short of neon. */
export function tint(efficiency: number): string {
  const [r, g, b] = anchor(efficiency);
  const strength = 0.34 + 0.36 * Math.min(1, Math.max(0, efficiency) / 100);
  return `rgba(${r},${g},${b},${strength.toFixed(3)})`;
}

export function ink(efficiency: number): string {
  return efficiency < 1 ? 'var(--ink-3)' : 'var(--ink)';
}

export function formatEfficiency(efficiency: number): string {
  return efficiency < 1 ? '—' : `${efficiency.toFixed(0)}%`;
}
