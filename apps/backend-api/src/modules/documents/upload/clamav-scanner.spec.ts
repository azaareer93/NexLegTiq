import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { Readable } from 'node:stream';

import { ClamavScanner, parseClamdReply } from './clamav-scanner';
import type { AppConfig } from '../../../config/app-config';

/** A fake clamd: reads one INSTREAM and answers with `reply(bytes received)`. */
function fakeClamd(reply: (received: Buffer) => string | null): Promise<Server> {
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const command = Buffer.from('zINSTREAM\0');
      if (buffer.length < command.length) return;
      let offset = command.length;
      const body: Buffer[] = [];
      while (offset + 4 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        if (length === 0) {
          const answer = reply(Buffer.concat(body));
          if (answer !== null) socket.end(answer);
          return;
        }
        if (offset + 4 + length > buffer.length) return;
        body.push(buffer.subarray(offset + 4, offset + 4 + length));
        offset += 4 + length;
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const scannerFor = (server: Server) =>
  new ClamavScanner({
    clamav: { host: '127.0.0.1', port: (server.address() as AddressInfo).port },
  } as AppConfig);

describe('parseClamdReply', () => {
  it('should read clean, infected and failed replies', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ infected: false });
    expect(parseClamdReply('stream: Eicar-Signature FOUND\0')).toEqual({
      infected: true,
      signature: 'Eicar-Signature',
    });
    expect(() => parseClamdReply('INSTREAM size limit exceeded. ERROR\0')).toThrow(
      'clamd: INSTREAM size limit exceeded. ERROR',
    );
  });
});

describe('ClamavScanner', () => {
  let server: Server;
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  it('should stream the body in chunks and report what clamd found', async () => {
    let received = Buffer.alloc(0);
    server = await fakeClamd((body) => {
      received = body;
      return body.includes('EICAR') ? 'stream: Eicar FOUND\0' : 'stream: OK\0';
    });
    const big = Buffer.alloc(200_000, 7);
    await expect(
      scannerFor(server).scan(
        Readable.from([big, Buffer.from('end')]),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ infected: false });
    expect(received.length).toBe(200_003);
    await expect(
      scannerFor(server).scan(
        Readable.from([Buffer.from('xEICARx')]),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ infected: true, signature: 'Eicar' });
  });

  it('should fail when clamd is unreachable or the scan is aborted', async () => {
    server = await fakeClamd(() => null);
    const controller = new AbortController();
    const scan = scannerFor(server).scan(Readable.from([Buffer.from('data')]), controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(scan).rejects.toThrow();
    const closed = await fakeClamd(() => null);
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    await expect(
      new ClamavScanner({ clamav: { host: '127.0.0.1', port } } as AppConfig).scan(
        Readable.from([Buffer.from('data')]),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
});
