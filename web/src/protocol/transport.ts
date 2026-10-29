import type { ConnectionState } from './types';

/**
 * What the client needs from whatever is carrying frames.
 *
 * The panel talks to a real service over a WebSocket and to the bundled demo over an
 * in-process fake. Keeping the client behind this interface is what lets the demo exercise
 * the same request correlation, the same event routing and the same components, rather than
 * being a separate screen full of hardcoded values.
 */
export interface Transport {
  open(handlers: TransportHandlers): void;
  send(payload: string): void;
  close(): void;
  readonly label: string;
}

export interface TransportHandlers {
  onFrame(raw: string): void;
  onState(state: ConnectionState, detail?: string): void;
}

export interface WebSocketTransportOptions {
  url: string;
  token?: string;
  /** Injectable so the tests do not need a real socket. */
  factory?: (url: string) => WebSocketLike;
}

/** The slice of WebSocket this uses, so a fake can stand in without casting. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((this: unknown, ev: unknown) => unknown) | null;
  onclose: ((this: unknown, ev: { code: number; reason: string }) => unknown) | null;
  onerror: ((this: unknown, ev: unknown) => unknown) | null;
  onmessage: ((this: unknown, ev: { data: unknown }) => unknown) | null;
}

export class WebSocketTransport implements Transport {
  readonly label: string;
  #url: string;
  #factory: (url: string) => WebSocketLike;
  #socket: WebSocketLike | null = null;
  #closedByUs = false;

  constructor({ url, token, factory }: WebSocketTransportOptions) {
    // A browser cannot set an Authorization header on a WebSocket handshake, so the service
    // also accepts the token as a query parameter. That is the path used here.
    const full = new URL(url);
    if (token) full.searchParams.set('token', token);

    this.#url = full.toString();
    this.#factory = factory ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
    this.label = `${full.host}`;
  }

  open(handlers: TransportHandlers): void {
    this.#closedByUs = false;
    handlers.onState('connecting');

    let socket: WebSocketLike;
    try {
      socket = this.#factory(this.#url);
    } catch (err) {
      handlers.onState('error', err instanceof Error ? err.message : String(err));
      return;
    }
    this.#socket = socket;

    socket.onopen = () => handlers.onState('open');
    socket.onmessage = (ev) => handlers.onFrame(String(ev.data));
    socket.onerror = () =>
      // A browser deliberately hides why a WebSocket failed, so there is nothing more
      // specific to report here than that it did.
      handlers.onState('error', 'the connection failed');
    socket.onclose = (ev) => {
      if (this.#closedByUs) return handlers.onState('idle');
      handlers.onState(
        'closed',
        ev.code === 1006 ? 'the connection dropped' : ev.reason || `closed (${ev.code})`,
      );
    };
  }

  send(payload: string): void {
    this.#socket?.send(payload);
  }

  close(): void {
    this.#closedByUs = true;
    this.#socket?.close(1000, 'client closed');
    this.#socket = null;
  }
}
