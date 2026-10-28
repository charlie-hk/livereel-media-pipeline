import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFilterChain, buildOutputArgs } from '../src/media/ffmpeg.js';
import { MetadataOverlay, escapeFilterPath, drawtextFilter } from '../src/media/overlay.js';
import { selectEncoder } from '../src/media/capabilities.js';
import { buildPipeline } from '../src/media/gstreamer.js';
import { buildInputArgs } from '../src/media/sources.js';

const x264 = { name: 'libx264', kind: 'software', args: ['-c:v', 'libx264'] };
const nvenc = { name: 'h264_nvenc', kind: 'hardware', args: ['-c:v', 'h264_nvenc'] };
const vaapi = { name: 'h264_vaapi', kind: 'hardware', args: ['-c:v', 'h264_vaapi'] };

test('filter chain scales and pads before overlaying', () => {
  const chain = buildFilterChain({ width: 1280, height: 720, fps: 30, encoder: x264 });
  const parts = chain.split(',');
  assert.ok(parts[0].startsWith('scale=1280:720'));
  assert.ok(parts[1].startsWith('pad=1280:720'));
  assert.ok(chain.includes('fps=30'));
});

test('VAAPI uploads to the GPU as the last step of the chain', () => {
  const chain = buildFilterChain({
    width: 1280,
    height: 720,
    encoder: vaapi,
    overlay: { textfile: '/tmp/o.txt' },
  });
  assert.ok(chain.endsWith('format=nv12,hwupload'), chain);
  // The overlay must come before the upload: once frames are GPU surfaces, drawtext can no
  // longer touch them.
  assert.ok(chain.indexOf('drawtext') < chain.indexOf('hwupload'));
});

test('NVENC and software encoders get no hardware upload', () => {
  for (const encoder of [x264, nvenc]) {
    const chain = buildFilterChain({ width: 640, height: 360, encoder });
    assert.ok(!chain.includes('hwupload'), `${encoder.name} should not upload`);
  }
});

test('a file output defaults to fragmented mp4 so a crash leaves a playable file', () => {
  const args = buildOutputArgs(
    { type: 'file', path: path.join(os.tmpdir(), 'x.mp4'), audio: false },
    x264
  );
  const movflags = args[args.indexOf('-movflags') + 1];
  assert.ok(movflags.includes('frag_keyframe'), movflags);
  assert.ok(movflags.includes('empty_moov'), movflags);
});

test('a file output can opt into faststart for a VOD file', () => {
  const args = buildOutputArgs(
    { type: 'file', path: path.join(os.tmpdir(), 'x.mp4'), fragmented: false, audio: false },
    x264
  );
  assert.equal(args[args.indexOf('-movflags') + 1], '+faststart');
});

test('GOP length is derived from the frame rate, not assumed', () => {
  const at30 = buildOutputArgs({ type: 'null' }, x264, { gopSeconds: 2, fps: 30 });
  const at60 = buildOutputArgs({ type: 'null' }, x264, { gopSeconds: 2, fps: 60 });
  assert.equal(at30[at30.indexOf('-g') + 1], '60');
  assert.equal(at60[at60.indexOf('-g') + 1], '120');
});

test('bufsize is twice the bitrate', () => {
  const args = buildOutputArgs({ type: 'null' }, x264, { bitrate: '6M' });
  assert.equal(args[args.indexOf('-bufsize') + 1], '12M');
});

test('an unknown output type is rejected rather than silently dropped', () => {
  assert.throws(() => buildOutputArgs({ type: 'carrier-pigeon' }, x264), /unknown output target/);
});

test('selectEncoder falls back and reports why', () => {
  const report = {
    encoders: [
      { name: 'h264_nvenc', usable: false, reason: 'Cannot load libcuda.so.1', args: [] },
      { name: 'libx264', usable: true, kind: 'software', args: ['-c:v', 'libx264'] },
    ],
  };
  const chosen = selectEncoder(report, 'h264_nvenc');
  assert.equal(chosen.name, 'libx264');
  assert.equal(chosen.fellBack, true);
  assert.equal(chosen.requested, 'h264_nvenc');
  assert.match(chosen.fallbackReason, /libcuda/);
});

test('selectEncoder honours an available preference without claiming a fallback', () => {
  const report = {
    encoders: [
      { name: 'h264_nvenc', usable: true, kind: 'hardware', args: [] },
      { name: 'libx264', usable: true, kind: 'software', args: [] },
    ],
  };
  const chosen = selectEncoder(report, 'h264_nvenc');
  assert.equal(chosen.name, 'h264_nvenc');
  assert.equal(chosen.fellBack, false);
});

test('selectEncoder throws when nothing is usable', () => {
  assert.throws(
    () => selectEncoder({ encoders: [{ name: 'libx264', usable: false }] }),
    /no usable H.264 encoder/
  );
});

test('escapeFilterPath escapes a Windows drive colon', () => {
  assert.equal(escapeFilterPath('C:\\media\\overlay.txt'), 'C\\:/media/overlay.txt');
});

test('escapeFilterPath escapes filter-graph metacharacters', () => {
  assert.equal(escapeFilterPath("/tmp/a,b[c]'d.txt"), "/tmp/a\\,b\\[c\\]\\'d.txt");
});

test('drawtext enables reload so the text can change while encoding', () => {
  const filter = drawtextFilter({ textfile: '/tmp/o.txt' });
  assert.ok(filter.includes('reload=1'), filter);
});

test('the overlay file is created immediately and updates atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livereel-overlay-'));
  const overlay = new MetadataOverlay({ directory: dir, name: 'test' });

  // Created up front: drawtext with reload=1 logs an error per frame while the file is
  // missing.
  assert.ok(fs.existsSync(overlay.file));

  assert.equal(overlay.set('first'), true);
  assert.equal(fs.readFileSync(overlay.file, 'utf8'), 'first');

  // No write when nothing changed, so a client polling fast does not thrash the file.
  assert.equal(overlay.set('first'), false);
  assert.equal(overlay.set('second'), true);
  assert.equal(fs.readFileSync(overlay.file, 'utf8'), 'second');

  // No temporary files left behind: a stray .tmp in the directory would be read by nothing
  // but would accumulate.
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);

  overlay.dispose();
  assert.ok(!fs.existsSync(overlay.file));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the overlay writes no trailing newline, which would render as a blank line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livereel-overlay-'));
  const overlay = new MetadataOverlay({ directory: dir, name: 'nl' });
  overlay.set('one line');
  assert.equal(fs.readFileSync(overlay.file, 'utf8'), 'one line');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a GStreamer tee gives every branch its own queue', () => {
  const description = buildPipeline({
    source: { type: 'test' },
    encoder: { element: 'x264enc', props: 'tune=zerolatency' },
    branches: [{ type: 'file', path: '/tmp/a.mp4' }, { type: 'null' }],
  });
  assert.ok(description.includes('tee name=t'));
  // Without a queue per branch, every branch runs on the source thread and the slowest one
  // stalls the rest.
  assert.ok(description.includes('queue name=q0'));
  assert.ok(description.includes('queue name=q1'));
});

test('a single-branch GStreamer pipeline needs no tee', () => {
  const description = buildPipeline({
    source: { type: 'test' },
    encoder: { element: 'x264enc', props: '' },
    branches: [{ type: 'null' }],
  });
  assert.ok(!description.includes('tee'));
});

test('buildPipeline refuses a branch that needs an encoder when none is available', () => {
  assert.throws(
    () =>
      buildPipeline({
        source: { type: 'test' },
        encoder: null,
        branches: [{ type: 'file', path: '/tmp/a.mp4' }],
      }),
    /no gstreamer H.264 encoder/
  );
});

test('capture sources use the right backend for the platform', () => {
  const args = buildInputArgs({ type: 'camera', device: process.platform === 'win32' ? 'Cam' : '/dev/video0' });
  const expected = process.platform === 'win32' ? 'dshow' : 'v4l2';
  assert.equal(args[args.indexOf('-f') + 1], expected);
});

test('a file source is read at native rate so it behaves like a live input', () => {
  const args = buildInputArgs({ type: 'file', url: '/tmp/in.mp4' });
  assert.ok(args.includes('-re'));
});

test('a network source sets a read timeout rather than hanging on a dead peer', () => {
  const args = buildInputArgs({ type: 'network', url: 'srt://example:9000' });
  assert.ok(args.includes('-rw_timeout'));
});
