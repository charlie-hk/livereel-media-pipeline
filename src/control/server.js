/**
 * WebSocket control server.
 *
 * Two kinds of traffic share the socket and they have opposite requirements. Commands are
 * rare and must not be lost. Telemetry is frequent and is worthless once it is stale — a
 * progress frame from four seconds ago tells an operator nothing.
 *
 * So telemetry is dropped under backpressure while commands are never dropped. Without that
 * split, a client on a slow link quietly builds an unbounded send queue in the server's
 * memory, and by the time anyone notices, the control channel is seconds behind and the
 * service is holding megabytes of obsolete progress frames.
 */

import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import {
  PROTOCOL_VERSION,
  ErrorCode,
  ProtocolError,
  parseRequest,
  reply,
  replyError,
  event,
} from './protocol.js';
import { logger } from '../log.js';

const log = logger('control');

/** Drop telemetry once this much unsent data has queued on a socket. */
const BACKPRESSURE_BYTES = 1 << 20; // 1 MiB

/** A client that misses this many heartbeats is assumed gone. */
const HEARTBEAT_MS = 15_000;

export class ControlServer {
  /**
   * @param {object} options
   * @param {number} options.port
   * @param {string} [options.host]   defaults to loopback; see the note in #verifyClient
   * @param {string} [options.token]  shared secret, required when host is not loopback
   * @param {object} options.handlers map of command name to async (params, context) => result
   */
  constructor({ port, host = '127.0.0.1', token, handlers }) {
    this.port = port;
    this.host = host;
    this.token = token;
    this.handlers = handlers;
    this.clients = new Map();
    this.wss = null;
    this.heartbeat = null;
    this.stats = { commands: 0, errors: 0, eventsSent: 0, telemetryDropped: 0 };
  }

  start() {
    // Binding to anything but loopback exposes process control to the network. The service
    // refuses to do that unauthenticated rather than leaving it to the operator to notice.
    if (this.host !== '127.0.0.1' && this.host !== '::1' && !this.token) {
      throw new Error(
        `refusing to bind the control server to ${this.host} without control.token set`
      );
    }

    this.wss = new WebSocketServer({
      port: this.port,
      host: this.host,
      verifyClient: (info, done) => this.#verifyClient(info, done),
      // Per-message deflate costs CPU on every frame and buys little on small JSON, while
      // adding latency on exactly the frames that are latency-sensitive.
      perMessageDeflate: false,
      maxPayload: 256 * 1024,
    });

    this.wss.on('connection', (socket, request) => this.#onConnection(socket, request));
    this.wss.on('listening', () =>
      log.info('control server listening', {
        host: this.host,
        port: this.port,
        authenticated: Boolean(this.token),
      })
    );
    this.wss.on('error', (err) => log.error('control server error', { error: err.message }));

    this.#startHeartbeat();
    return this;
  }

  #verifyClient(info, done) {
    if (!this.token) return done(true);

    // The token may come as a header (programmatic clients) or a query parameter (browsers,
    // which cannot set headers on a WebSocket handshake).
    const header = info.req.headers['authorization'];
    const fromHeader = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const url = new URL(info.req.url, 'http://localhost');
    const presented = fromHeader ?? url.searchParams.get('token');

    if (!presented || !safeEqual(presented, this.token)) {
      log.warn('rejected unauthenticated client', { remote: info.req.socket.remoteAddress });
      return done(false, 401, 'Unauthorized');
    }
    done(true);
  }

  #onConnection(socket, request) {
    const id = crypto.randomUUID();
    const client = {
      id,
      socket,
      remote: request.socket.remoteAddress,
      alive: true,
      subscriptions: new Set(['*']),
      connectedAt: Date.now(),
    };
    this.clients.set(id, client);
    log.info('client connected', { clientId: id, remote: client.remote, clients: this.clients.size });

    socket.on('pong', () => {
      client.alive = true;
    });

    socket.on('message', (raw) => this.#onMessage(client, raw));

    socket.on('close', (code) => {
      this.clients.delete(id);
      log.info('client disconnected', { clientId: id, code, clients: this.clients.size });
    });

    socket.on('error', (err) => log.warn('client socket error', { clientId: id, error: err.message }));

    socket.send(
      event('hello', {
        protocolVersion: PROTOCOL_VERSION,
        clientId: id,
        commands: Object.keys(this.handlers).sort(),
      })
    );
  }

  async #onMessage(client, raw) {
    let message;
    try {
      message = parseRequest(raw.toString());
    } catch (err) {
      this.stats.errors += 1;
      return client.socket.send(replyError(null, err.code ?? ErrorCode.BAD_REQUEST, err.message));
    }

    const { id, type, ...params } = message;

    // Round-trip probe. Echoing the client's own timestamp lets it measure latency without a
    // synchronised clock, since both readings come from the client's own clock.
    if (type === 'ping') {
      return client.socket.send(reply(id, { pong: true, clientTs: params.ts ?? null, serverTs: Date.now() }));
    }

    if (type === 'subscribe') {
      client.subscriptions = new Set(Array.isArray(params.events) ? params.events : ['*']);
      return client.socket.send(reply(id, { subscriptions: [...client.subscriptions] }));
    }

    const handler = this.handlers[type];
    if (!handler) {
      this.stats.errors += 1;
      return client.socket.send(replyError(id, ErrorCode.UNKNOWN_COMMAND, `unknown command: ${type}`));
    }

    this.stats.commands += 1;
    const started = Date.now();
    try {
      const result = await handler(params, { client, broadcast: (n, d) => this.broadcast(n, d) });
      client.socket.send(reply(id, result ?? {}));
      log.debug('command handled', { type, ms: Date.now() - started });
    } catch (err) {
      this.stats.errors += 1;
      const code = err instanceof ProtocolError ? err.code : ErrorCode.INTERNAL;
      log.error('command failed', { type, error: err.message, code });
      client.socket.send(replyError(id, code, err.message));
    }
  }

  /**
   * Send an event to subscribed clients.
   *
   * @param {string} name
   * @param {object} data
   * @param {object} [options]
   * @param {boolean} [options.droppable] true for telemetry: skipped on a congested socket.
   */
  broadcast(name, data, { droppable = false } = {}) {
    if (this.clients.size === 0) return 0;

    const frame = event(name, data);
    let sent = 0;

    for (const client of this.clients.values()) {
      if (client.socket.readyState !== client.socket.OPEN) continue;
      if (!client.subscriptions.has('*') && !client.subscriptions.has(name)) continue;

      if (droppable && client.socket.bufferedAmount > BACKPRESSURE_BYTES) {
        this.stats.telemetryDropped += 1;
        continue;
      }

      client.socket.send(frame);
      sent += 1;
    }

    this.stats.eventsSent += sent;
    return sent;
  }

  /**
   * Heartbeat.
   *
   * A TCP connection whose peer vanished without a FIN — a laptop closed, a network dropped —
   * stays "open" to the server indefinitely. Nothing arrives, nothing errors, and the client
   * entry leaks along with anything queued for it. The ping/pong round trip is what detects
   * it, and a client that misses one is terminated rather than closed, because a close
   * handshake with a peer that is not there goes nowhere.
   */
  #startHeartbeat() {
    this.heartbeat = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!client.alive) {
          log.warn('client failed heartbeat, terminating', { clientId: client.id });
          client.socket.terminate();
          this.clients.delete(client.id);
          continue;
        }
        client.alive = false;
        client.socket.ping();
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  async stop() {
    clearInterval(this.heartbeat);
    for (const client of this.clients.values()) client.socket.close(1001, 'server shutting down');
    this.clients.clear();
    await new Promise((resolve) => (this.wss ? this.wss.close(resolve) : resolve()));
    log.info('control server stopped', this.stats);
  }
}

/** Constant-time comparison, so a token cannot be recovered a character at a time. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
