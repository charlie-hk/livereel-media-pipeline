import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LivereelClient } from '../protocol/client';
import { MockTransport } from '../mock/mockTransport';
import { WebSocketTransport } from '../protocol/transport';
import type {
  CapabilityReport,
  ConnectionState,
  ProgressSample,
  ServiceStatus,
  SessionSummary,
  StartSessionParams,
  StartSessionResult,
} from '../protocol/types';

/** How many telemetry samples each session keeps for its chart. */
const WINDOW = 90;

export interface LogEntry {
  id: number;
  event: string;
  data: unknown;
  ts: number;
}

export interface Connection {
  mode: 'demo' | 'live';
  url: string;
  token: string;
}

export function useLivereel() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [state, setState] = useState<ConnectionState>('idle');
  const [detail, setDetail] = useState<string>();
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilityReport | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [telemetry, setTelemetry] = useState<Record<string, ProgressSample[]>>({});
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<LivereelClient | null>(null);
  const logId = useRef(0);

  const connect = useCallback((next: Connection) => {
    clientRef.current?.disconnect();
    setStatus(null);
    setCapabilities(null);
    setSessions([]);
    setTelemetry({});
    setLog([]);
    setError(null);
    setConnection(next);
  }, []);

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect();
    clientRef.current = null;
    setConnection(null);
    setState('idle');
  }, []);

  useEffect(() => {
    if (!connection) return;

    const transport =
      connection.mode === 'demo'
        ? new MockTransport()
        : new WebSocketTransport({ url: connection.url, token: connection.token || undefined });

    const client = new LivereelClient({ transport });
    clientRef.current = client;

    const offState = client.onState((next, why) => {
      setState(next);
      setDetail(why);
    });

    const offAny = client.onAny((event, data, ts) => {
      logId.current += 1;
      const entry = { id: logId.current, event, data, ts };
      // Progress arrives twice a second per session and would bury everything else, so the
      // log keeps the discrete events and the chart keeps the stream.
      if (event !== 'session.progress') {
        setLog((prev) => [entry, ...prev].slice(0, 200));
      }
    });

    const offProgress = client.on('session.progress', (sample) => {
      setTelemetry((prev) => {
        const series = prev[sample.sessionId] ?? [];
        return { ...prev, [sample.sessionId]: [...series, sample].slice(-WINDOW) };
      });
    });

    const refresh = async () => {
      try {
        const [nextStatus, nextSessions] = await Promise.all([
          client.request<ServiceStatus>('status.get'),
          client.request<SessionSummary[]>('session.list'),
        ]);
        setStatus(nextStatus);
        setSessions(nextSessions);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    const offHello = client.on('hello', async () => {
      try {
        setCapabilities(await client.request<CapabilityReport>('capabilities.get'));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      await refresh();
    });

    const offStarted = client.on('session.started', () => void refresh());
    const offStopped = client.on('session.stopped', () => void refresh());
    const offExit = client.on('session.exit', () => void refresh());

    client.connect();

    // Status counters move on their own as commands and events flow, so they are polled
    // rather than only read once on connect.
    const poll = setInterval(() => {
      if (client.state === 'open') void refresh();
    }, 4000);

    return () => {
      clearInterval(poll);
      offState();
      offAny();
      offProgress();
      offHello();
      offStarted();
      offStopped();
      offExit();
      client.disconnect();
    };
  }, [connection]);

  const call = useCallback(async <T,>(type: string, params?: Record<string, unknown>) => {
    const client = clientRef.current;
    if (!client) throw new Error('not connected');
    setError(null);
    try {
      return await client.request<T>(type, params);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, []);

  const startSession = useCallback(
    (params: StartSessionParams) => call<StartSessionResult>('session.start', params as Record<string, unknown>),
    [call],
  );

  const stopSession = useCallback(
    (sessionId: string) => call('session.stop', { sessionId }),
    [call],
  );

  const setOverlay = useCallback(
    (sessionId: string, text: string) => call<{ changed: boolean }>('overlay.set', { sessionId, text }),
    [call],
  );

  const connected = state === 'open';

  return useMemo(
    () => ({
      connection,
      state,
      detail,
      connected,
      status,
      capabilities,
      sessions,
      telemetry,
      log,
      error,
      connect,
      disconnect,
      call,
      startSession,
      stopSession,
      setOverlay,
      clearError: () => setError(null),
    }),
    [
      connection,
      state,
      detail,
      connected,
      status,
      capabilities,
      sessions,
      telemetry,
      log,
      error,
      connect,
      disconnect,
      call,
      startSession,
      stopSession,
      setOverlay,
    ],
  );
}
