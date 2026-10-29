import { describe, expect, it, vi } from 'vitest';
import { LivereelClient } from '../protocol/client';
import { MockTransport } from './mockTransport';
import type { CapabilityReport, ProgressSample, StartSessionResult } from '../protocol/types';

/** Connect a client to the stand-in and wait for its hello. */
async function open() {
  const client = new LivereelClient({ transport: new MockTransport(), requestTimeoutMs: 2000 });
  const hello = new Promise<void>((resolve) => client.on('hello', () => resolve()));
  client.connect();
  await vi.advanceTimersByTimeAsync(300);
  await hello;
  return client;
}

describe('MockTransport', () => {
  it('reports a host where every hardware encoder was rejected', async () => {
    vi.useFakeTimers();
    const client = await open();

    const promise = client.request<CapabilityReport>('capabilities.get');
    await vi.advanceTimersByTimeAsync(300);
    const report = await promise;

    const usable = report.encoders.filter((e) => e.usable).map((e) => e.name);
    expect(usable).toEqual(['libx264']);
    expect(report.encoders.find((e) => e.name === 'h264_nvenc')?.reason).toContain('libcuda');

    vi.useRealTimers();
  });

  it('falls back to software and says why when hardware is asked for', async () => {
    vi.useFakeTimers();
    const client = await open();

    const promise = client.request<StartSessionResult>('session.start', { encoder: 'h264_nvenc' });
    await vi.advanceTimersByTimeAsync(300);
    const result = await promise;

    expect(result.encoder).toBe('libx264');
    expect(result.fellBack).toBe(true);
    expect(result.fallbackReason).toContain('libcuda');
    expect(result.hardware).toBe(false);

    vi.useRealTimers();
  });

  it('streams telemetry only while a session is running', async () => {
    vi.useFakeTimers();
    const client = await open();

    const samples: ProgressSample[] = [];
    client.on('session.progress', (sample) => samples.push(sample));

    await vi.advanceTimersByTimeAsync(1500);
    expect(samples).toHaveLength(0);

    const started = client.request<StartSessionResult>('session.start', {});
    await vi.advanceTimersByTimeAsync(300);
    const { sessionId } = await started;

    await vi.advanceTimersByTimeAsync(1600);
    expect(samples.length).toBeGreaterThan(1);
    expect(samples.every((s) => s.sessionId === sessionId)).toBe(true);

    const stopped = client.request('session.stop', { sessionId });
    await vi.advanceTimersByTimeAsync(300);
    await stopped;

    const after = samples.length;
    await vi.advanceTimersByTimeAsync(1600);
    expect(samples).toHaveLength(after);

    vi.useRealTimers();
  });

  it('rejects an unknown command the way the server does', async () => {
    vi.useFakeTimers();
    const client = await open();

    const promise = client.request('nonsense.do');
    const assertion = expect(promise).rejects.toMatchObject({ code: 'unknown_command' });
    await vi.advanceTimersByTimeAsync(300);
    await assertion;

    vi.useRealTimers();
  });

  it('rejects an overlay for a session that does not exist', async () => {
    vi.useFakeTimers();
    const client = await open();

    const promise = client.request('overlay.set', { sessionId: 'ghost', text: 'LIVE' });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'not_found' });
    await vi.advanceTimersByTimeAsync(300);
    await assertion;

    vi.useRealTimers();
  });
});
