/**
 * Exact discrete probability distributions for datasheet dice expressions.
 *
 * Everything downstream is computed exactly rather than simulated, so the same
 * matchup always produces the same number and there is no sampling noise to
 * explain away. Distributions are kept as plain maps from outcome to
 * probability; they stay tiny (a D6+3 has seven entries) so the naive
 * convolutions below are comfortably fast enough.
 */

export type Distribution = Map<number, number>;

/** A distribution with all its mass on one value. */
export function constant(value: number): Distribution {
  return new Map([[value, 1]]);
}

/** A fair dN. */
export function die(sides: number): Distribution {
  const dist: Distribution = new Map();
  for (let face = 1; face <= sides; face += 1) dist.set(face, 1 / sides);
  return dist;
}

/** Shift every outcome by a constant. */
export function offset(dist: Distribution, by: number): Distribution {
  const out: Distribution = new Map();
  for (const [value, p] of dist) out.set(value + by, p);
  return out;
}

/** Distribution of the sum of two independent variables. */
export function add(a: Distribution, b: Distribution): Distribution {
  const out: Distribution = new Map();
  for (const [va, pa] of a) {
    for (const [vb, pb] of b) {
      const v = va + vb;
      out.set(v, (out.get(v) ?? 0) + pa * pb);
    }
  }
  return out;
}

/** Distribution of the sum of `n` independent draws from `dist`. */
export function repeat(dist: Distribution, n: number): Distribution {
  let out = constant(0);
  for (let i = 0; i < n; i += 1) out = add(out, dist);
  return out;
}

/** Mix distributions according to a weighting: sum(weight_i * dist_i). */
export function mix(parts: Array<{ weight: number; dist: Distribution }>): Distribution {
  const out: Distribution = new Map();
  for (const { weight, dist } of parts) {
    if (weight === 0) continue;
    for (const [value, p] of dist) out.set(value, (out.get(value) ?? 0) + weight * p);
  }
  return out;
}

export function expected(dist: Distribution): number {
  let total = 0;
  for (const [value, p] of dist) total += value * p;
  return total;
}

/** Apply a function to each outcome, merging any collisions. */
export function mapValues(dist: Distribution, fn: (value: number) => number): Distribution {
  const out: Distribution = new Map();
  for (const [value, p] of dist) {
    const v = fn(value);
    out.set(v, (out.get(v) ?? 0) + p);
  }
  return out;
}

const EXPRESSION = /^\s*(\d*)\s*[dD]\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/;
const FLAT = /^\s*(\d+)\s*$/;

/**
 * Parse a datasheet characteristic into a distribution.
 *
 * Handles "4", "D6", "2D3", "D6+2", "3D6-1". Datasheets also use "*" for
 * profile-dependent values and "N/A" where a characteristic does not apply --
 * both are unresolvable here, so the caller gets null and can surface the
 * weapon as unmodellable instead of silently scoring it as zero.
 */
export function parseDice(text: string | null | undefined): Distribution | null {
  if (text == null) return null;
  const raw = String(text).trim();
  if (raw === '' || raw === '-' || raw === '*' || /n\/?a/i.test(raw)) return null;

  const flat = FLAT.exec(raw);
  if (flat) return constant(Number(flat[1]));

  const match = EXPRESSION.exec(raw);
  if (!match) return null;

  const [, countText, sidesText, sign, modifierText] = match;
  const count = countText === '' ? 1 : Number(countText);
  const sides = Number(sidesText);
  if (count < 1 || count > 20 || sides < 2 || sides > 100) return null;

  let dist = repeat(die(sides), count);
  if (sign && modifierText) {
    dist = offset(dist, sign === '-' ? -Number(modifierText) : Number(modifierText));
  }
  // A damage or attacks characteristic can never resolve below zero.
  return mapValues(dist, (v) => Math.max(0, v));
}
