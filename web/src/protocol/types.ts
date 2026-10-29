/**
 * The wire protocol, typed.
 *
 * These mirror src/control/protocol.js and the handler results in src/service.js. They are
 * written by hand rather than generated because the service is plain JavaScript, so the one
 * place this can drift is here: the tests in src/protocol/client.test.ts assert the shapes
 * that matter against frames copied from a real session.
 */

export const PROTOCOL_VERSION = 1;

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'unknown_command'
  | 'not_found'
  | 'conflict'
  | 'unavailable'
  | 'internal';

export interface ProtocolErrorBody {
  code: ErrorCode;
  message: string;
}

export interface OkReply<T = unknown> {
  id: string | number | null;
  ok: true;
  result: T;
}

export interface ErrReply {
  id: string | number | null;
  ok: false;
  error: ProtocolErrorBody;
}

export interface EventFrame<T = unknown> {
  type: 'event';
  event: string;
  data: T;
  ts: number;
}

export type Frame = OkReply | ErrReply | EventFrame;

export function isEventFrame(frame: Frame): frame is EventFrame {
  return (frame as EventFrame).type === 'event';
}

/* ------------------------------------------------------------------ commands */

export interface HelloData {
  protocolVersion: number;
  clientId: string;
  commands: string[];
}

export interface EncoderReport {
  name: string;
  kind: 'hardware' | 'software';
  vendor: string | null;
  usable: boolean;
  reason?: string;
  probeMs?: number;
  device?: string;
}

export interface CapabilityReport {
  probedAt: string;
  fingerprint: {
    platform: string;
    ffmpegVersion: string;
    gpus: string[];
    nvidiaDriver: string | null;
  };
  renderNodes: string[];
  encoders: EncoderReport[];
  hwaccels: string[];
}

export interface ServiceStatus {
  uptimeMs: number;
  platform: string;
  sessions: number;
  pipelines: number;
  encoders: string[];
  gstEncoder: string | null;
  obs: { enabled: boolean; connected: boolean };
  store: { driver: string; configured: string; degraded: boolean };
  control: {
    commands: number;
    errors: number;
    eventsSent: number;
    telemetryDropped: number;
  };
}

export type SourceSpec =
  | { type: 'test'; width?: number; height?: number; fps?: number }
  | { type: 'camera'; device: string }
  | { type: 'screen'; display?: string }
  | { type: 'file'; path: string };

export type OutputSpec =
  | { type: 'file'; path: string; audio?: boolean }
  | { type: 'rtmp'; url: string }
  | { type: 'srt'; url: string }
  | { type: 'hls'; directory: string }
  | { type: 'null' };

export interface StartSessionParams {
  sessionId?: string;
  source?: SourceSpec;
  outputs?: OutputSpec[];
  encoder?: string;
  video?: { width?: number; height?: number; fps?: number; bitrate?: string };
}

export interface StartSessionResult {
  sessionId: string;
  encoder: string;
  hardware: boolean;
  fellBack: boolean;
  fallbackReason: string | null;
  outputs: Array<{ type: string; path: string | null }>;
}

export interface SessionSummary {
  sessionId: string;
  running: boolean;
  encoder: string;
  startedAt: string;
  outputs: string[];
}

export interface StopSessionResult {
  sessionId: string;
  stoppedBy: string;
  code?: number | null;
  signal?: string | null;
}

export interface ObsStatus {
  recording: boolean;
  currentScene: string | null;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ events */

export interface ProgressSample {
  sessionId: string;
  frame: number;
  fps: number;
  bitrateKbps: number | null;
  outTimeMs: number;
  totalSizeBytes: number;
  droppedFrames: number;
  dupFrames: number;
  /** Below 1.0 on a live source means the encoder is falling behind. */
  speed: number | null;
  encoder: string;
  ended: boolean;
}

export interface SessionStartedData {
  sessionId: string;
  encoder: string;
  hardware: boolean;
  fellBack: boolean;
}

export interface SessionExitData {
  sessionId: string;
  code: number | null;
  signal: string | null;
  [key: string]: unknown;
}

export interface SessionRestartData {
  sessionId: string;
  attempt: number;
  delayMs: number;
  [key: string]: unknown;
}

/** Every event the service broadcasts, mapped to the shape of its `data`. */
export interface EventMap {
  hello: HelloData;
  'session.started': SessionStartedData;
  'session.progress': ProgressSample;
  'session.restart': SessionRestartData;
  'session.exit': SessionExitData;
  'session.giveup': SessionExitData;
  'session.stopped': StopSessionResult;
  'pipeline.exit': { pipelineId: string; code: number | null };
  'obs.connected': Record<string, unknown>;
  'obs.disconnected': Record<string, unknown>;
  'obs.sceneChanged': { sceneName: string };
  'obs.recordStateChanged': { outputActive: boolean };
}

export type EventName = keyof EventMap;

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';
