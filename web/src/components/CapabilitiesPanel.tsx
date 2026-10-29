import { Badge, Card, Empty } from './ui';
import type { CapabilityReport } from '../protocol/types';

/**
 * What this host can actually encode.
 *
 * The rejected encoders matter as much as the usable one, so the reason FFmpeg gave is shown
 * rather than hidden behind a cross. "Cannot load libcuda.so.1" is the difference between a
 * missing driver and a missing card, and that is the first thing anyone asks.
 */
export function CapabilitiesPanel({ report }: { report: CapabilityReport | null }) {
  if (!report) {
    return (
      <Card title="Host encoders">
        <Empty>Not connected.</Empty>
      </Card>
    );
  }

  const usable = report.encoders.filter((e) => e.usable);

  return (
    <Card
      title="Host encoders"
      subtitle={`${report.fingerprint.ffmpegVersion} · probed ${new Date(report.probedAt).toLocaleTimeString()}`}
      action={<Badge tone={usable.some((e) => e.kind === 'hardware') ? 'good' : 'warn'}>
        {usable.some((e) => e.kind === 'hardware') ? 'hardware' : 'software only'}
      </Badge>}
    >
      <ul className="space-y-1.5">
        {report.encoders.map((encoder) => (
          <li
            key={encoder.name}
            className="flex items-start gap-3 py-1.5 px-2 rounded-lg hover:bg-ink-700/60 transition-colors"
          >
            <span className="shrink-0 w-14 pt-0.5">
              <Badge tone={encoder.usable ? 'good' : 'mute'}>{encoder.usable ? 'usable' : 'no'}</Badge>
            </span>
            <span className="font-mono text-xs text-slate-100 w-32 shrink-0 pt-1">{encoder.name}</span>
            <span className="text-xs text-muted pt-1 min-w-0 break-words">
              {encoder.usable
                ? `${encoder.kind}${encoder.probeMs ? `, probed in ${encoder.probeMs}ms` : ''}`
                : encoder.reason}
            </span>
          </li>
        ))}
      </ul>

      <dl className="mt-4 pt-4 border-t border-edge/60 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
        <Row label="GPUs" value={report.fingerprint.gpus.length ? report.fingerprint.gpus.join('; ') : 'none reported'} />
        <Row label="Render nodes" value={report.renderNodes.length ? report.renderNodes.join(', ') : 'none'} />
        <Row label="Driver" value={report.fingerprint.nvidiaDriver ?? 'n/a'} />
        <Row label="hwaccels" value={report.hwaccels.join(', ') || 'none'} />
      </dl>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 min-w-0">
      <dt className="text-muted shrink-0">{label}</dt>
      <dd className="font-mono text-slate-300 truncate">{value}</dd>
    </div>
  );
}
