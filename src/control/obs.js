/**
 * OBS Studio control over obs-websocket v5.
 *
 * OBS is driven rather than replaced: it owns the scene composition and the operator's view,
 * while this service owns the encoding pipelines and the recording lifecycle. The two have to
 * agree, which is the point of the connection — a scene change that should start a recording
 * is one event, not two independent timers.
 *
 * Reconnection is assumed, not exceptional. OBS is a desktop application an operator can
 * close, and on Linux it needs a session bus and a display, so a service starting at boot
 * will routinely come up before OBS exists.
 */

import { EventEmitter } from 'node:events';
import OBSWebSocket from 'obs-websocket-js';
import { logger } from '../log.js';

const log = logger('obs');

export class ObsController extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} [options.url]       e.g. ws://127.0.0.1:4455
   * @param {string} [options.password]
   * @param {boolean} [options.autoReconnect]
   * @param {number} [options.reconnectDelayMs]
   */
  constructor({ url = 'ws://127.0.0.1:4455', password, autoReconnect = true, reconnectDelayMs = 5000 } = {}) {
    super();
    this.url = url;
    this.password = password;
    this.autoReconnect = autoReconnect;
    this.reconnectDelayMs = reconnectDelayMs;
    this.obs = new OBSWebSocket();
    this.connected = false;
    this.stopping = false;
    this.reconnectTimer = null;
    this.version = null;

    this.obs.on('ConnectionClosed', () => this.#onClosed());
    this.obs.on('ConnectionError', (err) => log.warn('obs connection error', { error: err.message }));

    // Forward the events worth reacting to, renamed into this service's own vocabulary so
    // callers are not coupled to obs-websocket's naming.
    this.obs.on('CurrentProgramSceneChanged', (d) =>
      this.emit('sceneChanged', { scene: d.sceneName })
    );
    this.obs.on('RecordStateChanged', (d) =>
      this.emit('recordStateChanged', { active: d.outputActive, state: d.outputState, path: d.outputPath })
    );
    this.obs.on('StreamStateChanged', (d) =>
      this.emit('streamStateChanged', { active: d.outputActive, state: d.outputState })
    );
  }

  async connect() {
    this.stopping = false;
    try {
      const { obsWebSocketVersion, negotiatedRpcVersion } = await this.obs.connect(
        this.url,
        this.password,
        { rpcVersion: 1 }
      );
      this.connected = true;
      this.version = { obsWebSocketVersion, rpcVersion: negotiatedRpcVersion };
      log.info('connected to obs', this.version);
      this.emit('connected', this.version);
      return this.version;
    } catch (err) {
      this.connected = false;
      log.warn('obs connect failed', { url: this.url, error: err.message });
      this.emit('disconnected', { error: err.message });
      this.#scheduleReconnect();
      throw err;
    }
  }

  /**
   * Connect without throwing when OBS is simply not there.
   *
   * Used at startup: OBS being absent is a normal state for a headless host and must not stop
   * the rest of the service from coming up.
   */
  async connectOptional() {
    try {
      return await this.connect();
    } catch {
      return null;
    }
  }

  #onClosed() {
    if (!this.connected) return;
    this.connected = false;
    log.warn('obs connection closed');
    this.emit('disconnected', {});
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (!this.autoReconnect || this.stopping || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopping) return;
      try {
        await this.connect();
      } catch {
        /* connect() has already scheduled the next attempt */
      }
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref?.();
  }

  #require() {
    if (!this.connected) throw new Error('not connected to OBS');
  }

  async getScenes() {
    this.#require();
    const { scenes, currentProgramSceneName } = await this.obs.call('GetSceneList');
    return { current: currentProgramSceneName, scenes: scenes.map((s) => s.sceneName) };
  }

  async setScene(sceneName) {
    this.#require();
    await this.obs.call('SetCurrentProgramScene', { sceneName });
    return { scene: sceneName };
  }

  async startRecord() {
    this.#require();
    await this.obs.call('StartRecord');
    return { recording: true };
  }

  /** Stops recording and returns the file OBS wrote, so it can be logged with the session. */
  async stopRecord() {
    this.#require();
    const { outputPath } = await this.obs.call('StopRecord');
    return { recording: false, outputPath };
  }

  async startStream() {
    this.#require();
    await this.obs.call('StartStream');
    return { streaming: true };
  }

  async stopStream() {
    this.#require();
    await this.obs.call('StopStream');
    return { streaming: false };
  }

  /**
   * Set the text of a text source, the OBS-side equivalent of the burned-in overlay.
   *
   * The input kind differs by platform: OBS on Linux builds the FreeType2 text source, while
   * Windows builds GDI+. A caller that hard-codes one of them works on the machine it was
   * written on and fails on the other.
   */
  async setTextSource(inputName, text) {
    this.#require();
    await this.obs.call('SetInputSettings', { inputName, inputSettings: { text: String(text) } });
    return { inputName, text };
  }

  /** Current output health, useful as a telemetry sample alongside the encoder's own. */
  async getStatus() {
    this.#require();
    const [record, stream, stats] = await Promise.all([
      this.obs.call('GetRecordStatus'),
      this.obs.call('GetStreamStatus'),
      this.obs.call('GetStats'),
    ]);
    return {
      recording: record.outputActive,
      recordDurationMs: record.outputDuration,
      streaming: stream.outputActive,
      streamSkippedFrames: stream.outputSkippedFrames,
      cpuUsage: stats.cpuUsage,
      renderSkippedFrames: stats.renderSkippedFrames,
      outputSkippedFrames: stats.outputSkippedFrames,
    };
  }

  async disconnect() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.connected) await this.obs.disconnect();
    this.connected = false;
    log.info('disconnected from obs');
  }
}
