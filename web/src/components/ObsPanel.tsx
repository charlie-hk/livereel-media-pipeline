import { useEffect, useState } from 'react';
import { Badge, Button, Card, Empty } from './ui';

interface ScenesResult {
  scenes: string[];
  current: string | null;
}

export function ObsPanel({
  connected,
  enabled,
  obsConnected,
  call,
}: {
  connected: boolean;
  enabled: boolean;
  obsConnected: boolean;
  call: <T>(type: string, params?: Record<string, unknown>) => Promise<T>;
}) {
  const [scenes, setScenes] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    if (!connected || !obsConnected) return;
    let cancelled = false;

    void (async () => {
      try {
        const result = await call<ScenesResult>('obs.scenes');
        if (cancelled) return;
        setScenes(result.scenes ?? []);
        setCurrent(result.current ?? null);
        setUnavailable(null);
      } catch (err) {
        if (!cancelled) setUnavailable(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connected, obsConnected, call]);

  const body = () => {
    if (!connected) return <Empty>Not connected.</Empty>;
    if (!enabled) return <Empty>OBS integration is disabled in the service config.</Empty>;
    if (!obsConnected) return <Empty>The service is not connected to OBS.</Empty>;
    if (unavailable) return <Empty>{unavailable}</Empty>;

    return (
      <>
        <div className="flex flex-wrap gap-2">
          {scenes.map((scene) => (
            <Button
              key={scene}
              variant={scene === current ? 'primary' : 'ghost'}
              onClick={async () => {
                await call('obs.setScene', { scene });
                setCurrent(scene);
              }}
            >
              {scene}
            </Button>
          ))}
        </div>

        <div className="mt-4 pt-4 border-t border-edge/60 flex items-center gap-2">
          <Button
            variant={recording ? 'danger' : 'ghost'}
            onClick={async () => {
              const next = !recording;
              await call(next ? 'obs.startRecord' : 'obs.stopRecord');
              setRecording(next);
            }}
          >
            {recording ? 'Stop recording' : 'Start recording'}
          </Button>
          <span className="text-xs text-muted">obs-websocket v5</span>
        </div>
      </>
    );
  };

  return (
    <Card
      title="OBS"
      subtitle="Scenes and recording, over obs-websocket."
      action={<Badge tone={obsConnected ? 'good' : 'mute'}>{obsConnected ? 'connected' : 'offline'}</Badge>}
    >
      {body()}
    </Card>
  );
}
