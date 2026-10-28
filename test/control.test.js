import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { ControlServer } from '../src/control/server.js';
import { ProtocolError, ErrorCode } from '../src/control/protocol.js';

let nextPort = 18800;
const port = () => nextPort++;

/** A client that resolves each reply by its request id. */
function connect(url, options) {
  const ws = new WebSocket(url, options);
  const pending = new Map();
  const events = [];
  let seq = 0;

  ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    if (message.type === 'event') {
      events.push(message);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.ok ? waiter.resolve(message.result) : waiter.reject(message.error);
  });

  return {
    ws,
    events,
    ready: new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    call(type, params = {}) {
      const id = String(++seq);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, type, ...params }));
      });
    },
    close: () => ws.close(),
  };
}

test('a command is dispatched and its result returned', async () => {
  const p = port();
  const server = new ControlServer({
    port: p,
    handlers: { 'echo.test': async (params) => ({ got: params.value }) },
  }).start();

  const client = connect(`ws://127.0.0.1:${p}`);
  await client.ready;

  assert.deepEqual(await client.call('echo.test', { value: 42 }), { got: 42 });

  client.close();
  await server.stop();
});

test('a new client is told the protocol version and the commands available', async () => {
  const p = port();
  const server = new ControlServer({ port: p, handlers: { 'a.b': async () => ({}) } }).start();

  const client = connect(`ws://127.0.0.1:${p}`);
  await client.ready;
  await new Promise((resolve) => setTimeout(resolve, 100));

  const hello = client.events.find((e) => e.event === 'hello');
  assert.ok(hello, 'expected a hello event');
  assert.equal(hello.data.protocolVersion, 1);
  assert.deepEqual(hello.data.commands, ['a.b']);

  client.close();
  await server.stop();
});

test('an unknown command is an error, not a silent drop', async () => {
  const p = port();
  const server = new ControlServer({ port: p, handlers: {} }).start();
  const client = connect(`ws://127.0.0.1:${p}`);
  await client.ready;

  await assert.rejects(
    () => client.call('nope'),
    (err) => err.code === ErrorCode.UNKNOWN_COMMAND
  );

  client.close();
  await server.stop();
});

test('a handler ProtocolError keeps its code; anything else becomes internal', async () => {
  const p = port();
  const server = new ControlServer({
    port: p,
    handlers: {
      'fail.typed': async () => {
        throw new ProtocolError(ErrorCode.NOT_FOUND, 'no such thing');
      },
      'fail.raw': async () => {
        throw new Error('something broke');
      },
    },
  }).start();

  const client = connect(`ws://127.0.0.1:${p}`);
  await client.ready;

  await assert.rejects(
    () => client.call('fail.typed'),
    (err) => err.code === ErrorCode.NOT_FOUND && err.message === 'no such thing'
  );
  await assert.rejects(
    () => client.call('fail.raw'),
    (err) => err.code === ErrorCode.INTERNAL
  );

  client.close();
  await server.stop();
});

test('ping echoes the client timestamp so latency needs no clock sync', async () => {
  const p = port();
  const server = new ControlServer({ port: p, handlers: {} }).start();
  const client = connect(`ws://127.0.0.1:${p}`);
  await client.ready;

  const sent = Date.now();
  const pong = await client.call('ping', { ts: sent });
  assert.equal(pong.pong, true);
  assert.equal(pong.clientTs, sent);

  client.close();
  await server.stop();
});

test('the server refuses to bind off-loopback without a token', () => {
  assert.throws(
    () => new ControlServer({ port: port(), host: '0.0.0.0', handlers: {} }).start(),
    /refusing to bind/
  );
});

test('with a token set, the right one connects and the wrong one is rejected', async () => {
  const p = port();
  const server = new ControlServer({
    port: p,
    host: '127.0.0.1',
    token: 'correct-horse',
    handlers: { 'status.get': async () => ({ ok: true }) },
  }).start();

  const good = connect(`ws://127.0.0.1:${p}`, { headers: { authorization: 'Bearer correct-horse' } });
  await good.ready;
  assert.deepEqual(await good.call('status.get'), { ok: true });
  good.close();

  const viaQuery = connect(`ws://127.0.0.1:${p}/?token=correct-horse`);
  await viaQuery.ready;
  viaQuery.close();

  const bad = connect(`ws://127.0.0.1:${p}`, { headers: { authorization: 'Bearer wrong' } });
  await assert.rejects(() => bad.ready, /401|Unexpected server response/);

  const none = connect(`ws://127.0.0.1:${p}`);
  await assert.rejects(() => none.ready, /401|Unexpected server response/);

  await server.stop();
});

test('events reach subscribed clients and skip unsubscribed ones', async () => {
  const p = port();
  const server = new ControlServer({ port: p, handlers: {} }).start();

  const all = connect(`ws://127.0.0.1:${p}`);
  const picky = connect(`ws://127.0.0.1:${p}`);
  await Promise.all([all.ready, picky.ready]);

  await picky.call('subscribe', { events: ['session.started'] });

  const sent = server.broadcast('session.progress', { frame: 1 });
  assert.equal(sent, 1, 'only the client subscribed to everything should receive it');

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(all.events.some((e) => e.event === 'session.progress'));
  assert.ok(!picky.events.some((e) => e.event === 'session.progress'));

  all.close();
  picky.close();
  await server.stop();
});

test('telemetry is dropped under backpressure while commands are not', async () => {
  const p = port();
  const server = new ControlServer({ port: p, handlers: {} }).start();
  const client = connect(`ws://127.0.0.1:${p}`);
  await client.ready;

  const [entry] = [...server.clients.values()];
  // Simulate a client whose socket has backed up past the threshold.
  Object.defineProperty(entry.socket, 'bufferedAmount', { get: () => 4 * 1024 * 1024 });

  assert.equal(server.broadcast('session.progress', { frame: 1 }, { droppable: true }), 0);
  assert.equal(server.stats.telemetryDropped, 1);

  // A non-droppable event still goes out: losing "the session stopped" because the link is
  // slow would leave the client believing a pipeline is still running.
  assert.equal(server.broadcast('session.stopped', { sessionId: 'x' }), 1);

  client.close();
  await server.stop();
});

test('a malformed frame is answered rather than ignored', async () => {
  const p = port();
  const server = new ControlServer({ port: p, handlers: {} }).start();
  const ws = new WebSocket(`ws://127.0.0.1:${p}`);
  await new Promise((resolve) => ws.once('open', resolve));

  const replyPromise = new Promise((resolve) => {
    ws.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (message.ok === false) resolve(message);
    });
  });

  ws.send('{ not json');
  const error = await replyPromise;
  assert.equal(error.error.code, ErrorCode.BAD_REQUEST);

  ws.close();
  await server.stop();
});

test('stopping the server closes its clients', async () => {
  const p = port();
  const server = new ControlServer({ port: p, handlers: {} }).start();
  const client = connect(`ws://127.0.0.1:${p}`);
  await client.ready;

  const closed = new Promise((resolve) => client.ws.once('close', resolve));
  await server.stop();
  await closed;

  assert.equal(server.clients.size, 0);
});
