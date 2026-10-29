import { useState } from 'react';
import { Badge, Button, Card, Empty, Stat } from './ui';
import { TelemetryChart } from './TelemetryChart';
import type { ProgressSample, SessionSummary, StartSessionParams } from '../protocol/types';

export function SessionsPanel({
  sessions,
  telemetry,
  connected,
  encoders,
  onStart,
  onStop,
  onOverlay,
}: {
  sessions: SessionSummary[];
  telemetry: Record<string, ProgressSample[]>;
  connected: boolean;
  encoders: string[];
  onStart: (params: StartSessionParams) => Promise<unknown>;
  onStop: (sessionId: string) => Promise<unknown>;
  onOverlay: (sessionId: string, text: string) => Promise<unknown>;
}) {
  return (
    <Card
      title="Sessions"
      subtitle="An FFmpeg encode per session, supervised by the service."
      action={<NewSession connected={connected} encoders={encoders} onStart={onStart} />}
    >
      {sessions.length === 0 ? (
        <Empty>{connected ? 'No session running. Start one above.' : 'Not connected.'}</Empty>
      ) : (
        <ul className="space-y-3">
          {sessions.map((session) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              samples={telemetry[session.sessionId] ?? []}
              onStop={onStop}
              onOverlay={onOverlay}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function NewSession({
  connected,
  encoders,
  onStart,
}: {
  connected: boolean;
  encoders: string[];
  onStart: (params: StartSessionParams) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  // Hardware by default even on a host that cannot do it: the fallback, and the reason the
  // service records for it, is the behaviour worth seeing.
  const [encoder, setEncoder] = useState('h264_nvenc');

  const options = ['h264_nvenc', 'h264_qsv', 'h264_vaapi', ...encoders].filter(
    (name, index, all) => all.indexOf(name) === index,
  );

  const start = async () => {
    setBusy(true);
    try {
      await onStart({
        source: { type: 'test', width: 1280, height: 720, fps: 30 },
        outputs: [{ type: 'file', path: `demo/take-${Date.now()}.mp4` }],
        encoder,
      });
    } catch {
      // the error is surfaced by the hook
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor="encoder-choice">
        Encoder
      </label>
      <select
        id="encoder-choice"
        className="field w-auto text-xs font-mono py-1.5"
        value={encoder}
        onChange={(e) => setEncoder(e.target.value)}
        disabled={!connected}
      >
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <Button variant="primary" disabled={!connected || busy} onClick={start}>
        {busy ? 'Starting...' : 'Start a session'}
      </Button>
    </div>
  );
}

function SessionRow({
  session,
  samples,
  onStop,
  onOverlay,
}: {
  session: SessionSummary;
  samples: ProgressSample[];
  onStop: (sessionId: string) => Promise<unknown>;
  onOverlay: (sessionId: string, text: string) => Promise<unknown>;
}) {
  const [overlay, setOverlay] = useState('');
  const [applied, setApplied] = useState(false);
  const [busy, setBusy] = useState(false);

  const latest = samples[samples.length - 1];
  const behind = latest?.speed != null && latest.speed < 1;

  const apply = async () => {
    setBusy(true);
    try {
      await onOverlay(session.sessionId, overlay);
      setApplied(true);
      setTimeout(() => setApplied(false), 1800);
    } catch {
      // surfaced by the hook
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="bg-ink-700/50 border border-edge/60 rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-sm text-slate-100">{session.sessionId}</span>
          <Badge tone={session.encoder === 'libx264' ? 'mute' : 'good'}>{session.encoder}</Badge>
          <Badge tone="mute">{session.outputs.join(', ') || 'no output'}</Badge>
          {behind ? <Badge tone="warn">falling behind</Badge> : null}
        </div>
        <Button variant="danger" onClick={() => void onStop(session.sessionId)}>
          Stop
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-4">
        <Stat label="Speed" value={latest?.speed != null ? `${latest.speed.toFixed(2)}x` : '-'} />
        <Stat label="FPS" value={latest ? latest.fps.toFixed(1) : '-'} />
        <Stat label="Bitrate" value={latest?.bitrateKbps != null ? `${Math.round(latest.bitrateKbps)} kbps` : '-'} />
        <Stat label="Output" value={latest ? formatBytes(latest.totalSizeBytes) : '-'} />
        <Stat label="Dropped" value={latest?.droppedFrames ?? 0} />
      </div>

      <div className="mt-3">
        <TelemetryChart samples={samples} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="label shrink-0" htmlFor={`overlay-${session.sessionId}`}>
          Overlay
        </label>
        <input
          id={`overlay-${session.sessionId}`}
          className="field flex-1 min-w-[180px] text-xs font-mono"
          placeholder="burned-in text, changed without restarting FFmpeg"
          value={overlay}
          onChange={(e) => setOverlay(e.target.value)}
        />
        <Button onClick={apply} disabled={busy}>
          {applied ? 'Applied' : 'Apply'}
        </Button>
      </div>
    </li>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
