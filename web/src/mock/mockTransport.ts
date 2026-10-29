import type { Transport, TransportHandlers } from '../protocol/transport';
import type {
  CapabilityReport,
  ProgressSample,
  ServiceStatus,
  SessionSummary,
  StartSessionParams,
} from '../protocol/types';

/**
 * A stand-in service, so the panel can be opened without one.
 *
 * It speaks the same frames as src/control/server.js rather than feeding the components
 * canned props: the request correlation, the event routing and the backpressure-free
 * telemetry stream are all the real code paths. The numbers are taken from an actual probe
 * on a GPU-less Ubuntu host, which is why NVENC, QSV and VAAPI are all rejected here with
 * the messages FFmpeg really prints.
 */

const START_MS = Date.now();

const CAPABILITIES: CapabilityReport = {
  probedAt: new Date(START_MS - 42_000).toISOString(),
  fingerprint: {
    platform: 'linux',
    ffmpegVersion: '6.1.1-3ubuntu5',
    gpus: [],
    nvidiaDriver: null,
  },
  renderNodes: [],
  encoders: [
    {
      name: 'h264_nvenc',
      kind: 'hardware',
      vendor: 'nvidia',
      usable: false,
      reason: '[h264_nvenc @ 0x5581e4] Cannot load libcuda.so.1',
    },
    {
      name: 'h264_qsv',
      kind: 'hardware',
      vendor: 'intel',
      usable: false,
      reason: '[h264_qsv @ 0x5581e4] Error creating a MFX session: -9.',
    },
    {
      name: 'h264_vaapi',
      kind: 'hardware',
      vendor: 'mesa',
      usable: false,
      reason: 'no render node found',
    },
    { name: 'libx264', kind: 'software', vendor: null, usable: true, probeMs: 71 },
  ],
  hwaccels: ['vdpau', 'vaapi', 'qsv', 'drm', 'opencl'],
};

interface MockSession {
  id: string;
  encoder: string;
  startedAt: string;
  outputs: string[];
  overlayText: string;
  frame: number;
  bytes: number;
  startedMs: number;
}

export class MockTransport implements Transport {
  readonly label = 'demo';

  #handlers: TransportHandlers | null = null;
  #sessions = new Map<string, MockSession>();
  #ticker: ReturnType<typeof setInterval> | null = null;
  #counter = 0;
  #stats = { commands: 0, errors: 0, eventsSent: 0, telemetryDropped: 0 };
  #obs = { connected: true, scene: 'Studio', recording: false };

  open(handlers: TransportHandlers): void {
    this.#handlers = handlers;
    handlers.onState('connecting');

    // A short delay so the connecting state is a real state the panel passes through rather
    // than a frame nobody sees.
    setTimeout(() => {
      handlers.onState('open');
      this.#emit('hello', {
        protocolVersion: 1,
        clientId: 'demo-client',
        commands: [
          'capabilities.get',
          'obs.scenes',
          'obs.setScene',
          'obs.startRecord',
          'obs.status',
          'obs.stopRecord',
          'overlay.set',
          'pipeline.start',
          'pipeline.stop',
          'session.list',
          'session.start',
          'session.stop',
          'status.get',
        ],
      });
      this.#startTicker();
    }, 220);
  }

  send(payload: string): void {
    let message: { id?: string; type?: string; [key: string]: unknown };
    try {
      message = JSON.parse(payload);
    } catch {
      return this.#send({ id: null, ok: false, error: { code: 'bad_request', message: 'message is not valid JSON' } });
    }

    const { id = null, type, ...params } = message;
    this.#stats.commands += 1;

    // Network latency the panel has to cope with, rather than instant answers that hide
    // every loading state.
    setTimeout(() => this.#handle(id, String(type), params), 90 + Math.random() * 120);
  }

  close(): void {
    if (this.#ticker) clearInterval(this.#ticker);
    this.#ticker = null;
    this.#sessions.clear();
    this.#handlers?.onState('idle');
  }

  /* ---------------------------------------------------------------- internals */

  #handle(id: string | null, type: string, params: Record<string, unknown>): void {
    switch (type) {
      case 'status.get':
        return this.#ok(id, this.#status());

      case 'capabilities.get':
        return this.#ok(id, CAPABILITIES);

      case 'session.list':
        return this.#ok(id, this.#list());

      case 'session.start':
        return this.#startSession(id, params as StartSessionParams);

      case 'session.stop':
        return this.#stopSession(id, String(params.sessionId ?? ''));

      case 'overlay.set':
        return this.#setOverlay(id, String(params.sessionId ?? ''), String(params.text ?? ''));

      case 'obs.scenes':
        return this.#ok(id, { scenes: ['Studio', 'Interview', 'Slides', 'Break'], current: this.#obs.scene });

      case 'obs.setScene': {
        const scene = String(params.scene ?? '');
        this.#obs.scene = scene;
        this.#emit('obs.sceneChanged', { sceneName: scene });
        return this.#ok(id, { scene });
      }

      case 'obs.startRecord':
        this.#obs.recording = true;
        this.#emit('obs.recordStateChanged', { outputActive: true });
        return this.#ok(id, { recording: true });

      case 'obs.stopRecord':
        this.#obs.recording = false;
        this.#emit('obs.recordStateChanged', { outputActive: false });
        return this.#ok(id, { recording: false });

      case 'obs.status':
        return this.#ok(id, { recording: this.#obs.recording, currentScene: this.#obs.scene });

      case 'ping':
        return this.#ok(id, { pong: true, clientTs: params.ts ?? null, serverTs: Date.now() });

      default:
        this.#stats.errors += 1;
        return this.#err(id, 'unknown_command', `unknown command: ${type}`);
    }
  }

  #startSession(id: string | null, params: StartSessionParams): void {
    const sessionId = params.sessionId ?? `s-${(++this.#counter).toString().padStart(4, '0')}`;
    if (this.#sessions.has(sessionId)) {
      this.#stats.errors += 1;
      return this.#err(id, 'conflict', `session ${sessionId} already exists`);
    }

    const requested = params.encoder ?? 'h264_nvenc';
    const usable = CAPABILITIES.encoders.find((e) => e.name === requested && e.usable);
    const encoder = usable?.name ?? 'libx264';
    const fellBack = encoder !== requested;
    const rejected = CAPABILITIES.encoders.find((e) => e.name === requested && !e.usable);

    const outputs = params.outputs ?? [{ type: 'null' }];

    this.#sessions.set(sessionId, {
      id: sessionId,
      encoder,
      startedAt: new Date().toISOString(),
      outputs: outputs.map((o) => o.type),
      overlayText: '',
      frame: 0,
      bytes: 0,
      startedMs: Date.now(),
    });

    this.#emit('session.started', { sessionId, encoder, hardware: encoder !== 'libx264', fellBack });

    this.#ok(id, {
      sessionId,
      encoder,
      hardware: encoder !== 'libx264',
      fellBack,
      fallbackReason: fellBack ? (rejected?.reason ?? 'encoder not usable on this host') : null,
      outputs: outputs.map((o) => ({
        type: o.type,
        path:
          'path' in o
            ? `/var/lib/livereel/recordings/${o.path}`
            : 'url' in o
              ? o.url
              : 'directory' in o
                ? `/var/lib/livereel/recordings/${o.directory}`
                : null,
      })),
    });
  }

  #stopSession(id: string | null, sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      this.#stats.errors += 1;
      return this.#err(id, 'not_found', `no such session: ${sessionId}`);
    }
    this.#sessions.delete(sessionId);
    const result = { sessionId, stoppedBy: 'SIGINT', code: 0, signal: null };
    this.#emit('session.stopped', result);
    this.#ok(id, result);
  }

  #setOverlay(id: string | null, sessionId: string, text: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      this.#stats.errors += 1;
      return this.#err(id, 'not_found', `no such session: ${sessionId}`);
    }
    const changed = session.overlayText !== text;
    session.overlayText = text;
    this.#ok(id, { changed });
  }

  /**
   * Telemetry.
   *
   * The speed figure drifts around 1.0 and dips below it now and then, because that dip is
   * the thing the panel is meant to make visible: a software encoder that cannot keep up
   * with a live source.
   */
  #startTicker(): void {
    this.#ticker = setInterval(() => {
      for (const session of this.#sessions.values()) {
        const elapsed = (Date.now() - session.startedMs) / 1000;
        const jitter = Math.sin(elapsed / 3) * 0.08 + (Math.random() - 0.5) * 0.05;
        const speed = Number(Math.max(0.6, 1.02 + jitter).toFixed(3));
        const fps = Number((30 * Math.min(1, speed)).toFixed(1));

        session.frame += Math.round(fps / 2);
        session.bytes += Math.round((2_400_000 / 8) * 0.5);

        const sample: ProgressSample = {
          sessionId: session.id,
          frame: session.frame,
          fps,
          bitrateKbps: Number((2400 + (Math.random() - 0.5) * 180).toFixed(1)),
          outTimeMs: Math.round(elapsed * 1000),
          totalSizeBytes: session.bytes,
          droppedFrames: speed < 0.95 ? Math.round((1 - speed) * 20) : 0,
          dupFrames: 0,
          speed,
          encoder: session.encoder,
          ended: false,
        };
        this.#emit('session.progress', sample);
      }
    }, 500);
  }

  #status(): ServiceStatus {
    return {
      uptimeMs: Date.now() - START_MS,
      platform: 'linux',
      sessions: this.#sessions.size,
      pipelines: 0,
      encoders: CAPABILITIES.encoders.filter((e) => e.usable).map((e) => e.name),
      gstEncoder: 'x264enc',
      obs: { enabled: true, connected: this.#obs.connected },
      store: { driver: 'file', configured: 'mongo', degraded: true },
      control: { ...this.#stats },
    };
  }

  #list(): SessionSummary[] {
    return [...this.#sessions.values()].map((session) => ({
      sessionId: session.id,
      running: true,
      encoder: session.encoder,
      startedAt: session.startedAt,
      outputs: session.outputs,
    }));
  }

  #ok(id: string | null, result: unknown): void {
    this.#send({ id, ok: true, result });
  }

  #err(id: string | null, code: string, message: string): void {
    this.#send({ id, ok: false, error: { code, message } });
  }

  #emit(event: string, data: unknown): void {
    this.#stats.eventsSent += 1;
    this.#send({ type: 'event', event, data, ts: Date.now() });
  }

  #send(frame: unknown): void {
    this.#handlers?.onFrame(JSON.stringify(frame));
  }
}
