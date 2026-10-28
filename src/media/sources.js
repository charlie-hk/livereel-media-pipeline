/**
 * Capture source definitions.
 *
 * Capture is where a Windows media app is least portable. The same webcam is
 * `-f dshow -i video="Integrated Camera"` on Windows and `-f v4l2 -i /dev/video0` on Linux;
 * the same screen grab is `gdigrab` against `desktop` or `x11grab` against `:0.0`. These are
 * not cosmetic differences, so a source is declared by intent and each platform builds its
 * own input arguments.
 */

import { isWindows } from '../platform/paths.js';

/**
 * @typedef {object} SourceSpec
 * @property {'camera'|'screen'|'file'|'network'|'test'} type
 * @property {string} [device]     camera name on Windows, /dev/videoN on Linux
 * @property {string} [display]    X display or ":0.0+x,y" for a region
 * @property {string} [url]        file path or network url
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [fps]
 * @property {boolean} [loop]
 */

/**
 * Turn a source spec into FFmpeg input arguments.
 * @param {SourceSpec} spec
 * @returns {string[]}
 */
export function buildInputArgs(spec) {
  const fps = spec.fps ?? 30;
  const size = spec.width && spec.height ? `${spec.width}x${spec.height}` : null;

  switch (spec.type) {
    case 'camera':
      if (isWindows) {
        if (!spec.device) throw new Error('camera source needs a device name on Windows');
        return [
          '-f',
          'dshow',
          '-framerate',
          String(fps),
          ...(size ? ['-video_size', size] : []),
          // dshow addresses devices by their friendly name, which `ffmpeg -list_devices true
          // -f dshow -i dummy` prints. It is not stable across machines.
          '-i',
          `video=${spec.device}`,
        ];
      }
      return [
        '-f',
        'v4l2',
        '-framerate',
        String(fps),
        ...(size ? ['-video_size', size] : []),
        // v4l2 addresses devices by node. /dev/video0 is not guaranteed to be the same camera
        // across reboots; a by-id symlink from udev is the stable form.
        '-i',
        spec.device ?? '/dev/video0',
      ];

    case 'screen':
      if (isWindows) {
        return [
          '-f',
          'gdigrab',
          '-framerate',
          String(fps),
          ...(size ? ['-video_size', size] : []),
          '-i',
          spec.device ?? 'desktop',
        ];
      }
      // x11grab needs an X display, so a headless systemd service either grabs from kmsgrab
      // (requires CAP_SYS_ADMIN) or does not grab the screen at all. Worth failing loudly.
      if (!process.env.DISPLAY && !spec.display) {
        throw new Error('screen capture on Linux needs DISPLAY or an explicit display in config');
      }
      return [
        '-f',
        'x11grab',
        '-framerate',
        String(fps),
        ...(size ? ['-video_size', size] : []),
        '-i',
        spec.display ?? process.env.DISPLAY,
      ];

    case 'file':
      if (!spec.url) throw new Error('file source needs a url');
      return [
        ...(spec.loop ? ['-stream_loop', '-1'] : []),
        // Read at native rate so a file behaves like a live source rather than encoding as
        // fast as the CPU allows.
        '-re',
        '-i',
        spec.url,
      ];

    case 'network':
      if (!spec.url) throw new Error('network source needs a url');
      return [
        // Keep a live network source from stalling the pipeline forever on a dead peer.
        '-rw_timeout',
        '5000000',
        '-i',
        spec.url,
      ];

    case 'test':
      return [
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${size ?? '1280x720'}:rate=${fps}`,
      ];

    default:
      throw new Error(`unknown source type: ${spec.type}`);
  }
}

/** A short human label for logs and session records. */
export function describeSource(spec) {
  switch (spec.type) {
    case 'camera':
      return `camera(${spec.device ?? (isWindows ? 'default' : '/dev/video0')})`;
    case 'screen':
      return `screen(${spec.display ?? spec.device ?? 'desktop'})`;
    case 'file':
      return `file(${spec.url})`;
    case 'network':
      return `network(${spec.url})`;
    case 'test':
      return 'test';
    default:
      return spec.type;
  }
}
