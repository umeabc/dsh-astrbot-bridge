/**
 * Wire primitives shared with the relay protocol.
 *
 * Same construction as dsh-remote-plugin / dsh-mobile-relay:
 *   handshake  4-byte big-endian length + UTF-8 JSON
 *   frame      1 byte channel | 4 bytes stream | 1 byte type | 2 bytes length | payload
 *
 * DATA payloads are AES-128-GCM sealed under a key derived from the room key
 * and the client's per-connection salt, so the relay only ever routes
 * ciphertext. The nonce is 4 zero bytes + an 8-byte big-endian counter, and the
 * AAD is the frame header without its first (channel) byte, which the relay
 * rewrites on the client leg.
 */

import { createCipheriv, createDecipheriv, hkdfSync, timingSafeEqual } from 'node:crypto';

export const FRAME = {
  HELLO: 0,
  OPEN: 1,
  DATA: 2,
  FIN: 3,
  RST: 4,
  PING: 5,
  CHANNEL_CLOSED: 6,
};

export const MAX_CHUNK = 16 * 1024;

/** HKDF-SHA256(master, salt, info) -> 16 bytes. */
export function deriveKey(master, salt, info) {
  return Buffer.from(hkdfSync('sha256', master, salt, info, 16));
}

function nonceFor(counter) {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(counter), 4);
  return nonce;
}

/** Seal one payload; `header` carries the final length used as AAD. */
export function seal(key, counter, header, plaintext) {
  const cipher = createCipheriv('aes-128-gcm', key, nonceFor(counter));
  cipher.setAAD(header.subarray(1));
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** Open one sealed payload. Throws when the tag does not verify. */
export function openSealed(key, counter, header, ciphertext) {
  if (ciphertext.length < 16) throw new Error('short ciphertext');
  const decipher = createDecipheriv('aes-128-gcm', key, nonceFor(counter));
  decipher.setAAD(header.subarray(1));
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  return Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
}

export function frameHeader(channel, stream, type, length) {
  const header = Buffer.alloc(8);
  header[0] = channel & 0xff;
  header.writeUInt32BE(stream >>> 0, 1);
  header[5] = type & 0xff;
  header.writeUInt16BE(length & 0xffff, 6);
  return header;
}

export function encodeFrame(channel, stream, type, payload) {
  const body = payload ?? Buffer.alloc(0);
  return Buffer.concat([frameHeader(channel, stream, type, body.length), body]);
}

export function handshakeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental reader over an async iterator of Buffers. */
export class ByteReader {
  constructor(iterator) {
    this.iterator = iterator;
    this.buffer = Buffer.alloc(0);
  }

  async read(length) {
    while (this.buffer.length < length) {
      const { value, done } = await this.iterator.next();
      if (done) throw new Error('eof');
      this.buffer = this.buffer.length === 0 ? value : Buffer.concat([this.buffer, value]);
    }
    const result = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return result;
  }
}

export function writeAsync(socket, buffer) {
  if (socket.destroyed || socket.writableEnded) return Promise.resolve(false);
  if (socket.write(buffer)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const settle = (value) => {
      socket.off('drain', onDrain);
      socket.off('close', onClose);
      resolve(value);
    };
    const onDrain = () => settle(true);
    const onClose = () => settle(false);
    socket.once('drain', onDrain);
    socket.once('close', onClose);
  });
}

/** Constant-time string comparison for secrets. Length differences leak nothing useful here. */
export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
