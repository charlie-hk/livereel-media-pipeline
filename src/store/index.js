/**
 * Event and metadata persistence.
 *
 * Three kinds of record, with different shapes and different retention:
 *
 *   sessions   one document per pipeline run, updated as it progresses. The record of what
 *              ran, with which encoder, to where, and how it ended.
 *   events     discrete things that happened: started, restarted, encoder fell back, stopped.
 *   telemetry  periodic samples. High volume, low individual value, short retention.
 *
 * Telemetry is buffered and written in batches. A single live session emits a progress sample
 * roughly twice a second, so writing each one as it arrives turns a handful of sessions into
 * a steady stream of single-document inserts, which is the slowest way to use MongoDB and
 * puts a database round trip on the path of every progress frame.
 *
 * When MongoDB is not reachable the service does not fail; it writes newline-delimited JSON
 * to disk instead. Losing the database should cost queryability, not the recording.
 */

import { MongoStore } from './mongo.js';
import { FileStore } from './fallback.js';
import { logger } from '../log.js';

const log = logger('store');

/**
 * Open the configured store, falling back to files when MongoDB is unreachable.
 *
 * @param {object} config
 * @param {'mongodb'|'file'} config.driver
 * @param {string} [config.uri]
 * @param {string} [config.database]
 * @param {string} [config.directory]  used by the file store and by the fallback
 * @param {number} [config.telemetryTtlDays]
 * @param {number} [config.connectTimeoutMs]
 */
export async function openStore(config) {
  if (config.driver === 'file') {
    return new FileStore(config).open();
  }

  const mongo = new MongoStore(config);
  try {
    await mongo.open();
    return mongo;
  } catch (err) {
    log.warn('mongodb unavailable, falling back to file store', {
      uri: redactUri(config.uri),
      error: err.message,
    });
    return new FileStore({ ...config, degraded: true }).open();
  }
}

/** Strip credentials before a connection string reaches a log line. */
export function redactUri(uri) {
  if (!uri) return uri;
  return String(uri).replace(/\/\/([^:/@]+):([^@]+)@/, '//$1:***@');
}
