/**
 * File-backed store.
 *
 * Used when MongoDB is not configured, and as the fallback when it is configured but
 * unreachable. Records go to newline-delimited JSON, one file per kind, which `jq` can read
 * and which can be replayed into MongoDB later.
 *
 * It implements the same surface as the MongoDB store so nothing above it knows which one it
 * has, beyond the `degraded` flag that gets reported in the service status.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureDir } from '../platform/paths.js';
import { logger } from '../log.js';

const log = logger('store.file');

export class FileStore {
  constructor({ directory, degraded = false, maxBytes = 64 * 1024 * 1024 }) {
    this.directory = directory;
    this.degraded = degraded;
    this.maxBytes = maxBytes;
    this.host = os.hostname();
    this.streams = new Map();
    this.sessions = new Map();
  }

  open() {
    ensureDir(this.directory);
    log.info('file store open', { directory: this.directory, degraded: this.degraded });
    return this;
  }

  #stream(kind) {
    let stream = this.streams.get(kind);
    if (stream) return stream;

    const file = path.join(this.directory, `${kind}.jsonl`);
    this.#rotateIfLarge(file);
    stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', (err) => log.error('store write failed', { kind, error: err.message }));
    this.streams.set(kind, stream);
    return stream;
  }

  /**
   * Keep one file from growing without limit.
   *
   * A single generation of history is kept: enough to survive a rotation mid-incident,
   * without turning an unattended service into a disk-space problem months later.
   */
  #rotateIfLarge(file) {
    try {
      const { size } = fs.statSync(file);
      if (size < this.maxBytes) return;
      fs.renameSync(file, `${file}.1`);
      log.info('rotated store file', { file, size });
    } catch {
      /* the file does not exist yet, which is the normal first-run case */
    }
  }

  #write(kind, record) {
    this.#stream(kind).write(JSON.stringify({ ...record, host: this.host }) + '\n');
  }

  async startSession(session) {
    this.sessions.set(session.sessionId, { ...session, startedAt: new Date().toISOString() });
    this.#write('sessions', { ...session, startedAt: new Date().toISOString(), status: 'running' });
    return session.sessionId;
  }

  async endSession(sessionId, outcome) {
    const started = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    // Append-only, so the close is its own record rather than an edit of the earlier one.
    this.#write('sessions', {
      ...started,
      ...outcome,
      sessionId,
      endedAt: new Date().toISOString(),
      status: outcome.status ?? 'ended',
    });
  }

  async updateSession(sessionId, fields) {
    const current = this.sessions.get(sessionId);
    if (current) this.sessions.set(sessionId, { ...current, ...fields });
    this.#write('sessions', { sessionId, ...fields, updatedAt: new Date().toISOString() });
  }

  async recordEvent(sessionId, type, data = {}) {
    this.#write('events', { sessionId, type, data, ts: new Date().toISOString() });
  }

  recordTelemetry(sessionId, sample) {
    this.#write('telemetry', { sessionId, ...sample, ts: new Date().toISOString() });
  }

  async flush() {
    return 0; // write streams flush themselves
  }

  async recentSessions() {
    return [...this.sessions.values()];
  }

  async close() {
    await Promise.all(
      [...this.streams.values()].map(
        (stream) => new Promise((resolve) => stream.end(resolve))
      )
    );
    this.streams.clear();
    log.info('file store closed');
  }
}
