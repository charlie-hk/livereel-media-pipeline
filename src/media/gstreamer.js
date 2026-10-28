/**
 * GStreamer pipeline construction and supervision.
 *
 * GStreamer sits alongside FFmpeg here rather than replacing it. FFmpeg is the better tool
 * for a fixed transcode; GStreamer earns its place where the pipeline is a graph that has to
 * stay up — a tee feeding a recording branch and a preview branch at once, or a capture that
 * must survive a source dropping out.
 *
 * Elements are probed with `gst-inspect-1.0` before use. A plugin being installed is not a
 * given: `nvh264enc` ships in the bad plugins set and needs the NVIDIA codec headers at
 * build time, so on a stock Ubuntu it is usually absent even with a working card.
 */

import { EventEmitter } from 'node:events';
import { SupervisedProcess, run } from '../platform/process.js';
import { logger } from '../log.js';

const log = logger('gstreamer');

/** Encoder elements in the same preference order the FFmpeg probe uses. */
export const GST_H264_ENCODERS = [
  { element: 'nvh264enc', kind: 'hardware', vendor: 'nvidia', props: 'preset=low-latency-hq' },
  { element: 'qsvh264enc', kind: 'hardware', vendor: 'intel', props: '' },
  { element: 'vaapih264enc', kind: 'hardware', vendor: 'vaapi', props: '' },
  { element: 'x264enc', kind: 'software', vendor: 'cpu', props: 'tune=zerolatency speed-preset=veryfast' },
];

/**
 * Ask GStreamer which of the given elements it can actually load.
 *
 * `gst-inspect-1.0 <element>` exits non-zero when the element is not registered, which is a
 * cheaper and more honest answer than scanning the plugin directory.
 */
export async function probeElements(elements, { inspectPath = 'gst-inspect-1.0' } = {}) {
  const available = [];
  for (const element of elements) {
    const name = typeof element === 'string' ? element : element.element;
    const result = await run(inspectPath, [name], { timeoutMs: 10_000 });
    if (result.ok) available.push(name);
  }
  return available;
}

/** Pick the best available H.264 encoder element, or null when GStreamer is not installed. */
export async function selectGstEncoder({ inspectPath = 'gst-inspect-1.0' } = {}) {
  const probe = await run(inspectPath, ['--version'], { timeoutMs: 8000 });
  if (!probe.ok) {
    log.info('gstreamer not available on this host');
    return null;
  }

  for (const candidate of GST_H264_ENCODERS) {
    const result = await run(inspectPath, [candidate.element], { timeoutMs: 10_000 });
    if (result.ok) {
      log.info('selected gstreamer encoder', { element: candidate.element, kind: candidate.kind });
      return candidate;
    }
  }
  return null;
}

/**
 * Build a pipeline description string.
 *
 * The `tee` is the reason to use GStreamer at all for this: one capture, decoded once,
 * feeding several branches. Each branch gets its own queue, which is not optional — without
 * one, every branch runs on the source's thread and the slowest branch stalls the others,
 * which shows up as the recording stuttering whenever a preview client connects.
 */
export function buildPipeline({ source, encoder, branches, width = 1280, height = 720, fps = 30 }) {
  const parts = [];

  switch (source.type) {
    case 'test':
      parts.push(`videotestsrc is-live=true pattern=${source.pattern ?? 'smpte'}`);
      break;
    case 'camera':
      parts.push(`v4l2src device=${source.device ?? '/dev/video0'}`);
      break;
    case 'file':
      // A file source needs decoding before it can be re-encoded, and decodebin picks the
      // decoder at runtime from the actual content rather than from the extension.
      parts.push(`filesrc location=${source.url} ! decodebin`);
      break;
    default:
      throw new Error(`unsupported gstreamer source: ${source.type}`);
  }

  parts.push(`video/x-raw,width=${width},height=${height},framerate=${fps}/1`);
  parts.push('videoconvert');

  if (branches.length === 1) {
    parts.push(...branchElements(branches[0], encoder));
    return parts.join(' ! ');
  }

  // Multiple branches: name the tee and attach each branch to it by name.
  const head = [...parts, 'tee name=t'].join(' ! ');
  const tails = branches.map((branch, index) => {
    const queue = `queue name=q${index} max-size-buffers=${branch.maxBuffers ?? 200} leaky=${branch.leaky ?? 'downstream'}`;
    return ['t.', queue, ...branchElements(branch, encoder)].join(' ! ');
  });

  return [head, ...tails].join(' ');
}

function branchElements(branch, encoder) {
  const encode = () => {
    if (!encoder) throw new Error('no gstreamer H.264 encoder available');
    return encoder.props ? `${encoder.element} ${encoder.props}` : encoder.element;
  };

  switch (branch.type) {
    case 'file':
      return [encode(), 'h264parse', 'mp4mux', `filesink location=${branch.path}`];
    case 'rtmp':
      return [encode(), 'h264parse', 'flvmux streamable=true', `rtmpsink location=${branch.url}`];
    case 'udp':
      return [
        encode(),
        'h264parse',
        'rtph264pay config-interval=1',
        `udpsink host=${branch.host} port=${branch.port}`,
      ];
    case 'preview':
      // No encoding: a raw preview is what the local operator sees.
      return ['videoconvert', 'autovideosink sync=false'];
    case 'null':
      return [encode(), 'fakesink sync=false'];
    default:
      throw new Error(`unknown gstreamer branch: ${branch.type}`);
  }
}

/**
 * A running GStreamer pipeline.
 *
 * Emits: `start`, `message`, `exit`, `restart`, `giveup`.
 */
export class GstPipeline extends EventEmitter {
  constructor({ id, description, gstPath = 'gst-launch-1.0', restart }) {
    super();
    this.id = id;
    this.description = description;
    this.gstPath = gstPath;
    this.restartPolicy = restart;
    this.process = null;
    this.log = log.child(id);
  }

  start() {
    // `-e` makes gst-launch send EOS on interrupt instead of dropping the pipeline, so a
    // recording branch writes its container index and the file stays playable.
    const args = ['-e', ...this.description.split(' ').filter(Boolean)];

    this.log.info('starting pipeline', { description: this.description });

    this.process = new SupervisedProcess({
      name: `gst:${this.id}`,
      command: this.gstPath,
      args,
      // gst-launch has no stdin command interface; EOS on SIGINT is its clean exit, which is
      // what `-e` above arranges.
      gracefulStop: 'sigint',
      restart: this.restartPolicy ?? {
        enabled: true,
        maxRetries: 10,
        baseDelayMs: 1000,
        maxDelayMs: 30_000,
      },
    });

    this.process.on('stdout', (line) => {
      this.emit('message', line);
      if (/ERROR|WARN/i.test(line)) this.log.warn('gst', { line });
    });
    this.process.on('stderr', (line) => {
      this.emit('message', line);
      this.log.warn('gst', { line });
    });
    this.process.on('start', (info) => this.emit('start', { ...info, description: this.description }));
    this.process.on('exit', (info) => this.emit('exit', info));
    this.process.on('restart', (info) => this.emit('restart', info));
    this.process.on('giveup', (info) => this.emit('giveup', info));

    this.process.start();
    return this;
  }

  async stop() {
    const result = this.process ? await this.process.stop() : { stoppedBy: 'not-running' };
    this.log.info('pipeline stopped', result);
    return result;
  }

  get running() {
    return this.process?.running ?? false;
  }
}
