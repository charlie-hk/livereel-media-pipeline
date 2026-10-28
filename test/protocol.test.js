import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, requireField, reply, replyError, event, ErrorCode } from '../src/control/protocol.js';

test('parseRequest accepts a well-formed request', () => {
  const message = parseRequest('{"id":"1","type":"status.get"}');
  assert.equal(message.id, '1');
  assert.equal(message.type, 'status.get');
});

test('parseRequest rejects malformed JSON', () => {
  assert.throws(() => parseRequest('{not json'), (err) => err.code === ErrorCode.BAD_REQUEST);
});

test('parseRequest rejects a non-object payload', () => {
  assert.throws(() => parseRequest('[1,2,3]'), /must be a JSON object/);
  assert.throws(() => parseRequest('"a string"'), /must be a JSON object/);
  assert.throws(() => parseRequest('null'), /must be a JSON object/);
});

test('parseRequest requires a type', () => {
  assert.throws(() => parseRequest('{"id":"1"}'), /needs a "type" string/);
  assert.throws(() => parseRequest('{"id":"1","type":42}'), /needs a "type" string/);
});

test('parseRequest rejects an id of the wrong type', () => {
  assert.throws(() => parseRequest('{"id":{"a":1},"type":"x"}'), /"id" must be/);
});

test('requireField enforces presence and type', () => {
  assert.equal(requireField({ name: 'x' }, 'name'), 'x');
  assert.throws(() => requireField({}, 'name'), /"name" is required/);
  assert.throws(() => requireField({ name: null }, 'name'), /"name" is required/);
  assert.throws(() => requireField({ name: 5 }, 'name'), /"name" must be string/);
  assert.deepEqual(requireField({ items: [1] }, 'items', 'array'), [1]);
  assert.throws(() => requireField({ items: 'no' }, 'items', 'array'), /must be array/);
});

test('reply and replyError carry the request id', () => {
  assert.deepEqual(JSON.parse(reply('7', { a: 1 })), { id: '7', ok: true, result: { a: 1 } });
  assert.deepEqual(JSON.parse(replyError('7', 'not_found', 'gone')), {
    id: '7',
    ok: false,
    error: { code: 'not_found', message: 'gone' },
  });
});

test('event frames carry no id, so they cannot be mistaken for a reply', () => {
  const frame = JSON.parse(event('session.progress', { frame: 10 }));
  assert.equal(frame.type, 'event');
  assert.equal(frame.event, 'session.progress');
  assert.equal(frame.id, undefined);
  assert.ok(typeof frame.ts === 'number');
});
