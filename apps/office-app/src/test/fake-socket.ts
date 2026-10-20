/** A stand-in for socket.io-client's `io` (no network in tests): records sockets and lets a test play the server. */
export class FakeSocket {
  readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  readonly anyHandlers: ((event: string, payload: unknown) => void)[] = [];
  disconnected = false;

  constructor(
    readonly url: string,
    readonly options: { auth?: { token?: string } },
  ) {}

  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  onAny(handler: (event: string, payload: unknown) => void): this {
    this.anyHandlers.push(handler);
    return this;
  }

  disconnect(): this {
    this.disconnected = true;
    return this;
  }

  /** The server sends an event. */
  push(event: string, payload: unknown): void {
    for (const handler of this.anyHandlers) handler(event, payload);
  }

  /** A lifecycle event (`connect_error`, `disconnect`). */
  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

export const sockets: FakeSocket[] = [];

export const io = (url: string, options: { auth?: { token?: string } }): FakeSocket => {
  const socket = new FakeSocket(url, options);
  sockets.push(socket);
  return socket;
};
