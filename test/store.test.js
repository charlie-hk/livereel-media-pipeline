import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoStore } from '../src/store/mongo.js';
import { FileStore } from '../src/store/fallback.js';
import { openStore, redactUri } from '../src/store/index.js';

/**
 * A stand-in for the driver, covering only the surface MongoStore uses.
 *
 * MongoDB itself is not exercised here: the point is the store's own behaviour — that
 * telemetry is batched rather than written one document at a time, that the indexes the
 * queries need are the ones created, and that a session's outcome is written on close.
 * Running against a real mongod is a separate script, scripts/verify-mongo.js.
 */
function fakeClient() {
  const calls = { insertMany: [], insertOne: [], updateOne: [], createIndex: [], closed: false };
  const collection = (name) => ({
    insertMany: async (docs) => {
      calls.insertMany.push({ name, count: docs.length });
      return { insertedCount: docs.length };
    },
    insertOne: async (doc) => {
      calls.insertOne.push({ name, doc });
      return { insertedId: '1' };
    },
    updateOne: async (filter, update) => {
      calls.updateOne.push({ name, filter, update });
      return { modifiedCount: 1 };
    },
    createIndex: async (spec, options) => {
      calls.createIndex.push({ name, spec, options });
      return 'idx';
    },
    find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
  });

  return {
    calls,
    client: {
      connect: async () => {},
      db: () => ({ collection, command: async () => ({ ok: 1 }) }),
      close: async () => {
        calls.closed = true;
      },
    },
  };
}

test('telemetry is batched rather than written one document at a time', async () => {
  const fake = fakeClient();
  const store = new MongoStore({ uri: 'mongodb://fake', clientFactory: () => fake.client });
  await store.open();

  for (let i = 0; i < 10; i += 1) store.recordTelemetry('s1', { frame: i });
  // Nothing has gone to the database yet: the batch is still filling.
  assert.equal(fake.calls.insertMany.length, 0);

  const flushed = await store.flush();
  assert.equal(flushed, 10);
  assert.equal(fake.calls.insertMany.length, 1);
  assert.equal(fake.calls.insertMany[0].count, 10);
  assert.equal(fake.calls.insertMany[0].name, 'telemetry');

  await store.close();
});

test('a large burst of telemetry flushes early instead of growing without limit', async () => {
  const fake = fakeClient();
  const store = new MongoStore({ uri: 'mongodb://fake', clientFactory: () => fake.client });
  await store.open();

  for (let i = 0; i < 150; i += 1) store.recordTelemetry('s1', { frame: i });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(fake.calls.insertMany.length >= 1, 'threshold flush should have fired');
  await store.close();
});

test('telemetry gets a TTL index, so retention needs no cron job', async () => {
  const fake = fakeClient();
  const store = new MongoStore({
    uri: 'mongodb://fake',
    telemetryTtlDays: 3,
    clientFactory: () => fake.client,
  });
  await store.open();

  const ttl = fake.calls.createIndex.find((c) => c.options?.expireAfterSeconds !== undefined);
  assert.ok(ttl, 'expected a TTL index on telemetry');
  assert.equal(ttl.name, 'telemetry');
  assert.equal(ttl.options.expireAfterSeconds, 3 * 86400);

  const unique = fake.calls.createIndex.find((c) => c.options?.unique);
  assert.equal(unique.name, 'sessions', 'sessionId should be unique on sessions');

  await store.close();
});

test('closing the store flushes what is still buffered', async () => {
  const fake = fakeClient();
  const store = new MongoStore({ uri: 'mongodb://fake', clientFactory: () => fake.client });
  await store.open();

  store.recordTelemetry('s1', { frame: 1 });
  await store.close();

  assert.equal(fake.calls.insertMany.length, 1, 'buffered telemetry should survive close');
  assert.equal(fake.calls.closed, true);
});

test('ending a session records its outcome', async () => {
  const fake = fakeClient();
  const store = new MongoStore({ uri: 'mongodb://fake', clientFactory: () => fake.client });
  await store.open();

  await store.startSession({ sessionId: 's1', encoder: 'libx264' });
  await store.endSession('s1', { status: 'stopped', stoppedBy: 'SIGINT' });

  assert.equal(fake.calls.insertOne[0].name, 'sessions');
  const update = fake.calls.updateOne.find((c) => c.name === 'sessions');
  assert.equal(update.filter.sessionId, 's1');
  assert.equal(update.update.$set.stoppedBy, 'SIGINT');
  assert.ok(update.update.$set.endedAt instanceof Date);

  await store.close();
});

test('the file store writes one JSON object per line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livereel-store-'));
  const store = new FileStore({ directory: dir }).open();

  await store.startSession({ sessionId: 's1', encoder: 'libx264' });
  await store.recordEvent('s1', 'overlay.set', { text: 'hello' });
  store.recordTelemetry('s1', { frame: 1, speed: 1.0 });
  await store.endSession('s1', { status: 'stopped' });
  await store.close();

  const events = fs
    .readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'overlay.set');
  assert.equal(events[0].data.text, 'hello');
  assert.ok(events[0].host);

  const sessions = fs
    .readFileSync(path.join(dir, 'sessions.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(sessions.length, 2, 'append-only: start and end are separate records');
  assert.equal(sessions[1].status, 'stopped');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('openStore falls back to files when MongoDB cannot be reached', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livereel-store-'));
  const store = await openStore({
    driver: 'mongodb',
    // Reserved TEST-NET-1 address: nothing answers, so connection fails rather than hangs
    // on a DNS lookup that might resolve somewhere unexpected.
    uri: 'mongodb://192.0.2.1:27017',
    directory: dir,
    connectTimeoutMs: 400,
  });

  assert.equal(store.degraded, true, 'the fallback should mark itself degraded');

  // Degraded is not broken: recording must continue.
  await store.startSession({ sessionId: 's1' });
  store.recordTelemetry('s1', { frame: 1 });
  await store.close();

  assert.ok(fs.existsSync(path.join(dir, 'sessions.jsonl')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('credentials are stripped before a connection string reaches a log line', () => {
  assert.equal(
    redactUri('mongodb://admin:s3cret@db.internal:27017/livereel'),
    'mongodb://admin:***@db.internal:27017/livereel'
  );
  assert.equal(redactUri('mongodb://127.0.0.1:27017'), 'mongodb://127.0.0.1:27017');
  assert.equal(redactUri(undefined), undefined);
});
