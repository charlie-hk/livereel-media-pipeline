/**
 * Child-process supervision with platform-correct shutdown.
 *
 * Stopping a media process is not just "kill it". An FFmpeg run writing an MP4 keeps the
 * moov atom in memory until it finishes; kill it with a signal and the file on disk will not
 * play. So shutdown is a ladder: ask the process to stop the way it understands, then
 * escalate only if it ignores us.
 *
 * The signalling itself differs by platform, which is most of why the original Windows
 * service did not survive the move as-is:
 *
 *   Linux   - spawn into its own process group, then signal the negative pid so children
 *             (gst-launch forks helpers, OBS spawns plenty) die with the parent.
 *   Windows - Node cannot deliver a real SIGINT to a child console process, and there are
 *             no process groups to signal. Killing the tree means shelling out to taskkill.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { isWindows } from './paths.js';
import { logger } from '../log.js';

const log = logger('process');

/** Milliseconds to wait at each rung of the shutdown ladder. */
const GRACE_MS = { stdin: 8000, term: 5000 };

/**
 * A supervised child process.
 *
 * Emits: `start`, `stdout`, `stderr`, `exit`, `restart`, `giveup`.
 */
export class SupervisedProcess extends EventEmitter {
  /**
   * @param {object} spec
   * @param {string} spec.name          label used in logs and telemetry
   * @param {string} spec.command       executable
   * @param {string[]} spec.args
   * @param {object} [spec.env]
   * @param {string} [spec.cwd]
   * @param {'auto'|'stdin-q'|'sigint'|'signal'} [spec.gracefulStop] how the process prefers to
   *        be stopped. `auto` resolves per platform, which is what FFmpeg needs: see
   *        #gracefulMethod().
   * @param {object} [spec.restart]     { enabled, maxRetries, baseDelayMs, maxDelayMs, resetAfterMs }
   */
  constructor(spec) {
    super();
    this.spec = spec;
    this.child = null;
    this.state = 'idle';
    this.retries = 0;
    this.startedAt = null;
    this.stopping = false;
    this.restartTimer = null;
    this.log = log.child(spec.name);
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  get running() {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  start() {
    if (this.running) throw new Error(`${this.spec.name} is already running`);

    this.stopping = false;
    this.state = 'starting';
    this.startedAt = Date.now();

    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: { ...process.env, ...this.spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // A new process group on Linux, so one signal reaches the whole tree. On Windows
      // `detached` means a new console, which we do not want for a headless service.
      detached: !isWindows,
      windowsHide: true,
    });

    this.child = child;
    this.state = 'running';
    this.log.info('started', { pid: child.pid, command: this.spec.command });
    this.emit('start', { pid: child.pid });

    lineStream(child.stdout, (line) => this.emit('stdout', line));
    lineStream(child.stderr, (line) => this.emit('stderr', line));

    child.on('error', (err) => {
      this.log.error('spawn failed', { error: err.message });
      this.state = 'failed';
      this.emit('exit', { code: null, signal: null, error: err.message });
      this.#scheduleRestart();
    });

    child.on('exit', (code, signal) => {
      const uptimeMs = Date.now() - this.startedAt;
      this.state = 'exited';
      this.child = null;
      this.log.info('exited', { code, signal, uptimeMs });
      this.emit('exit', { code, signal, uptimeMs });

      if (this.stopping) return;

      // A process that ran for a decent stretch before dying is not in a crash loop, so its
      // retry budget is handed back.
      const resetAfter = this.spec.restart?.resetAfterMs ?? 60_000;
      if (uptimeMs >= resetAfter) this.retries = 0;

      this.#scheduleRestart();
    });

    return this;
  }

  /**
   * Stop the process, escalating only as far as needed.
   * @returns {Promise<{stoppedBy: string}>}
   */
  async stop() {
    if (!this.running) return { stoppedBy: 'not-running' };

    this.stopping = true;
    clearTimeout(this.restartTimer);
    const child = this.child;

    // Rung 1: the process's own quit path, so it writes its trailer and leaves a playable file.
    const method = this.#gracefulMethod();

    if (method === 'stdin-q' && child.stdin?.writable) {
      this.log.debug('requesting graceful stop via stdin');
      try {
        child.stdin.write('q');
      } catch {
        /* the pipe may already be gone; fall through to the next rung */
      }
      if (await waitForExit(child, GRACE_MS.stdin)) return { stoppedBy: 'stdin-q' };
      this.log.warn('graceful stop timed out, escalating');
    } else if (method === 'sigint') {
      this.log.debug('requesting graceful stop via SIGINT');
      this.#killTree('SIGINT');
      if (await waitForExit(child, GRACE_MS.stdin)) return { stoppedBy: 'SIGINT' };
      this.log.warn('graceful stop timed out, escalating');
    }

    // Rung 2: polite termination of the whole tree.
    this.#killTree('SIGTERM');
    if (await waitForExit(child, GRACE_MS.term)) return { stoppedBy: 'SIGTERM' };

    // Rung 3: no more asking.
    this.log.warn('SIGTERM ignored, sending SIGKILL');
    this.#killTree('SIGKILL');
    await waitForExit(child, 2000);
    return { stoppedBy: 'SIGKILL' };
  }

  /**
   * Resolve `auto` to the way this platform can actually ask a media process to finish.
   *
   * FFmpeg accepts both: SIGINT, and `q` on stdin from its keyboard handler. They are not
   * interchangeable across platforms.
   *
   *   Linux   - SIGINT reaches the process group and FFmpeg writes its trailer. Because the
   *             signal does the work, FFmpeg can be started with `-nostdin`, which keeps it
   *             from swallowing the service's own stdin.
   *   Windows - Node cannot deliver a real SIGINT to a child, so `q` on stdin is the only
   *             graceful route, and FFmpeg must therefore be started *without* `-nostdin`.
   *
   * Getting this pair wrong is silent: the stop request goes nowhere, the ladder escalates to
   * SIGKILL, and a plain MP4 is left without its index. That is exactly what a Windows-era
   * `-nostdin` plus a `q` stop produces after the move to Linux.
   */
  #gracefulMethod() {
    const configured = this.spec.gracefulStop ?? 'auto';
    if (configured !== 'auto') return configured;
    return isWindows ? 'stdin-q' : 'sigint';
  }

  #killTree(signal) {
    const child = this.child;
    if (!child?.pid) return;

    if (isWindows) {
      // /T takes the tree, /F is required for anything that will not close politely.
      const args = ['/pid', String(child.pid), '/T'];
      if (signal === 'SIGKILL') args.push('/F');
      spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      return;
    }

    try {
      // Negative pid addresses the process group created by `detached: true`.
      process.kill(-child.pid, signal);
    } catch (err) {
      if (err.code === 'ESRCH') return; // already gone
      // The group may not exist if the child never got that far; try the pid directly.
      try {
        process.kill(child.pid, signal);
      } catch {
        /* nothing left to kill */
      }
    }
  }

  #scheduleRestart() {
    const policy = this.spec.restart;
    if (!policy?.enabled) return;

    const maxRetries = policy.maxRetries ?? 10;
    if (this.retries >= maxRetries) {
      this.state = 'giveup';
      this.log.error('restart budget exhausted', { retries: this.retries });
      this.emit('giveup', { retries: this.retries });
      return;
    }

    this.retries += 1;
    const base = policy.baseDelayMs ?? 1000;
    const max = policy.maxDelayMs ?? 30_000;
    // Exponential backoff with jitter, so a dependency coming back up is not hit by every
    // supervised process in the same millisecond.
    const backoff = Math.min(base * 2 ** (this.retries - 1), max);
    const delay = Math.round(backoff * (0.5 + Math.random() * 0.5));

    this.state = 'restarting';
    this.log.info('scheduling restart', { attempt: this.retries, delayMs: delay });
    this.emit('restart', { attempt: this.retries, delayMs: delay });

    this.restartTimer = setTimeout(() => {
      if (!this.stopping) this.start();
    }, delay);
    this.restartTimer.unref?.();
  }
}

/** Resolve true if the child exits within `ms`. */
function waitForExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, ms);
    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once('exit', onExit);
  });
}

/**
 * Split a stream into lines.
 *
 * FFmpeg reports progress with carriage returns rather than newlines, so a plain newline
 * split would buffer the whole run into one line and starve the telemetry loop.
 */
function lineStream(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\r\n|\r|\n/);
    buffer = parts.pop() ?? '';
    for (const line of parts) if (line.length) onLine(line);
  });
  stream.on('end', () => {
    if (buffer.length) onLine(buffer);
  });
}

/**
 * Run a command to completion and collect its output. Used by capability probes, where the
 * command is expected to be short-lived and its exit code is the answer.
 */
export function run(command, args, { timeoutMs = 15_000, input, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, error: err.message, timedOut });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
