import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeIncoming,
  underRoot,
  expandVars,
  resolveRoot,
  isCaseInsensitive,
} from '../src/platform/paths.js';

test('normalizeIncoming converts a Windows path for use on Linux', () => {
  const result = normalizeIncoming('C:\\media\\clips\\take1.mp4');
  assert.equal(result, 'media/clips/take1.mp4');
});

test('normalizeIncoming strips a UNC prefix', () => {
  assert.equal(normalizeIncoming('\\\\server\\share\\clip.mp4'), 'share/clip.mp4');
});

test('normalizeIncoming leaves a POSIX path alone', () => {
  assert.equal(normalizeIncoming('/srv/media/take1.mp4'), '/srv/media/take1.mp4');
});

test('normalizeIncoming does not mangle a backslash in a Linux filename', () => {
  // A backslash is a legal character in a POSIX filename. Rewriting every backslash would
  // silently rename files whose names happen to contain one.
  assert.equal(normalizeIncoming('weird\\name.mp4'), 'weird\\name.mp4');
});

test('expandVars substitutes variables and honours defaults', () => {
  process.env.LIVEREEL_TEST_VAR = 'from-env';
  assert.equal(expandVars('${LIVEREEL_TEST_VAR}/x'), 'from-env/x');
  assert.equal(expandVars('${LIVEREEL_ABSENT:-fallback}/x'), 'fallback/x');
  assert.equal(expandVars('${LIVEREEL_ABSENT}/x'), '/x');
  delete process.env.LIVEREEL_TEST_VAR;
});

test('resolveRoot picks the entry for the current platform', () => {
  const roots = { media: { linux: '/srv/media', win32: 'D:\\media' } };
  const expected = process.platform === 'win32' ? 'D:\\media' : '/srv/media';
  assert.equal(resolveRoot(roots, 'media'), path.resolve(expected));
});

test('resolveRoot accepts a single string for both platforms', () => {
  assert.equal(resolveRoot({ media: '/srv/media' }, 'media'), path.resolve('/srv/media'));
});

test('resolveRoot rejects an unknown root', () => {
  assert.throws(() => resolveRoot({}, 'nope'), /unknown path root/);
});

test('underRoot joins a relative path under the root', () => {
  const roots = { media: '/srv/media' };
  assert.equal(underRoot(roots, 'media', 'session/clip.mp4'), path.resolve('/srv/media/session/clip.mp4'));
});

test('underRoot rejects traversal out of the root', () => {
  const roots = { media: '/srv/media' };
  assert.throws(() => underRoot(roots, 'media', '../../etc/passwd'), /escapes root/);
  assert.throws(() => underRoot(roots, 'media', 'a/../../../etc/passwd'), /escapes root/);
});

test('underRoot rejects a Windows absolute path arriving from a client', () => {
  // The Windows path is normalised to a relative one first, so this proves containment
  // holds for the shape a Windows-era client would send.
  const roots = { media: '/srv/media' };
  const resolved = underRoot(roots, 'media', 'C:\\windows\\system32\\drivers\\etc\\hosts');
  assert.ok(resolved.startsWith(path.resolve('/srv/media')));
});

test('isCaseInsensitive reports a boolean for a writable directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livereel-case-'));
  const result = isCaseInsensitive(dir);
  assert.ok(result === true || result === false);
  fs.rmSync(dir, { recursive: true, force: true });
});
