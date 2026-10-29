import { Card, Empty } from './ui';
import type { LogEntry } from '../hooks/useLivereel';

const TONE: Record<string, string> = {
  'session.started': 'text-good',
  'session.stopped': 'text-slate-300',
  'session.restart': 'text-warn',
  'session.giveup': 'text-bad',
  'session.exit': 'text-warn',
  'pipeline.exit': 'text-warn',
  hello: 'text-sky-300',
};

/**
 * Discrete events only.
 *
 * Progress frames arrive twice a second per session and are deliberately left out: they are
 * the chart's job, and in a log they would push every restart and give-up off the screen
 * within a few seconds.
 */
export function EventLog({ entries }: { entries: LogEntry[] }) {
  return (
    <Card title="Events" subtitle="Telemetry is excluded; it goes to the chart.">
      {entries.length === 0 ? (
        <Empty>Nothing yet.</Empty>
      ) : (
        <ol className="space-y-1 max-h-[320px] overflow-y-auto font-mono text-[11px]">
          {entries.map((entry) => (
            <li key={entry.id} className="flex gap-3 py-1 border-b border-edge/30 last:border-0">
              <span className="text-muted shrink-0">
                {new Date(entry.ts).toLocaleTimeString([], { hour12: false })}
              </span>
              <span className={`shrink-0 w-36 ${TONE[entry.event] ?? 'text-slate-300'}`}>{entry.event}</span>
              <span className="text-muted min-w-0 break-all">{summarize(entry.data)}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function summarize(data: unknown): string {
  if (data === null || typeof data !== 'object') return String(data ?? '');
  const entries = Object.entries(data as Record<string, unknown>)
    .filter(([, value]) => value !== null && typeof value !== 'object')
    .map(([key, value]) => `${key}=${value}`);
  return entries.join(' ') || JSON.stringify(data);
}
