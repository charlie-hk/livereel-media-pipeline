/**
 * Path handling across Windows and Linux.
 *
 * The application this control plane was modelled on grew up on a Windows host, so its
 * configuration carried absolute paths like `C:\media\out`, backslash separators, and the
 * assumption that `Recordings` and `recordings` are the same directory. None of that holds
 * on Linux. Rather than hand-editing every path at migration time, paths go through this
 * module: a config declares logical roots, and each platform resolves them to a real
 * location.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const isWindows = process.platform === 'win32';

/**
 * Per-platform base directories.
 *
 * Linux follows the XDG spec, which is also what a systemd unit expects when it sets
 * StateDirectory/LogsDirectory. Windows uses the usual LOCALAPPDATA layout.
 */
export function baseDirs(appName = 'livereel') {
  if (isWindows) {
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return {
      config: path.join(process.env.APPDATA ?? localAppData, appName),
      state: path.join(localAppData, appName, 'state'),
      logs: path.join(localAppData, appName, 'logs'),
      cache: path.join(localAppData, appName, 'cache'),
    };
  }

  // Under systemd with StateDirectory=livereel, these env vars are set for us and point
  // at /var/lib/livereel and friends. Outside systemd we fall back to the XDG defaults.
  const xdgState =
    process.env.STATE_DIRECTORY ??
    process.env.XDG_STATE_HOME ??
    path.join(os.homedir(), '.local', 'state');
  const xdgConfig =
    process.env.CONFIGURATION_DIRECTORY ??
    process.env.XDG_CONFIG_HOME ??
    path.join(os.homedir(), '.config');
  const xdgCache = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');

  return {
    config: process.env.CONFIGURATION_DIRECTORY ? xdgConfig : path.join(xdgConfig, appName),
    state: process.env.STATE_DIRECTORY ? xdgState : path.join(xdgState, appName),
    logs: process.env.LOGS_DIRECTORY ?? path.join(xdgState, appName, 'logs'),
    cache: path.join(xdgCache, appName),
  };
}

/**
 * Normalise a path that may have been written on either platform.
 *
 * Backslashes are only separators on Windows; on Linux a backslash is a legal filename
 * character, so blindly converting them would corrupt real names. We only rewrite when the
 * string looks like a Windows path: a drive letter, a UNC prefix, or a backslash followed
 * by a path-ish segment with no spaces around it.
 */
export function normalizeIncoming(input) {
  if (typeof input !== 'string' || input.length === 0) return input;

  const looksWindows = /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\');
  if (!looksWindows) return isWindows ? input : input;

  if (isWindows) return path.win32.normalize(input);

  // On Linux a Windows absolute path cannot be used as-is. Strip the drive or UNC prefix
  // and hand back a relative path; resolveRoot() decides what it hangs off.
  const withoutDrive = input.replace(/^[a-zA-Z]:[\\/]/, '').replace(/^\\\\[^\\]+\\/, '');
  return withoutDrive.split('\\').join('/');
}

/**
 * Resolve a logical root name to an absolute directory.
 *
 * `roots` comes from config, e.g. { media: { win32: "D:\\media", linux: "/srv/media" } }.
 * A single string applies to both platforms.
 */
export function resolveRoot(roots, name) {
  const entry = roots?.[name];
  if (entry === undefined) throw new Error(`unknown path root: ${name}`);

  const raw = typeof entry === 'string' ? entry : entry[process.platform] ?? entry.default;
  if (raw === undefined) {
    throw new Error(`path root "${name}" has no entry for platform ${process.platform}`);
  }
  return path.resolve(expandVars(raw));
}

/**
 * Join a path under a logical root, refusing anything that would escape it.
 *
 * Segments can arrive from WebSocket clients, so this is a containment check, not a
 * convenience: `..` traversal and absolute segments are rejected rather than silently
 * resolved outside the root.
 */
export function underRoot(roots, name, ...segments) {
  const root = resolveRoot(roots, name);
  const relative = segments.map((s) => normalizeIncoming(String(s))).join('/');
  const resolved = path.resolve(root, relative);

  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes root "${name}": ${relative}`);
  }
  return resolved;
}

/** Expand ${VAR} and ${VAR:-default} against the environment. */
export function expandVars(input) {
  return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
    return process.env[name] ?? fallback ?? '';
  });
}

/**
 * Report whether a directory's filesystem is case-insensitive.
 *
 * Worth knowing at startup: config written on Windows often disagrees with the real case of
 * files on disk, and on Linux that turns into a file-not-found at the worst moment. The
 * service logs a warning rather than trying to repair it.
 */
export function isCaseInsensitive(dir) {
  const probe = path.join(dir, `.livereel-case-${process.pid}`);
  try {
    fs.writeFileSync(probe, '');
    const upper = path.join(dir, path.basename(probe).toUpperCase());
    const insensitive = fs.existsSync(upper);
    fs.unlinkSync(probe);
    return insensitive;
  } catch {
    return null; // undeterminable, e.g. read-only directory
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The platform's null sink, used by trial encodes that only care whether the encoder
 * accepted the stream.
 */
export const nullSink = isWindows ? 'NUL' : '/dev/null';

/** Append `.exe` on Windows so a single config value names the binary on both platforms. */
export function exeName(name) {
  return isWindows && !name.toLowerCase().endsWith('.exe') ? `${name}.exe` : name;
}
