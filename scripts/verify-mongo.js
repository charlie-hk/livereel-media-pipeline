#!/usr/bin/env node
/**
 * Verify the MongoDB store against a real server.
 *
 * The unit tests cover the store's own behaviour with a stubbed driver. This script is the
 * other half: it proves the collections, indexes and TTL actually come out as intended on a
 * live mongod, which a stub cannot tell you.
 *
 *   docker run -d --rm -p 27017:27017 --name livereel-mongo mongo:8
 *   node scripts/verify-mongo.js
 *   docker stop livereel-mongo
 *
 * Or against an existing server:
 *
 *   LIVEREEL_MONGO_URI=mongodb://user:pass@host:27017 node scripts/verify-mongo.js
 */

import { MongoStore } from '../src/store/mongo.js';
import { redactUri } from '../src/store/index.js';

const uri = process.env.LIVEREEL_MONGO_URI ?? 'mongodb://127.0.0.1:27017';
const database = process.env.LIVEREEL_MONGO_DB ?? 'livereel_verify';

let failures = 0;

function check(label, condition, detail = '') {
  const mark = condition ? 'ok  ' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  ${mark} ${label}${detail ? `  ${detail}` : ''}`);
}

console.log(`\nverifying against ${redactUri(uri)}, database ${database}\n`);

const store = new MongoStore({ uri, database, telemetryTtlDays: 1, connectTimeoutMs: 4000 });

try {
  await store.open();
  console.log('connection');
  check('connected and pinged', true);

  // Start clean so a previous run cannot make a failure look like a pass.
  await store.db.dropDatabase();
  await store.open();

  console.log('\nindexes');
  const sessionIndexes = await store.db.collection('sessions').indexes();
  const telemetryIndexes = await store.db.collection('telemetry').indexes();

  check(
    'sessions.sessionId is unique',
    sessionIndexes.some((i) => i.unique && i.key.sessionId === 1)
  );
  check(
    'sessions is indexed by host and start time',
    sessionIndexes.some((i) => i.key.host === 1 && i.key.startedAt === -1)
  );
  const ttl = telemetryIndexes.find((i) => i.expireAfterSeconds !== undefined);
  check('telemetry has a TTL index', Boolean(ttl), ttl ? `expireAfterSeconds=${ttl.expireAfterSeconds}` : '');

  console.log('\nwrites');
  const sessionId = `verify-${Date.now()}`;
  await store.startSession({
    sessionId,
    encoder: 'libx264',
    encoderFellBack: true,
    encoderRequested: 'h264_nvenc',
    encoderFallbackReason: 'Cannot load libcuda.so.1',
  });

  const inserted = await store.db.collection('sessions').findOne({ sessionId });
  check('session document written', Boolean(inserted));
  check('fallback reason preserved', inserted?.encoderFallbackReason?.includes('libcuda'));
  check('status is running', inserted?.status === 'running');

  for (let i = 0; i < 25; i += 1) store.recordTelemetry(sessionId, { frame: i, speed: 1.0 });
  const flushed = await store.flush();
  check('telemetry batch flushed', flushed === 25, `${flushed} documents in one insertMany`);

  const telemetryCount = await store.db.collection('telemetry').countDocuments({ sessionId });
  check('telemetry readable back', telemetryCount === 25, `${telemetryCount} found`);

  await store.recordEvent(sessionId, 'overlay.set', { text: 'verify' });
  const eventCount = await store.db.collection('events').countDocuments({ sessionId });
  check('event written', eventCount === 1);

  await store.endSession(sessionId, { status: 'stopped', stoppedBy: 'SIGINT' });
  const ended = await store.db.collection('sessions').findOne({ sessionId });
  check('session closed out', ended?.status === 'stopped' && ended?.stoppedBy === 'SIGINT');
  check('endedAt recorded', ended?.endedAt instanceof Date);

  console.log('\nduplicate protection');
  let rejected = false;
  try {
    await store.startSession({ sessionId, encoder: 'libx264' });
  } catch (err) {
    rejected = err.code === 11000;
  }
  check('a duplicate sessionId is rejected by the unique index', rejected);

  console.log('\nreads');
  const recent = await store.recentSessions(5);
  check('recentSessions returns this host\'s sessions', recent.length >= 1, `${recent.length} found`);

  await store.db.dropDatabase();
  await store.close();
} catch (err) {
  console.error(`\ncould not verify: ${err.message}`);
  console.error('\nis a mongod listening? try:\n  docker run -d --rm -p 27017:27017 --name livereel-mongo mongo:8\n');
  process.exit(1);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);
