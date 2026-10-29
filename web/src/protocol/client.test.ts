import { describe, expect, it, vi } from 'vitest';
import { LivereelClient, ProtocolError } from './client';
import type { Transport, TransportHandlers } from './transport';

/** A transport that hands the test direct control over what arrives and when. */
class FakeTransport implements Transport {
  readonly label = 'fake';
  sent: string[] = [];
  handlers!: TransportHandlers;

  open(handlers: TransportHandlers): void {
    this.handlers = handlers;
    handlers.onState('open');
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.handlers.onState('idle');
  }

  deliver(frame: unknown): void {
    this.handlers.onFrame(JSON.stringify(frame));
  }

  lastId(): string {
    const last = this.sent[this.sent.length - 1];
    return JSON.parse(last ?? '{}').id;
  }

  idAt(index: number): string {
    return JSON.parse(this.sent[index] ?? '{}').id;
  }
}

function connected() {
  const transport = new FakeTransport();
  const client = new LivereelClient({ transport, requestTimeoutMs: 50 });
  client.connect();
  return { transport, client };
}

describe('LivereelClient', () => {
  it('resolves a request with the result of its own reply', async () => {
    const { transport, client } = connected();

    const promise = client.request<{ uptimeMs: number }>('status.get');
    transport.deliver({ id: transport.lastId(), ok: true, result: { uptimeMs: 1234 } });

    await expect(promise).resolves.toEqual({ uptimeMs: 1234 });
  });

  it('matches replies by id, not by arrival order', async () => {
    const { transport, client } = connected();

    const first = client.request<string>('capabilities.get');
    const second = client.request<string>('status.get');

    // The server answers the second command first, which is normal: handlers run
    // concurrently and a probe takes longer than a counter read.
    transport.deliver({ id: transport.idAt(1), ok: true, result: 'status' });
    transport.deliver({ id: transport.idAt(0), ok: true, result: 'capabilities' });

    await expect(second).resolves.toBe('status');
    await expect(first).resolves.toBe('capabilities');
  });

  it('rejects with the error code the server sent', async () => {
    const { transport, client } = connected();

    const promise = client.request('session.stop', { sessionId: 'nope' });
    transport.deliver({
      id: transport.lastId(),
      ok: false,
      error: { code: 'not_found', message: 'no such session: nope' },
    });

    await expect(promise).rejects.toBeInstanceOf(ProtocolError);
    await expect(promise).rejects.toMatchObject({
      code: 'not_found',
      message: 'no such session: nope',
    });
  });

  it('routes events to their listeners and never to a pending request', async () => {
    const { transport, client } = connected();
    const onProgress = vi.fn();
    client.on('session.progress', onProgress);

    const pending = client.request('status.get');
    transport.deliver({ type: 'event', event: 'session.progress', data: { speed: 0.9 }, ts: 1 });

    expect(onProgress).toHaveBeenCalledWith({ speed: 0.9 }, 1);

    transport.deliver({ id: transport.lastId(), ok: true, result: 'ok' });
    await expect(pending).resolves.toBe('ok');
  });

  it('keeps the event log out of the telemetry stream', () => {
    const { transport, client } = connected();
    const seen: string[] = [];
    client.onAny((event) => seen.push(event));

    transport.deliver({ type: 'event', event: 'hello', data: {}, ts: 1 });
    transport.deliver({ type: 'event', event: 'session.started', data: {}, ts: 2 });

    expect(seen).toEqual(['hello', 'session.started']);
  });

  it('times out a request that is never answered', async () => {
    vi.useFakeTimers();
    const { client } = connected();

    const promise = client.request('status.get');
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;

    vi.useRealTimers();
  });

  it('fails everything in flight when the connection drops', async () => {
    const { transport, client } = connected();

    const promise = client.request('status.get');
    transport.handlers.onState('closed', 'the connection dropped');

    await expect(promise).rejects.toThrow('the connection dropped');
  });

  it('refuses to send while not connected', async () => {
    const transport = new FakeTransport();
    const client = new LivereelClient({ transport });

    await expect(client.request('status.get')).rejects.toThrow('not connected');
    expect(transport.sent).toHaveLength(0);
  });

  it('ignores a frame that is not valid JSON instead of throwing', () => {
    const { transport, client } = connected();
    expect(() => transport.handlers.onFrame('{not json')).not.toThrow();
    expect(client.state).toBe('open');
  });
});
