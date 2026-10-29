import { useId } from 'react';
import type { ProgressSample } from '../protocol/types';

const WIDTH = 560;
const HEIGHT = 120;

/**
 * Encoder speed over time.
 *
 * Drawn by hand rather than with a chart library: the series is a fixed-length window of
 * numbers with one threshold that matters, and 1.0 is that threshold. Below it a live
 * encoder is not keeping up, so the line is drawn against a marked baseline instead of an
 * axis scaled to whatever happens to be in view.
 */
export function TelemetryChart({ samples }: { samples: ProgressSample[] }) {
  const gradientId = useId();
  const points = samples.map((s) => s.speed ?? 0);

  if (points.length < 2) {
    return (
      <div className="h-[120px] flex items-center justify-center text-xs text-muted border border-dashed border-edge/60 rounded-lg">
        waiting for telemetry
      </div>
    );
  }

  const max = Math.max(1.3, ...points);
  const min = Math.min(0.7, ...points);
  const span = max - min || 1;

  const x = (i: number) => (i / (points.length - 1)) * WIDTH;
  const y = (v: number) => HEIGHT - ((v - min) / span) * HEIGHT;

  const line = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`;

  const latest = points[points.length - 1] ?? 0;
  const behind = latest < 1;
  const stroke = behind ? '#d29922' : '#3fb950';

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="w-full h-[120px]"
      role="img"
      aria-label={`Encoder speed, currently ${latest.toFixed(2)} times real time`}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>

      <path d={area} fill={`url(#${gradientId})`} />
      {/* real time: above this line the encoder is keeping up. Drawn over the fill, because
          underneath it the one reference the chart has disappears. */}
      <line
        x1="0"
        x2={WIDTH}
        y1={y(1)}
        y2={y(1)}
        stroke="#8b949e"
        strokeWidth="1"
        strokeDasharray="5 5"
        opacity="0.65"
        vectorEffect="non-scaling-stroke"
      />
      <path d={line} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
