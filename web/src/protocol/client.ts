import type { Transport } from './transport';
import {
  isEventFrame,
  type ConnectionState,
  type EventMap,
  type Frame,
  type ProtocolErrorBody,
} from './types';

export class ProtocolError extends Error {
  readonly code: ProtocolErrorBody['code'];
  constructor(body: ProtocolErrorBody) {
    super(body.message);
    this.name = 'ProtocolError';
    this.code = body.code;
  }
}

type AnyHandler = (data: unknown, ts: number) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ClientOptions {
  transport: Transport;
  /** A command with no reply after this long rejects rather than hanging a button forever. */
  requestTimeoutMs?: number;
}

/**
 * Speaks the control protocol over a transport.
 *
 * Replies are matched to requests by id rather than by arrival order, because the server
 * handles commands concurrently: a `capabilities.get` issued first can easily answer after a
 * `status.get` issued second.
 */
export class LivereelClient {
  #transport: Transport;
  #timeout: number;
  #pending = new Map<string, Pending>();
  #listeners = new Map<string, Set<AnyHandler>>();
  #anyListeners = new Set<(event: string, data: unknown, ts: number) => void>();
  #stateListeners = new Set<(state: ConnectionState, detail?: string) => void>();
  #seq = 0;

  state: ConnectionState = 'idle';
  stateDetail: string | undefined;

  constructor({ transport, requestTimeoutMs = 10_000 }: ClientOptions) {
    this.#transport = transport;
    this.#timeout = requestTimeoutMs;
  }

  get label(): string {
    return this.#transport.label;
  }

  connect(): void {
    this.#transport.open({
      onFrame: (raw) => this.#onFrame(raw),
      onState: (state, detail) => {
        this.state = state;
        this.stateDetail = detail;
        if (state !== 'open') this.#failAllPending(detail ?? `connection ${state}`);
        for (const listener of this.#stateListeners) listener(state, detail);
      },
    });
  }

  disconnect(): void {
    this.#transport.close();
  }

  onState(listener: (state: ConnectionState, detail?: string) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  on<K extends keyof EventMap>(
    event: K,
    handler: (data: EventMap[K], ts: number) => void,
  ): () => void;
  on(event: string, handler: AnyHandler): () => void;
  on(event: string, handler: AnyHandler): () => void {
    const set = this.#listeners.get(event) ?? new Set<AnyHandler>();
    set.add(handler);
    this.#listeners.set(event, set);
    return () => set.delete(handler);
  }

  /** Every event, for the log panel. */
  onAny(handler: (event: string, data: unknown, ts: number) => void): () => void {
    this.#anyListeners.add(handler);
    return () => this.#anyListeners.delete(handler);
  }

  request<T>(type: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.state !== 'open') {
      return Promise.reject(new Error('not connected'));
    }

    const id = `c${++this.#seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${type} timed out after ${this.#timeout}ms`));
      }, this.#timeout);

      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.#transport.send(JSON.stringify({ id, type, ...params }));
    });
  }

  #onFrame(raw: string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      return;
    }

    if (isEventFrame(frame)) {
      const direct = this.#listeners.get(frame.event);
      if (direct) for (const handler of direct) handler(frame.data, frame.ts);

      for (const handler of this.#anyListeners) handler(frame.event, frame.data, frame.ts);
      return;
    }

    // A frame with no id is an error about a message the server could not even parse, so
    // there is nothing to resolve; it is reported through the state channel instead.
    if (frame.id === null || frame.id === undefined) {
      if (frame.ok === false) {
        for (const listener of this.#stateListeners) listener(this.state, frame.error.message);
      }
      return;
    }

    const pending = this.#pending.get(String(frame.id));
    if (!pending) return;

    clearTimeout(pending.timer);
    this.#pending.delete(String(frame.id));

    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new ProtocolError(frame.error));
  }

  #failAllPending(reason: string): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }
}
