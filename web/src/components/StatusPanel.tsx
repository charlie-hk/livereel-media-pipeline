import { Badge, Card, Empty, Stat } from './ui';
import type { ServiceStatus } from '../protocol/types';

export function StatusPanel({ status }: { status: ServiceStatus | null }) {
  if (!status) {
    return (
      <Card title="Service">
        <Empty>Not connected.</Empty>
      </Card>
    );
  }

  const { store, obs, control } = status;

  return (
    <Card
      title="Service"
      subtitle={`${status.platform} · up ${formatDuration(status.uptimeMs)}`}
      action={
        store.degraded ? (
          <Badge tone="warn">store degraded</Badge>
        ) : (
          <Badge tone="good">store {store.driver}</Badge>
        )
      }
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Stat label="Sessions" value={status.sessions} />
        <Stat label="Pipelines" value={status.pipelines} />
        <Stat label="GStreamer" value={status.gstEncoder ?? 'none'} />
        <Stat
          label="OBS"
          value={obs.enabled ? (obs.connected ? 'connected' : 'disconnected') : 'disabled'}
        />
      </div>

      {store.degraded ? (
        <p className="mt-4 text-xs text-muted leading-relaxed">
          Configured for <span className="font-mono text-slate-300">{store.configured}</span> and
          writing to <span className="font-mono text-slate-300">{store.driver}</span> instead.
          Recording continues; only querying is lost.
        </p>
      ) : null}

      <div className="mt-4 pt-4 border-t border-edge/60 grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Stat label="Commands" value={control.commands} />
        <Stat label="Errors" value={control.errors} />
        <Stat label="Events sent" value={control.eventsSent} />
        <Stat
          label="Telemetry dropped"
          value={control.telemetryDropped}
          hint={control.telemetryDropped > 0 ? 'a client fell behind' : undefined}
        />
      </div>
    </Card>
  );
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
