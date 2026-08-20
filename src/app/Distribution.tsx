/**
 * How many models actually die.
 *
 * The average is one number off a distribution, and the distribution is often
 * the more useful half: "3.4 models" reads the same whether the attack
 * reliably kills three or is a coin flip between one and six. The engine
 * resolves this exactly rather than by simulation, so these are true
 * probabilities, not sample counts.
 *
 * Models slain rather than raw damage, because damage does not spill between
 * models — 11 damage into a ten-wound unit is not eleven wounds' worth of
 * dead, and it is bodies removed that decides the game.
 *
 * Two series on ONE axis. Both are probabilities, so a second y-scale would be
 * decoration rather than information — and a dual axis lets you imply any
 * relationship you like by choosing where to crop it.
 */

import type { Distribution as Dist } from '../engine/dice';

/** Discrete bars: the chance of exactly this many. */
const EXACTLY = '#b8852a';
/** Cumulative line: the chance of this many or more. */
const AT_LEAST = '#4f9bd0';

interface Props {
  distribution: Dist;
  /** Total models in the target unit, so the axis covers a wipe. */
  models: number;
  expected: number;
}

export function DistributionChart({ distribution, models, expected }: Props) {
  const max = Math.max(models, ...[...distribution.keys()]);
  const points = Array.from({ length: max + 1 }, (_, slain) => ({
    slain,
    exactly: distribution.get(slain) ?? 0,
  }));

  // "At least N" reads the way the decision does: will this finish the unit?
  let running = 1;
  const cumulative = points.map((point) => {
    const value = running;
    running -= point.exactly;
    return { slain: point.slain, atLeast: Math.max(0, value) };
  });

  const width = 268;
  const height = 132;
  const padLeft = 30;
  const padBottom = 22;
  const padTop = 8;
  const plotWidth = width - padLeft - 6;
  const plotHeight = height - padBottom - padTop;

  const step = plotWidth / (max + 1);
  // A 2px surface gap between adjacent bars, per the mark spec.
  const barWidth = Math.max(3, Math.min(18, step - 2));
  const x = (slain: number) => padLeft + step * slain + step / 2;
  const y = (p: number) => padTop + plotHeight * (1 - p);

  const line = cumulative
    .map((c, i) => `${i === 0 ? 'M' : 'L'}${x(c.slain).toFixed(1)},${y(c.atLeast).toFixed(1)}`)
    .join(' ');

  // Label only the bars worth reading, never every one.
  const peak = points.reduce((best, p) => (p.exactly > best.exactly ? p : best), points[0]);

  return (
    <figure className="dist">
      <figcaption>
        Models slain — <span style={{ color: EXACTLY }}>exactly</span> and{' '}
        <span style={{ color: AT_LEAST }}>at least</span>
      </figcaption>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Distribution of models slain. Expected ${expected.toFixed(2)} of ${models}.`}
      >
        {[0, 0.5, 1].map((p) => (
          <g key={p}>
            <line
              x1={padLeft}
              x2={width - 6}
              y1={y(p)}
              y2={y(p)}
              stroke="var(--rule-soft)"
              strokeWidth="1"
            />
            <text x={padLeft - 6} y={y(p) + 3.5} textAnchor="end" className="dist-tick">
              {p * 100}%
            </text>
          </g>
        ))}

        {points.map((point) =>
          point.exactly > 0.001 ? (
            <rect
              key={point.slain}
              x={x(point.slain) - barWidth / 2}
              y={y(point.exactly)}
              width={barWidth}
              height={Math.max(1, plotHeight - (y(point.exactly) - padTop))}
              rx="2"
              fill={EXACTLY}
            >
              <title>
                {`${(point.exactly * 100).toFixed(1)}% chance of exactly ${point.slain}`}
              </title>
            </rect>
          ) : null
        )}

        <path d={line} fill="none" stroke={AT_LEAST} strokeWidth="2" strokeLinejoin="round" />
        {cumulative.map((c) => (
          <circle key={c.slain} cx={x(c.slain)} cy={y(c.atLeast)} r="2.5" fill={AT_LEAST}>
            <title>{`${(c.atLeast * 100).toFixed(1)}% chance of ${c.slain} or more`}</title>
          </circle>
        ))}

        {/* The expected value, which is the number the cell reports. */}
        <line
          x1={x(0) + step * expected - step / 2}
          x2={x(0) + step * expected - step / 2}
          y1={padTop}
          y2={padTop + plotHeight}
          stroke="var(--ink-3)"
          strokeWidth="1"
          strokeDasharray="3 3"
        />

        {points.map((point) => (
          <text
            key={point.slain}
            x={x(point.slain)}
            y={height - 7}
            textAnchor="middle"
            className="dist-tick"
          >
            {point.slain}
          </text>
        ))}

        {peak.exactly > 0.001 ? (
          <text
            x={x(peak.slain)}
            y={y(peak.exactly) - 4}
            textAnchor="middle"
            className="dist-label"
          >
            {(peak.exactly * 100).toFixed(0)}%
          </text>
        ) : null}
      </svg>

      <table className="dist-table">
        <caption>Chance of killing each number of models</caption>
        <thead>
          <tr>
            <th>Slain</th>
            <th>Exactly</th>
            <th>At least</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point, i) => (
            <tr key={point.slain}>
              <td>{point.slain}</td>
              <td>{(point.exactly * 100).toFixed(1)}%</td>
              <td>{(cumulative[i].atLeast * 100).toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
