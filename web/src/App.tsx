import { useLivereel } from './hooks/useLivereel';
import { ConnectBar } from './components/ConnectBar';
import { StatusPanel } from './components/StatusPanel';
import { CapabilitiesPanel } from './components/CapabilitiesPanel';
import { SessionsPanel } from './components/SessionsPanel';
import { ObsPanel } from './components/ObsPanel';
import { EventLog } from './components/EventLog';
import { Button } from './components/ui';

export default function App() {
  const live = useLivereel();

  return (
    <div className="min-h-screen">
      <header className="border-b border-edge/60 bg-ink-800/60 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-baseline gap-3 min-w-0">
            <h1 className="text-lg font-bold tracking-tight">
              livereel<span className="text-good">.</span>
            </h1>
            <p className="text-xs text-muted truncate hidden sm:block">
              control panel for the media pipeline service
            </p>
          </div>
          <a
            className="text-xs text-muted hover:text-slate-200 transition-colors shrink-0"
            href="https://github.com/charlie-hk/livereel-media-pipeline"
            target="_blank"
            rel="noreferrer"
          >
            source
          </a>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5 space-y-5">
        <ConnectBar
          state={live.state}
          detail={live.detail}
          connection={live.connection}
          onConnect={live.connect}
          onDisconnect={live.disconnect}
        />

        {live.connection?.mode === 'demo' ? (
          <p className="text-xs text-muted leading-relaxed bg-ink-800/60 border border-edge/60 rounded-lg px-3 py-2">
            This is the bundled demo. No service is running: an in-process stand-in answers the
            same protocol, with the probe results from a real GPU-less Ubuntu host. Point the
            panel at <span className="font-mono text-slate-300">ws://127.0.0.1:8787</span> to drive
            a real one.
          </p>
        ) : null}

        {live.error ? (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 bg-bad/10 border border-bad/30 rounded-lg px-3 py-2"
          >
            <p className="text-xs text-bad font-mono break-all">{live.error}</p>
            <Button onClick={live.clearError}>Dismiss</Button>
          </div>
        ) : null}

        <div className="grid lg:grid-cols-2 gap-5">
          <StatusPanel status={live.status} />
          <CapabilitiesPanel report={live.capabilities} />
        </div>

        <SessionsPanel
          sessions={live.sessions}
          telemetry={live.telemetry}
          connected={live.connected}
          encoders={live.status?.encoders ?? []}
          onStart={live.startSession}
          onStop={live.stopSession}
          onOverlay={live.setOverlay}
        />

        <div className="grid lg:grid-cols-2 gap-5">
          <ObsPanel
            connected={live.connected}
            enabled={live.status?.obs.enabled ?? false}
            obsConnected={live.status?.obs.connected ?? false}
            call={live.call}
          />
          <EventLog entries={live.log} />
        </div>
      </main>

      <footer className="max-w-6xl mx-auto px-4 py-8 text-xs text-muted">
        Built by Ali Amini. The panel speaks the same WebSocket protocol as the service, so the
        demo and a real deployment run the same code.
      </footer>
    </div>
  );
}
