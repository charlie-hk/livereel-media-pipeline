/**
 * FFmpeg pipeline construction and supervision.
 *
 * A session is built from three parts: a source (sources.js), a filter graph, and one or
 * more outputs. The encoder is not hard-coded; it comes from the capability probe, and the
 * filter graph adapts to it, because a VAAPI encode needs its frames uploaded to the GPU
 * while NVENC and libx264 take them from system memory.
 *
 * Progress is read from `-progress pipe:1`, which emits `key=value` lines on stdout. Parsing
 * the stderr banner instead, as the original Windows build did, means re-parsing a format
 * that changes between FFmpeg releases and that mixes progress with warnings.
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { SupervisedProcess } from '../platform/process.js';
import { buildInputArgs, describeSource } from './sources.js';
import { MetadataOverlay, drawtextFilter } from './overlay.js';
import { ensureDir, isWindows } from '../platform/paths.js';
import { logger } from '../log.js';

const log = logger('ffmpeg');

/**
 * Build the video filter chain.
 *
 * Order matters. Scaling before the overlay keeps text crisp at the output resolution rather
 * than scaling the burned-in text with the picture, and the hardware upload has to be last
 * because once frames are GPU surfaces, software filters can no longer touch them.
 *
 * @returns {string} a filter chain usable as `-vf`
 */
export function buildFilterChain({ width, height, fps, overlay, encoder, extraFilters = [] }) {
  const chain = [];

  if (width && height) {
    // force_original_aspect_ratio + pad keeps a 4:3 camera from being stretched into 16:9.
    chain.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`);
    chain.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`);
  }
  if (fps) chain.push(`fps=${fps}`);

  chain.push(...extraFilters);

  if (overlay) chain.push(drawtextFilter(overlay));

  // VAAPI encodes from GPU surfaces. Everything above runs in software, so the upload is the
  // last step; NVENC and libx264 read system memory and need no upload at all.
  if (encoder?.name === 'h264_vaapi') chain.push('format=nv12', 'hwupload');

  return chain.join(',');
}

/**
 * Build output arguments for one target.
 *
 * The container choice is not cosmetic for a live recording. A plain MP4 keeps its index in
 * memory and writes it on close, so a power cut leaves an unplayable file; fragmented MP4
 * writes as it goes and survives, at the cost of a slightly larger file.
 */
export function buildOutputArgs(target, encoder, { bitrate = '4M', gopSeconds = 2, fps = 30 } = {}) {
  const gop = Math.max(1, Math.round(gopSeconds * fps));

  const common = [
    ...encoder.args,
    '-b:v',
    bitrate,
    '-maxrate',
    bitrate,
    '-bufsize',
    doubleBitrate(bitrate),
    '-g',
    String(gop),
    // Closed GOP with no scene-cut keyframes: segment boundaries stay predictable, which
    // matters for HLS and for any downstream cutting.
    '-sc_threshold',
    '0',
    '-pix_fmt',
    encoder.name === 'h264_vaapi' ? 'vaapi_vld' : 'yuv420p',
  ];

  switch (target.type) {
    case 'file': {
      ensureDir(path.dirname(target.path));
      const fragmented = target.fragmented !== false;
      return [
        ...common,
        ...(target.audio === false ? ['-an'] : ['-c:a', 'aac', '-b:a', '128k']),
        ...(fragmented
          ? ['-movflags', '+frag_keyframe+empty_moov+default_base_moof']
          : ['-movflags', '+faststart']),
        '-f',
        'mp4',
        target.path,
      ];
    }

    case 'rtmp':
      return [
        ...common,
        ...(target.audio === false ? ['-an'] : ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100']),
        '-f',
        'flv',
        target.url,
      ];

    case 'srt':
      return [
        ...common,
        ...(target.audio === false ? ['-an'] : ['-c:a', 'aac', '-b:a', '128k']),
        '-f',
        'mpegts',
        target.url,
      ];

    case 'hls': {
      ensureDir(target.directory);
      return [
        ...common,
        ...(target.audio === false ? ['-an'] : ['-c:a', 'aac', '-b:a', '128k']),
        '-f',
        'hls',
        '-hls_time',
        String(target.segmentSeconds ?? gopSeconds),
        '-hls_list_size',
        String(target.playlistLength ?? 6),
        '-hls_flags',
        'delete_segments+append_list',
        '-hls_segment_filename',
        path.join(target.directory, 'segment_%05d.ts'),
        path.join(target.directory, 'index.m3u8'),
      ];
    }

    case 'null':
      // Used by smoke tests: everything runs, nothing is written.
      return [...common, '-an', '-f', 'null', '-'];

    default:
      throw new Error(`unknown output target: ${target.type}`);
  }
}

/**
 * A running FFmpeg session.
 *
 * Emits: `start`, `progress`, `log`, `exit`, `restart`, `giveup`.
 */
export class FfmpegSession extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.id
   * @param {import('./sources.js').SourceSpec} options.source
   * @param {object[]} options.outputs
   * @param {object} options.encoder   from selectEncoder()
   * @param {object} [options.video]   { width, height, fps, bitrate, gopSeconds }
   * @param {object} [options.overlay] { directory, fontFile, ... } enables dynamic metadata
   * @param {string} [options.ffmpegPath]
   * @param {object} [options.restart]
   */
  constructor(options) {
    super();
    this.id = options.id;
    this.options = options;
    this.encoder = options.encoder;
    this.overlay = options.overlay
      ? new MetadataOverlay({ directory: options.overlay.directory, name: options.id })
      : null;
    this.process = null;
    this.progress = {};
    this.startedAt = null;
    this.log = log.child(options.id);
  }

  /** The exact argument list, exposed so it can be logged, tested, or copy-pasted to a shell. */
  buildArgs() {
    const { source, outputs, video = {}, overlay } = this.options;
    const fps = video.fps ?? source.fps ?? 30;

    const args = [
      '-hide_banner',
      // `-nostdin` keeps FFmpeg from swallowing the service's stdin, but it also disables the
      // keyboard handler that `q` goes through. So it is only safe where the graceful stop is
      // a signal instead: on Linux. On Windows a signal cannot be delivered to a child, `q`
      // is the only way to finish cleanly, and the keyboard handler has to stay enabled.
      ...(isWindows ? [] : ['-nostdin']),
      '-loglevel',
      'warning',
      // Machine-readable progress on stdout; stderr is left for genuine warnings.
      '-progress',
      'pipe:1',
      '-nostats',
    ];

    if (this.encoder.name === 'h264_vaapi' && this.encoder.device) {
      args.push('-vaapi_device', this.encoder.device);
    }

    args.push(...buildInputArgs(source));

    const chain = buildFilterChain({
      width: video.width,
      height: video.height,
      fps,
      encoder: this.encoder,
      extraFilters: video.filters ?? [],
      overlay: overlay
        ? { ...overlay, textfile: this.overlay.file }
        : null,
    });
    if (chain) args.push('-vf', chain);

    for (const target of outputs) {
      args.push(
        ...buildOutputArgs(target, this.encoder, {
          bitrate: video.bitrate ?? '4M',
          gopSeconds: video.gopSeconds ?? 2,
          fps,
        })
      );
    }

    return args;
  }

  start() {
    const args = this.buildArgs();
    this.startedAt = Date.now();

    this.log.info('starting session', {
      source: describeSource(this.options.source),
      encoder: this.encoder.name,
      hardware: this.encoder.kind === 'hardware',
      outputs: this.options.outputs.map((o) => o.type),
    });

    this.process = new SupervisedProcess({
      name: `ffmpeg:${this.id}`,
      command: this.options.ffmpegPath ?? 'ffmpeg',
      args,
      // Resolved per platform by the supervisor, in step with the `-nostdin` decision above.
      gracefulStop: 'auto',
      restart: this.options.restart ?? {
        enabled: true,
        maxRetries: 10,
        baseDelayMs: 1000,
        maxDelayMs: 30_000,
      },
    });

    this.process.on('stdout', (line) => this.#onProgressLine(line));
    this.process.on('stderr', (line) => {
      this.log.warn('ffmpeg', { line });
      this.emit('log', line);
    });
    this.process.on('start', (info) => this.emit('start', { ...info, args }));
    this.process.on('exit', (info) => this.emit('exit', info));
    this.process.on('restart', (info) => this.emit('restart', info));
    this.process.on('giveup', (info) => this.emit('giveup', info));

    this.process.start();
    return this;
  }

  async stop() {
    const result = this.process ? await this.process.stop() : { stoppedBy: 'not-running' };
    this.overlay?.dispose();
    this.log.info('session stopped', result);
    return result;
  }

  /** Update the burned-in overlay text without touching the running process. */
  setOverlayText(text) {
    if (!this.overlay) throw new Error('this session was started without an overlay');
    return this.overlay.set(text);
  }

  get running() {
    return this.process?.running ?? false;
  }

  /**
   * `-progress` emits a block of key=value lines terminated by `progress=continue` or
   * `progress=end`, so values are accumulated and published once per block.
   */
  #onProgressLine(line) {
    const index = line.indexOf('=');
    if (index === -1) return;

    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    this.progress[key] = value;

    if (key !== 'progress') return;

    const snapshot = {
      sessionId: this.id,
      frame: Number(this.progress.frame ?? 0),
      fps: Number(this.progress.fps ?? 0),
      bitrateKbps: parseBitrate(this.progress.bitrate),
      outTimeMs: Math.round(Number(this.progress.out_time_us ?? 0) / 1000),
      totalSizeBytes: Number(this.progress.total_size ?? 0),
      droppedFrames: Number(this.progress.drop_frames ?? 0),
      dupFrames: Number(this.progress.dup_frames ?? 0),
      // speed < 1.0 on a live source means the encoder cannot keep up and frames are being
      // dropped at the capture end: the number worth alerting on.
      speed: parseSpeed(this.progress.speed),
      encoder: this.encoder.name,
      ended: value === 'end',
    };

    this.emit('progress', snapshot);
    this.progress = {};
  }
}

function parseBitrate(value) {
  if (!value || value === 'N/A') return null;
  const match = String(value).match(/([\d.]+)\s*kbits\/s/);
  return match ? Number(match[1]) : null;
}

function parseSpeed(value) {
  if (!value || value === 'N/A') return null;
  const match = String(value).match(/([\d.]+)x/);
  return match ? Number(match[1]) : null;
}

function doubleBitrate(bitrate) {
  const match = String(bitrate).match(/^([\d.]+)([KkMm])$/);
  if (!match) return bitrate;
  return `${Number(match[1]) * 2}${match[2]}`;
}
