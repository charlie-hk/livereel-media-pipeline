/**
 * Dynamic metadata compositing.
 *
 * The overlay text in a live session changes while the session runs: a scoreboard, a speaker
 * name, a timer. Restarting FFmpeg for each change would break the output, and FFmpeg's
 * filter graph is fixed once the process starts.
 *
 * The way through is drawtext's `textfile` plus `reload=1`: FFmpeg re-reads the file every
 * frame, so writing the file changes what is burned in. The catch is that a frame can land
 * mid-write and composite half a line. Writing to a temporary file in the same directory and
 * renaming over the target avoids it, because rename is atomic within a filesystem, so the
 * filter either sees the old content or the new one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../platform/paths.js';
import { logger } from '../log.js';

const log = logger('overlay');

export class MetadataOverlay {
  /**
   * @param {object} options
   * @param {string} options.directory  where the text files live, readable by the FFmpeg process
   * @param {string} [options.name]     file name stem
   */
  constructor({ directory, name = 'overlay' }) {
    this.directory = ensureDir(directory);
    this.file = path.join(this.directory, `${name}.txt`);
    this.current = '';
    this.writes = 0;
    // Written once up front: drawtext with reload=1 logs an error for every frame where the
    // file is missing, which floods the log before the first update arrives.
    this.set('');
  }

  /**
   * Replace the overlay text. Returns false if the text is unchanged, so a client polling at
   * 10 Hz does not cause 10 writes a second for nothing.
   */
  set(text) {
    const value = String(text ?? '');
    if (value === this.current && this.writes > 0) return false;

    const temp = path.join(this.directory, `.${path.basename(this.file)}.${process.pid}.tmp`);
    try {
      // drawtext reads the file as-is, so a trailing newline would render as a blank line.
      fs.writeFileSync(temp, value);
      fs.renameSync(temp, this.file);
      this.current = value;
      this.writes += 1;
      return true;
    } catch (err) {
      log.error('overlay write failed', { file: this.file, error: err.message });
      try {
        fs.unlinkSync(temp);
      } catch {
        /* nothing to clean up */
      }
      return false;
    }
  }

  /** Remove the overlay file once the session is done. */
  dispose() {
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Build a drawtext filter string for an overlay.
 *
 * Paths need escaping twice over: once for the filter-graph parser, which treats `:` as an
 * argument separator and `'` as a quote, and on Windows once more for the drive-letter colon
 * in `C:\path`. Getting this wrong produces "Unable to parse option value" at start time,
 * which is the single most common filter-graph error when moving a config between platforms.
 */
export function drawtextFilter({
  textfile,
  fontFile,
  fontSize = 36,
  fontColor = 'white',
  x = 32,
  y = 32,
  box = true,
  boxColor = 'black@0.5',
  boxBorder = 12,
}) {
  const parts = [
    `textfile=${escapeFilterPath(textfile)}`,
    'reload=1',
    `fontsize=${fontSize}`,
    `fontcolor=${fontColor}`,
    `x=${x}`,
    `y=${y}`,
  ];
  if (fontFile) parts.push(`fontfile=${escapeFilterPath(fontFile)}`);
  if (box) parts.push('box=1', `boxcolor=${boxColor}`, `boxborderw=${boxBorder}`);
  return `drawtext=${parts.join(':')}`;
}

/**
 * Escape a filesystem path for use inside a filter-graph argument.
 *
 * On Windows `C:\media\out.txt` becomes `C\:/media/out.txt`: forward slashes are accepted by
 * FFmpeg on Windows and avoid the backslash being read as an escape, while the drive colon
 * still has to be escaped so it is not taken as an option separator.
 */
export function escapeFilterPath(input) {
  return String(input)
    .split('\\')
    .join('/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}
