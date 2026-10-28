/**
 * Configuration loading.
 *
 * One JSON file, with environment variables able to override the few values that differ per
 * deployment rather than per installation. Secrets come from the environment only: a systemd
 * unit can read them from a file with EnvironmentFile= and mode 0600, which is not something
 * a config file checked into a repository can offer.
 */

import fs from 'node:fs';
import path from 'node:path';
import { baseDirs, expandVars, isWindows } from './platform/paths.js';

export const DEFAULTS = {
  ffmpegPath: 'ffmpeg',
  gstLaunchPath: 'gst-launch-1.0',
  gstInspectPath: 'gst-inspect-1.0',

  control: {
    host: '127.0.0.1',
    port: 8787,
    token: null,
  },

  encoder: {
    // 'auto' takes the best usable encoder; naming one makes it a preference, not a demand:
    // an unusable choice falls back and the substitution is recorded.
    prefer: 'auto',
    probeCache: true,
  },

  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: '6M',
    gopSeconds: 2,
  },

  overlay: {
    enabled: true,
    fontSize: 36,
    fontColor: 'white',
    x: 48,
    y: 48,
    box: true,
    // Left null on purpose: FFmpeg's default font differs by platform and a path that exists
    // on one will not on the other. Set it explicitly for a consistent look.
    fontFile: null,
  },

  obs: {
    enabled: false,
    url: 'ws://127.0.0.1:4455',
    password: null,
    autoReconnect: true,
  },

  store: {
    driver: 'file',
    uri: 'mongodb://127.0.0.1:27017',
    database: 'livereel',
    telemetryTtlDays: 7,
    directory: null, // defaults to the platform state directory
  },

  paths: {
    // Logical roots, resolved per platform. The migration lives here: a config written for
    // Windows keeps working because the Linux side of each root is declared alongside it.
    roots: {
      recordings: {
        win32: '${USERPROFILE:-C:\\Users\\Default}\\Videos\\livereel',
        linux: '${LIVEREEL_MEDIA:-/var/lib/livereel/recordings}',
      },
      overlays: {
        win32: '${LOCALAPPDATA}\\livereel\\overlays',
        linux: '${LIVEREEL_STATE:-/var/lib/livereel}/overlays',
      },
    },
  },

  restart: {
    enabled: true,
    maxRetries: 10,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    resetAfterMs: 60_000,
  },

  logLevel: 'info',
};

/**
 * Load configuration from a file, then the environment.
 *
 * @param {string} [file] explicit path; otherwise the platform config directory is searched.
 */
export function loadConfig(file) {
  const resolved = file ?? findConfigFile();
  let fromFile = {};

  if (resolved) {
    const raw = fs.readFileSync(resolved, 'utf8');
    try {
      fromFile = JSON.parse(raw);
    } catch (err) {
      throw new Error(`config file ${resolved} is not valid JSON: ${err.message}`);
    }
  }

  const merged = deepMerge(structuredClone(DEFAULTS), fromFile);
  applyEnvOverrides(merged);
  fillDerivedDefaults(merged);
  validate(merged);

  merged.configFile = resolved ?? null;
  return merged;
}

function findConfigFile() {
  const candidates = [
    process.env.LIVEREEL_CONFIG,
    path.join(baseDirs().config, 'livereel.json'),
    path.join(process.cwd(), 'config', 'livereel.json'),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/**
 * Environment overrides.
 *
 * Deliberately a short list. Everything here is either a secret, which must not live in the
 * config file, or a value that changes between the same build's deployments.
 */
function applyEnvOverrides(config) {
  const env = process.env;

  if (env.LIVEREEL_CONTROL_HOST) config.control.host = env.LIVEREEL_CONTROL_HOST;
  if (env.LIVEREEL_CONTROL_PORT) config.control.port = Number(env.LIVEREEL_CONTROL_PORT);
  if (env.LIVEREEL_CONTROL_TOKEN) config.control.token = env.LIVEREEL_CONTROL_TOKEN;

  if (env.LIVEREEL_OBS_URL) config.obs.url = env.LIVEREEL_OBS_URL;
  if (env.LIVEREEL_OBS_PASSWORD) {
    config.obs.password = env.LIVEREEL_OBS_PASSWORD;
    config.obs.enabled = true;
  }

  if (env.LIVEREEL_MONGO_URI) {
    config.store.uri = env.LIVEREEL_MONGO_URI;
    config.store.driver = 'mongodb';
  }
  if (env.LIVEREEL_STORE_DRIVER) config.store.driver = env.LIVEREEL_STORE_DRIVER;

  if (env.LIVEREEL_FFMPEG) config.ffmpegPath = env.LIVEREEL_FFMPEG;
  if (env.LIVEREEL_LOG_LEVEL) config.logLevel = env.LIVEREEL_LOG_LEVEL;
}

function fillDerivedDefaults(config) {
  const dirs = baseDirs();
  if (!config.store.directory) config.store.directory = path.join(dirs.state, 'records');

  // Expand ${VAR} in the path roots now, so a failure is a startup error rather than a
  // confusing path at the moment a session starts.
  for (const [name, entry] of Object.entries(config.paths.roots)) {
    if (typeof entry === 'string') {
      config.paths.roots[name] = expandVars(entry);
      continue;
    }
    const platformValue = entry[process.platform] ?? entry.default;
    if (platformValue === undefined) {
      throw new Error(`path root "${name}" has no value for platform ${process.platform}`);
    }
    config.paths.roots[name] = expandVars(platformValue);
  }
}

function validate(config) {
  const problems = [];

  if (!Number.isInteger(config.control.port) || config.control.port < 1 || config.control.port > 65535) {
    problems.push('control.port must be a port number');
  }
  if (config.control.host !== '127.0.0.1' && config.control.host !== '::1' && !config.control.token) {
    problems.push(
      'control.token is required when control.host is not loopback, otherwise anyone who can reach the port can start and stop pipelines'
    );
  }
  if (!['auto', 'h264_nvenc', 'h264_qsv', 'h264_vaapi', 'libx264'].includes(config.encoder.prefer)) {
    problems.push(`encoder.prefer is not a known encoder: ${config.encoder.prefer}`);
  }
  if (!['mongodb', 'file'].includes(config.store.driver)) {
    problems.push(`store.driver must be "mongodb" or "file", got "${config.store.driver}"`);
  }
  if (config.video.fps <= 0 || config.video.fps > 240) {
    problems.push('video.fps must be between 1 and 240');
  }
  if (config.obs.enabled && isWindows === false && config.obs.url.includes('localhost')) {
    // Not fatal, but worth saying: on a headless Linux host "localhost" usually means OBS is
    // expected to be running there, and it usually is not.
    problems.push(
      'obs.enabled is set with a localhost url on Linux; a headless host normally has no OBS to connect to'
    );
  }

  if (problems.length) {
    throw new Error(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = deepMerge(target[key] ?? {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}
