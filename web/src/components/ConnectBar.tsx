import { useState } from 'react';
import { Badge, Button, Dot } from './ui';
import type { Connection } from '../hooks/useLivereel';
import type { ConnectionState } from '../protocol/types';

const STATE_TONE = {
  idle: 'mute',
  connecting: 'warn',
  open: 'good',
  closed: 'bad',
  error: 'bad',
} as const;

export function ConnectBar({
  state,
  detail,
  connection,
  onConnect,
  onDisconnect,
}: {
  state: ConnectionState;
  detail?: string;
  connection: Connection | null;
  onConnect: (connection: Connection) => void;
  onDisconnect: () => void;
}) {
  const [url, setUrl] = useState('ws://127.0.0.1:8787');
  const [token, setToken] = useState('');

  const busy = state === 'connecting';
  const live = connection?.mode === 'live';

  return (
    <div className="card p-3 flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2 pr-3 mr-1 border-r border-edge/60">
        <Dot tone={STATE_TONE[state]} />
        <span className="font-mono text-xs text-slate-300">{state}</span>
        {connection ? <Badge tone={connection.mode === 'demo' ? 'info' : 'good'}>{connection.mode}</Badge> : null}
      </div>

      <div className="flex items-center gap-2 flex-1 min-w-[260px]">
        <label className="sr-only" htmlFor="control-url">
          Control URL
        </label>
        <input
          id="control-url"
          className="field font-mono text-xs flex-1"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="ws://127.0.0.1:8787"
          disabled={live}
        />
        <label className="sr-only" htmlFor="control-token">
          Control token
        </label>
        <input
          id="control-token"
          className="field font-mono text-xs w-40"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="token (optional)"
          type="password"
          disabled={live}
        />
      </div>

      <div className="flex items-center gap-2">
        {connection ? (
          <Button onClick={onDisconnect}>Disconnect</Button>
        ) : (
          <>
            <Button variant="primary" disabled={busy} onClick={() => onConnect({ mode: 'live', url, token })}>
              Connect
            </Button>
            <Button disabled={busy} onClick={() => onConnect({ mode: 'demo', url: '', token: '' })}>
              Run the demo
            </Button>
          </>
        )}
      </div>

      {detail && state !== 'open' ? (
        <p role="status" className="w-full text-xs text-bad font-mono">
          {detail}
        </p>
      ) : null}
    </div>
  );
}
