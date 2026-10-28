/**
 * MongoDB-backed store.
 *
 * Indexes are created at startup rather than assumed. The queries this service's records are
 * actually read with are: "what ran on this host recently", "show me this session", and
 * "telemetry for this session in order" — so those are the indexes, and nothing else.
 */

import { MongoClient } from 'mongodb';
import os from 'node:os';
import { logger } from '../log.js';

const log = logger('store.mongo');

/** How long telemetry is buffered before a flush, and how many samples force an early one. */
const FLUSH_INTERVAL_MS = 2000;
const FLUSH_THRESHOLD = 100;

export class MongoStore {
  /**
   * @param {object} options
   * @param {string} options.uri
   * @param {string} [options.database]
   * @param {number} [options.telemetryTtlDays]
   * @param {number} [options.connectTimeoutMs]
   * @param {(uri: string, opts: object) => object} [options.clientFactory] builds the driver
   *        client. Supplied by tests, and by any caller that wants several stores to share one
   *        pooled client rather than opening a connection each.
   */
  constructor({ uri, database = 'livereel', telemetryTtlDays = 7, connectTimeoutMs = 5000, clientFactory }) {
    this.uri = uri;
    this.databaseName = database;
    this.telemetryTtlDays = telemetryTtlDays;
    this.connectTimeoutMs = connectTimeoutMs;
    this.clientFactory = clientFactory ?? ((u, o) => new MongoClient(u, o));
    this.client = null;
    this.db = null;
    this.buffer = [];
    this.flushTimer = null;
    this.host = os.hostname();
    this.degraded = false;
  }

  async open() {
    this.client = this.clientFactory(this.uri, {
      // Without a short selection timeout the driver spends 30 seconds deciding a local
      // mongod is absent, which would stall service startup for every restart on a host that
      // does not run one.
      serverSelectionTimeoutMS: this.connectTimeoutMs,
      connectTimeoutMS: this.connectTimeoutMs,
    });

    await this.client.connect();
    await this.client.db(this.databaseName).command({ ping: 1 });
    this.db = this.client.db(this.databaseName);

    await this.#ensureIndexes();
    this.#startFlushTimer();

    log.info('mongodb store open', { database: this.databaseName });
    return this;
  }

  async #ensureIndexes() {
    const sessions = this.db.collection('sessions');
    const events = this.db.collection('events');
    const telemetry = this.db.collection('telemetry');

    await sessions.createIndex({ sessionId: 1 }, { unique: true });
    await sessions.createIndex({ host: 1, startedAt: -1 });
    await events.createIndex({ sessionId: 1, ts: 1 });
    await events.createIndex({ ts: -1 });

    // Telemetry expires on its own. A TTL index is the only retention policy that does not
    // need a cron job to go wrong.
    await telemetry.createIndex({ sessionId: 1, ts: 1 });
    await telemetry.createIndex(
      { ts: 1 },
      { expireAfterSeconds: Math.round(this.telemetryTtlDays * 86400) }
    );
  }

  /** Create the session document. */
  async startSession(session) {
    await this.db.collection('sessions').insertOne({
      ...session,
      host: this.host,
      startedAt: new Date(),
      status: 'running',
    });
    return session.sessionId;
  }

  /** Close out a session with its outcome. */
  async endSession(sessionId, outcome) {
    await this.flush();
    await this.db.collection('sessions').updateOne(
      { sessionId },
      { $set: { ...outcome, endedAt: new Date(), status: outcome.status ?? 'ended' } }
    );
  }

  /** Update fields on a running session, e.g. the encoder actually chosen after a fallback. */
  async updateSession(sessionId, fields) {
    await this.db.collection('sessions').updateOne({ sessionId }, { $set: fields });
  }

  async recordEvent(sessionId, type, data = {}) {
    await this.db.collection('events').insertOne({
      sessionId,
      type,
      data,
      host: this.host,
      ts: new Date(),
    });
  }

  /** Buffered: see the note at the top of store/index.js. */
  recordTelemetry(sessionId, sample) {
    this.buffer.push({ sessionId, ...sample, host: this.host, ts: new Date() });
    if (this.buffer.length >= FLUSH_THRESHOLD) void this.flush();
  }

  async flush() {
    if (this.buffer.length === 0) return 0;

    const batch = this.buffer;
    this.buffer = [];
    try {
      // Unordered: one bad document should not discard the rest of the batch.
      await this.db.collection('telemetry').insertMany(batch, { ordered: false });
      return batch.length;
    } catch (err) {
      log.warn('telemetry flush failed', { count: batch.length, error: err.message });
      return 0;
    }
  }

  #startFlushTimer() {
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  async recentSessions(limit = 20) {
    return this.db
      .collection('sessions')
      .find({ host: this.host })
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray();
  }

  async close() {
    clearInterval(this.flushTimer);
    await this.flush();
    await this.client?.close();
    log.info('mongodb store closed');
  }
}
