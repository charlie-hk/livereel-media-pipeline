/**
 * Encoder and decoder capability detection.
 *
 * `ffmpeg -encoders` lists what the binary was *compiled* with, which says nothing about
 * what this machine can actually run. A stock Ubuntu FFmpeg advertises h264_nvenc on a
 * laptop with no NVIDIA card at all, and h264_vaapi where /dev/dri does not exist. Trusting
 * that list is how a pipeline ends up failing at the first frame of a live session instead
 * of at startup.
 *
 * So every candidate is proved by encoding a few frames of a synthetic source and checking
 * the exit code. It costs about a second per candidate on first run and the result is
 * cached against the host's FFmpeg build and GPU inventory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { run } from '../platform/process.js';
import { baseDirs, ensureDir, isWindows, nullSink } from '../platform/paths.js';
import { logger } from '../log.js';

const log = logger('capabilities');

/**
 * Candidates in preference order: dedicated NVIDIA silicon first, then Intel Quick Sync,
 * then the generic Linux VAAPI path, then software as the one that always works.
 */
export const H264_CANDIDATES = [
  {
    name: 'h264_nvenc',
    kind: 'hardware',
    vendor: 'nvidia',
    // NVENC takes ordinary system-memory frames, so no upload filter is needed for a
    // software-decoded or synthetic source.
    args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll'],
  },
  {
    name: 'h264_qsv',
    kind: 'hardware',
    vendor: 'intel',
    args: ['-c:v', 'h264_qsv', '-preset', 'veryfast'],
  },
  {
    name: 'h264_vaapi',
    kind: 'hardware',
    vendor: 'vaapi',
    // VAAPI encodes from GPU surfaces, so frames have to be uploaded and the device named.
    deviceArgs: (device) => ['-vaapi_device', device],
    filter: 'format=nv12,hwupload',
    args: ['-c:v', 'h264_vaapi'],
    requiresDevice: true,
  },
  {
    name: 'libx264',
    kind: 'software',
    vendor: 'cpu',
    args: ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency'],
  },
];

const CACHE_VERSION = 2;

/**
 * Probe the host and return what it can really do.
 *
 * @param {object} [options]
 * @param {string} [options.ffmpegPath]
 * @param {boolean} [options.useCache]
 * @param {number} [options.cacheTtlMs]
 */
export async function probeCapabilities({
  ffmpegPath = 'ffmpeg',
  useCache = true,
  cacheTtlMs = 7 * 24 * 60 * 60 * 1000,
} = {}) {
  const fingerprint = await hostFingerprint(ffmpegPath);
  const cacheFile = path.join(ensureDir(baseDirs().cache), 'capabilities.json');

  if (useCache) {
    const cached = readCache(cacheFile, fingerprint, cacheTtlMs);
    if (cached) {
      log.debug('using cached capability probe', { probedAt: cached.probedAt });
      return cached;
    }
  }

  log.info('probing encoders', { ffmpeg: fingerprint.ffmpegVersion });

  const compiledIn = await listCompiledEncoders(ffmpegPath);
  const renderNodes = listRenderNodes();
  const results = [];

  for (const candidate of H264_CANDIDATES) {
    if (!compiledIn.has(candidate.name)) {
      results.push({ ...summarize(candidate), usable: false, reason: 'not compiled in' });
      continue;
    }

    if (candidate.requiresDevice && renderNodes.length === 0) {
      results.push({ ...summarize(candidate), usable: false, reason: 'no render node found' });
      continue;
    }

    const device = candidate.requiresDevice ? renderNodes[0] : undefined;
    const outcome = await trialEncode(ffmpegPath, candidate, device);

    results.push({
      ...summarize(candidate),
      usable: outcome.ok,
      device,
      reason: outcome.ok ? undefined : outcome.reason,
      probeMs: outcome.durationMs,
    });

    log[outcome.ok ? 'info' : 'debug'](
      outcome.ok ? 'encoder usable' : 'encoder unusable',
      { encoder: candidate.name, reason: outcome.reason, ms: outcome.durationMs }
    );
  }

  const report = {
    cacheVersion: CACHE_VERSION,
    probedAt: new Date().toISOString(),
    fingerprint,
    renderNodes,
    encoders: results,
    hwaccels: await listHwaccels(ffmpegPath),
  };

  if (useCache) writeCache(cacheFile, report);
  return report;
}

/**
 * Pick the encoder to use.
 *
 * `preference` may name an encoder explicitly. If that one is not usable the choice falls
 * through the chain rather than failing, and the caller is told it was a fallback so the
 * substitution shows up in the session record instead of being silently absorbed.
 */
export function selectEncoder(report, preference = 'auto') {
  const usable = report.encoders.filter((e) => e.usable);
  if (usable.length === 0) {
    throw new Error('no usable H.264 encoder on this host');
  }

  if (preference !== 'auto') {
    const wanted = usable.find((e) => e.name === preference);
    if (wanted) return { ...wanted, fellBack: false };

    const why = report.encoders.find((e) => e.name === preference)?.reason ?? 'unknown encoder';
    const chosen = usable[0];
    log.warn('requested encoder unavailable, falling back', {
      requested: preference,
      reason: why,
      chosen: chosen.name,
    });
    return { ...chosen, fellBack: true, requested: preference, fallbackReason: why };
  }

  return { ...usable[0], fellBack: false };
}

/** Encode a few frames of a synthetic source; the exit code is the verdict. */
async function trialEncode(ffmpegPath, candidate, device) {
  const started = Date.now();

  const args = [
    '-hide_banner',
    '-nostdin',
    ...(candidate.deviceArgs && device ? candidate.deviceArgs(device) : []),
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=30',
    '-frames:v',
    '3',
  ];
  if (candidate.filter) args.push('-vf', candidate.filter);
  args.push(...candidate.args, '-f', 'null', nullSink);

  const result = await run(ffmpegPath, args, { timeoutMs: 20_000 });
  const durationMs = Date.now() - started;

  if (result.ok) return { ok: true, durationMs };

  return {
    ok: false,
    durationMs,
    reason: result.timedOut ? 'probe timed out' : firstError(result.stderr) ?? `exit ${result.code}`,
  };
}

/** Pull the most informative line out of FFmpeg's stderr. */
function firstError(stderr = '') {
  const lines = stderr.split(/\r?\n/).filter(Boolean);
  const interesting = lines.find((l) =>
    /error|cannot|failed|not (found|supported|available)|no such|invalid/i.test(l)
  );
  return (interesting ?? lines.at(-1))?.trim().slice(0, 200);
}

async function listCompiledEncoders(ffmpegPath) {
  const result = await run(ffmpegPath, ['-hide_banner', '-encoders']);
  const names = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*[A-Z.]{6}\s+(\S+)/);
    if (match) names.add(match[1]);
  }
  return names;
}

async function listHwaccels(ffmpegPath) {
  const result = await run(ffmpegPath, ['-hide_banner', '-hwaccels']);
  return result.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** VAAPI needs a render node; on Windows there is no equivalent to enumerate. */
function listRenderNodes() {
  if (isWindows) return [];
  try {
    return fs
      .readdirSync('/dev/dri')
      .filter((name) => name.startsWith('renderD'))
      .map((name) => `/dev/dri/${name}`)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Identify the host closely enough that the cache invalidates when something real changes:
 * a different FFmpeg build, a driver update, a card added or removed.
 */
async function hostFingerprint(ffmpegPath) {
  const version = await run(ffmpegPath, ['-hide_banner', '-version']);
  const ffmpegVersion = version.stdout.split(/\r?\n/)[0]?.trim() ?? 'unknown';

  let gpus = [];
  let driver = null;
  const smi = await run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], {
    timeoutMs: 8000,
  });
  if (smi.ok) {
    gpus = smi.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    driver = gpus[0]?.split(',').pop()?.trim() ?? null;
  }

  return { platform: process.platform, ffmpegVersion, gpus, nvidiaDriver: driver };
}

function readCache(file, fingerprint, ttlMs) {
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cached.cacheVersion !== CACHE_VERSION) return null;
    if (JSON.stringify(cached.fingerprint) !== JSON.stringify(fingerprint)) return null;
    if (Date.now() - new Date(cached.probedAt).getTime() > ttlMs) return null;
    return cached;
  } catch {
    return null;
  }
}

function writeCache(file, report) {
  try {
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
  } catch (err) {
    log.warn('could not write capability cache', { error: err.message });
  }
}

/**
 * The parts of a candidate that survive into the report and the cache.
 *
 * The encoder arguments travel with the result rather than being looked up again by name at
 * build time: the report is what gets cached, logged and written into the session record, so
 * everything needed to reproduce the command has to be in it.
 */
function summarize(candidate) {
  return {
    name: candidate.name,
    kind: candidate.kind,
    vendor: candidate.vendor,
    args: candidate.args,
    filter: candidate.filter,
  };
}
