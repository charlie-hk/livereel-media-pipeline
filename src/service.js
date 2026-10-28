/**
 * The service: capability probe, session registry, control server, store and OBS, wired
 * together with one lifecycle.
 *
 * Startup order matters. Capabilities are probed before the control port opens, so the first
 * client to connect is told what this host can do rather than finding out when its first
 * session fails. Shutdown runs in reverse, and sessions are stopped before the store closes,
 * so the record of how each one ended is written rather than lost.
 */

import crypto from 'node:crypto';
import { probeCapabilities, selectEncoder } from './media/capabilities.js';
import { FfmpegSession } from './media/ffmpeg.js';
import { GstPipeline, buildPipeline, selectGstEncoder } from './media/gstreamer.js';
import { ControlServer } from './control/server.js';
import { ObsController } from './control/obs.js';
import { ProtocolError, ErrorCode, requireField } from './control/protocol.js';
import { openStore } from './store/index.js';
import { resolveRoot, underRoot, ensureDir, isCaseInsensitive } from './platform/paths.js';
import { logger } from './log.js';

const log = logger('service');

export class LivereelService {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.pipelines = new Map();
    this.capabilities = null;
    this.gstEncoder = null;
    this.store = null;
    this.control = null;
    this.obs = null;
    this.startedAt = null;
  }

  async start() {
    this.startedAt = Date.now();

    this.capabilities = await probeCapabilities({
      ffmpegPath: this.config.ffmpegPath,
      useCache: this.config.encoder.probeCache,
    });
    const usable = this.capabilities.encoders.filter((e) => e.usable).map((e) => e.name);
    log.info('capabilities', { usable, hwaccels: this.capabilities.hwaccels });

    this.gstEncoder = await selectGstEncoder({ inspectPath: this.config.gstInspectPath });

    this.store = await openStore(this.config.store);

    const overlayRoot = ensureDir(resolveRoot(this.config.paths.roots, 'overlays'));
    const recordingsRoot = ensureDir(resolveRoot(this.config.paths.roots, 'recordings'));
    this.overlayRoot = overlayRoot;

    // A config carried over from Windows often disagrees with the real case of files on disk.
    // On a case-sensitive filesystem that becomes a file-not-found mid-session, so it is
    // worth saying at startup where the config came from.
    if (isCaseInsensitive(recordingsRoot) === false) {
      log.info('recordings filesystem is case-sensitive', { path: recordingsRoot });
    }

    if (this.config.obs.enabled) {
      this.obs = new ObsController(this.config.obs);
      this.obs.on('sceneChanged', (d) => this.control?.broadcast('obs.sceneChanged', d));
      this.obs.on('recordStateChanged', (d) => this.control?.broadcast('obs.recordStateChanged', d));
      this.obs.on('connected', (d) => this.control?.broadcast('obs.connected', d));
      this.obs.on('disconnected', (d) => this.control?.broadcast('obs.disconnected', d));
      await this.obs.connectOptional();
    }

    this.control = new ControlServer({
      host: this.config.control.host,
      port: this.config.control.port,
      token: this.config.control.token,
      handlers: this.#handlers(),
    }).start();

    log.info('service ready', {
      startupMs: Date.now() - this.startedAt,
      store: this.store.degraded ? 'file (degraded)' : this.config.store.driver,
      obs: this.obs?.connected ?? false,
      gstreamer: this.gstEncoder?.element ?? null,
    });

    return this;
  }

  #handlers() {
    return {
      'status.get': async () => this.status(),

      'capabilities.get': async () => this.capabilities,

      'session.start': async (params) => this.startSession(params),

      'session.stop': async (params) => {
        const id = requireField(params, 'sessionId');
        return this.stopSession(id);
      },

      'session.list': async () =>
        [...this.sessions.values()].map((entry) => ({
          sessionId: entry.id,
          running: entry.session.running,
          encoder: entry.encoder.name,
          startedAt: entry.startedAt,
          outputs: entry.outputs,
        })),

      'overlay.set': async (params) => {
        const id = requireField(params, 'sessionId');
        const text = requireField(params, 'text');
        const entry = this.sessions.get(id);
        if (!entry) throw new ProtocolError(ErrorCode.NOT_FOUND, `no such session: ${id}`);
        const changed = entry.session.setOverlayText(text);
        if (changed) void this.store.recordEvent(id, 'overlay.set', { text });
        return { changed };
      },

      'pipeline.start': async (params) => this.startGstPipeline(params),

      'pipeline.stop': async (params) => {
        const id = requireField(params, 'pipelineId');
        const pipeline = this.pipelines.get(id);
        if (!pipeline) throw new ProtocolError(ErrorCode.NOT_FOUND, `no such pipeline: ${id}`);
        const result = await pipeline.stop();
        this.pipelines.delete(id);
        return result;
      },

      'obs.scenes': async () => this.#withObs((obs) => obs.getScenes()),
      'obs.setScene': async (params) =>
        this.#withObs((obs) => obs.setScene(requireField(params, 'scene'))),
      'obs.startRecord': async () => this.#withObs((obs) => obs.startRecord()),
      'obs.stopRecord': async () => this.#withObs((obs) => obs.stopRecord()),
      'obs.status': async () => this.#withObs((obs) => obs.getStatus()),
      'obs.setText': async (params) =>
        this.#withObs((obs) =>
          obs.setTextSource(requireField(params, 'inputName'), requireField(params, 'text'))
        ),
    };
  }

  async #withObs(fn) {
    if (!this.obs) throw new ProtocolError(ErrorCode.UNAVAILABLE, 'OBS integration is disabled');
    if (!this.obs.connected) throw new ProtocolError(ErrorCode.UNAVAILABLE, 'not connected to OBS');
    try {
      return await fn(this.obs);
    } catch (err) {
      throw new ProtocolError(ErrorCode.UNAVAILABLE, `OBS call failed: ${err.message}`);
    }
  }

  /**
   * Start an FFmpeg session.
   *
   * Output paths are resolved under the configured root and refuse to escape it, because the
   * destination arrives from a control client and would otherwise be an arbitrary write
   * anywhere the service user can reach.
   */
  async startSession(params) {
    const id = params.sessionId ?? `s-${crypto.randomUUID().slice(0, 8)}`;
    if (this.sessions.has(id)) {
      throw new ProtocolError(ErrorCode.CONFLICT, `session ${id} already exists`);
    }

    const source = params.source ?? { type: 'test' };
    const video = { ...this.config.video, ...params.video };

    const encoder = selectEncoder(this.capabilities, params.encoder ?? this.config.encoder.prefer);

    // A rejected path is the client's mistake, not a server failure, so it is reported as a
    // bad request rather than surfacing as an internal error.
    const outputs = (params.outputs ?? [{ type: 'null' }]).map((target) => {
      try {
        if (target.type === 'file') {
          return { ...target, path: underRoot(this.config.paths.roots, 'recordings', target.path) };
        }
        if (target.type === 'hls') {
          return {
            ...target,
            directory: underRoot(this.config.paths.roots, 'recordings', target.directory),
          };
        }
        return target;
      } catch (err) {
        throw new ProtocolError(ErrorCode.BAD_REQUEST, err.message);
      }
    });

    const session = new FfmpegSession({
      id,
      source,
      outputs,
      encoder,
      video,
      overlay: this.config.overlay.enabled ? { ...this.config.overlay, directory: this.overlayRoot } : null,
      ffmpegPath: this.config.ffmpegPath,
      restart: this.config.restart,
    });

    const entry = {
      id,
      session,
      encoder,
      outputs: outputs.map((o) => o.type),
      startedAt: new Date().toISOString(),
    };
    this.sessions.set(id, entry);

    await this.store.startSession({
      sessionId: id,
      source,
      outputs,
      video,
      encoder: encoder.name,
      encoderKind: encoder.kind,
      // A fallback is recorded on the session rather than only logged: "why was this
      // recording software-encoded" is a question asked after the fact.
      encoderFellBack: encoder.fellBack ?? false,
      encoderRequested: encoder.requested ?? null,
      encoderFallbackReason: encoder.fallbackReason ?? null,
      args: session.buildArgs(),
    });

    session.on('progress', (sample) => {
      this.store.recordTelemetry(id, sample);
      // Telemetry is droppable: a congested client should fall behind on progress rather
      // than on commands.
      this.control.broadcast('session.progress', sample, { droppable: true });
    });

    session.on('restart', (info) => {
      void this.store.recordEvent(id, 'restart', info);
      this.control.broadcast('session.restart', { sessionId: id, ...info });
    });

    session.on('giveup', (info) => {
      void this.store.recordEvent(id, 'giveup', info);
      this.control.broadcast('session.giveup', { sessionId: id, ...info });
    });

    session.on('exit', (info) => {
      void this.store.recordEvent(id, 'exit', info);
      this.control.broadcast('session.exit', { sessionId: id, ...info });
    });

    session.start();

    this.control.broadcast('session.started', {
      sessionId: id,
      encoder: encoder.name,
      hardware: encoder.kind === 'hardware',
      fellBack: encoder.fellBack ?? false,
    });

    return {
      sessionId: id,
      encoder: encoder.name,
      hardware: encoder.kind === 'hardware',
      fellBack: encoder.fellBack ?? false,
      fallbackReason: encoder.fallbackReason ?? null,
      outputs: outputs.map((o) => ({ type: o.type, path: o.path ?? o.url ?? o.directory ?? null })),
    };
  }

  async stopSession(id) {
    const entry = this.sessions.get(id);
    if (!entry) throw new ProtocolError(ErrorCode.NOT_FOUND, `no such session: ${id}`);

    const result = await entry.session.stop();
    this.sessions.delete(id);

    await this.store.endSession(id, { status: 'stopped', stoppedBy: result.stoppedBy });
    this.control.broadcast('session.stopped', { sessionId: id, ...result });
    return { sessionId: id, ...result };
  }

  async startGstPipeline(params) {
    if (!this.gstEncoder) {
      throw new ProtocolError(ErrorCode.UNAVAILABLE, 'no GStreamer H.264 encoder on this host');
    }

    const id = params.pipelineId ?? `p-${crypto.randomUUID().slice(0, 8)}`;
    if (this.pipelines.has(id)) {
      throw new ProtocolError(ErrorCode.CONFLICT, `pipeline ${id} already exists`);
    }

    const branches = (params.branches ?? [{ type: 'null' }]).map((branch) => {
      if (branch.type !== 'file') return branch;
      try {
        return { ...branch, path: underRoot(this.config.paths.roots, 'recordings', branch.path) };
      } catch (err) {
        throw new ProtocolError(ErrorCode.BAD_REQUEST, err.message);
      }
    });

    const description = buildPipeline({
      source: params.source ?? { type: 'test' },
      encoder: this.gstEncoder,
      branches,
      width: params.width ?? this.config.video.width,
      height: params.height ?? this.config.video.height,
      fps: params.fps ?? this.config.video.fps,
    });

    const pipeline = new GstPipeline({
      id,
      description,
      gstPath: this.config.gstLaunchPath,
      restart: this.config.restart,
    });

    pipeline.on('exit', (info) => {
      void this.store.recordEvent(id, 'pipeline.exit', info);
      this.control.broadcast('pipeline.exit', { pipelineId: id, ...info });
    });

    pipeline.start();
    this.pipelines.set(id, pipeline);

    await this.store.recordEvent(id, 'pipeline.start', { description, encoder: this.gstEncoder.element });
    return { pipelineId: id, encoder: this.gstEncoder.element, description };
  }

  status() {
    return {
      uptimeMs: Date.now() - this.startedAt,
      platform: process.platform,
      sessions: this.sessions.size,
      pipelines: this.pipelines.size,
      encoders: this.capabilities.encoders.filter((e) => e.usable).map((e) => e.name),
      gstEncoder: this.gstEncoder?.element ?? null,
      obs: { enabled: Boolean(this.obs), connected: this.obs?.connected ?? false },
      store: {
        // What is actually in use, alongside what was asked for: a degraded store is still
        // recording, and the gap between the two is the thing worth seeing in a status call.
        driver: this.store.degraded ? 'file' : this.config.store.driver,
        configured: this.config.store.driver,
        degraded: this.store.degraded ?? false,
      },
      control: this.control.stats,
    };
  }

  /**
   * Shut down in reverse order of startup.
   *
   * Sessions first and in parallel: each one may spend seconds finishing its output, and
   * systemd's TimeoutStopSec is the budget for all of them together, not each.
   */
  async stop() {
    log.info('shutting down', { sessions: this.sessions.size, pipelines: this.pipelines.size });

    await Promise.allSettled([
      ...[...this.sessions.keys()].map((id) => this.stopSession(id)),
      ...[...this.pipelines.values()].map((pipeline) => pipeline.stop()),
    ]);
    this.pipelines.clear();

    await this.control?.stop();
    await this.obs?.disconnect();
    await this.store?.close();

    log.info('shutdown complete');
  }
}
