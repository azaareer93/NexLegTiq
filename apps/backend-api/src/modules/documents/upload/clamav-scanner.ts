import { connect } from 'node:net';
import type { Socket } from 'node:net';
import type { Readable } from 'node:stream';

import { Injectable } from '@nestjs/common';

import { AppConfig } from '../../../config/app-config';

export type ScanResult =
  { readonly infected: false } | { readonly infected: true; readonly signature: string };

/** clamd's INSTREAM chunks: a 4-byte big-endian length, then the bytes; a zero length ends the stream. */
const CHUNK_BYTES = 64 * 1024;

function lengthPrefix(length: number): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(length);
  return prefix;
}

/** `stream: OK` → clean; `stream: <signature> FOUND` → infected; anything else (size limit, errors) is a failure. */
export function parseClamdReply(reply: string): ScanResult {
  const text = reply.replace(/\0+$/, '').trim();
  if (text === 'stream: OK') return { infected: false };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found?.[1]) return { infected: true, signature: found[1].slice(0, 200) };
  throw new Error(`clamd: ${text.slice(0, 200)}`);
}

/**
 * Malware scanning with the ClamAV daemon over TCP (`INSTREAM`, D-035, D-126) — the protocol is a few lines, so no client
 * library. clamd must accept streams of the largest upload (`StreamMaxLength` ≥ 50 MiB; the compose files set 60M).
 * A failure (daemon down, limit, abort) throws: the caller fails closed and never marks the document clean.
 */
@Injectable()
export class ClamavScanner {
  constructor(private readonly config: AppConfig) {}

  async scan(body: Readable, signal: AbortSignal): Promise<ScanResult> {
    const { host, port } = this.config.clamav;
    const socket = connect({ host, port });
    const abort = () => socket.destroy(new Error('Scan aborted'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      const reply = this.reply(socket);
      // clamd may answer (size limit) and close while we still send: the send fails, and the reply must not go unhandled.
      reply.catch(() => undefined);
      await this.send(socket, body);
      return parseClamdReply(await reply);
    } finally {
      signal.removeEventListener('abort', abort);
      socket.destroy();
      body.destroy();
    }
  }

  private async send(socket: Socket, body: Readable): Promise<void> {
    const write = (data: Buffer) =>
      new Promise<void>((resolve, reject) =>
        socket.write(data, (error) => (error ? reject(error) : resolve())),
      );
    await write(Buffer.from('zINSTREAM\0'));
    for await (const chunk of body) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
        const part = data.subarray(offset, offset + CHUNK_BYTES);
        await write(Buffer.concat([lengthPrefix(part.length), part]));
      }
    }
    await write(lengthPrefix(0));
  }

  /** The whole reply (clamd closes the connection after it); a connection error rejects. */
  private reply(socket: Socket): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('error', reject);
      socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }
}
