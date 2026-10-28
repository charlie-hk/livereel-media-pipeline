/**
 * Structured logging.
 *
 * Output is one JSON object per line on stdout. Under systemd, journald captures
 * stdout as-is, so `journalctl -u livereel -o cat | jq` gives queryable logs without
 * a log shipper. On a TTY the same records are printed in a human-readable form.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel = LEVELS[process.env.LIVEREEL_LOG_LEVEL] ?? LEVELS.info;
let pretty = process.stdout.isTTY === true && process.env.LIVEREEL_LOG_JSON !== '1';

export function setLevel(name) {
  if (LEVELS[name] === undefined) throw new Error(`unknown log level: ${name}`);
  minLevel = LEVELS[name];
}

export function setPretty(value) {
  pretty = Boolean(value);
}

const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };

function emit(level, scope, msg, fields) {
  if (LEVELS[level] < minLevel) return;

  const record = { ts: new Date().toISOString(), level, scope, msg, ...fields };

  if (!pretty) {
    process.stdout.write(JSON.stringify(record) + '\n');
    return;
  }

  const rest = { ...fields };
  const detail = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
  const color = COLORS[level] ?? '';
  process.stdout.write(
    `${color}${level.padEnd(5)}\x1b[0m \x1b[90m${scope}\x1b[0m ${msg}${detail}\n`
  );
}

/**
 * A logger bound to a scope name, so every record says which subsystem produced it.
 */
export function logger(scope) {
  return {
    debug: (msg, fields) => emit('debug', scope, msg, fields),
    info: (msg, fields) => emit('info', scope, msg, fields),
    warn: (msg, fields) => emit('warn', scope, msg, fields),
    error: (msg, fields) => emit('error', scope, msg, fields),
    child: (sub) => logger(`${scope}.${sub}`),
  };
}
