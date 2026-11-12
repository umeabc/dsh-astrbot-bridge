/**
 * Relay host: keeps an outbound connection to a rendezvous server so a bot on
 * another network can reach this bridge without a port mapping.
 *
 * Frame and key layout match dsh-remote-plugin / dsh-mobile-relay, so either
 * side of the wire can be swapped for the phone bridge implementation.
 */

import { connect } from 'node:net';
import {
  ByteReader,
  FRAME,
  MAX_CHUNK,
  deriveKey,
  frameHeader,
  handshakeMessage,
  openSealed,
  seal,
  writeAsync,
} from './crypto.js';

const HEARTBEAT_MS = 20_000;
const SILENCE_MS = 60_000;

export function parseRelayAddress(value) {
  const trimmed = String(value ?? '').trim().replace(/^tcp:\/\//i, '');
  if (trimmed === '') return null;
  const at = trimmed.lastIndexOf(':');
  const host = at <= 0 ? trimmed : trimmed.slice(0, at);
  const port = at <= 0 ? 9443 : Number(trimmed.slice(at + 1));
  if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

export function parseRoom(value) {
  const room = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{16,64}$/.test(room) ? room : null;
}

export function parseRoomKey(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return null;
  const secret = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return secret.length === 16 ? secret : null;
}

export class RelayHost {
  constructor({ config, apiPort, onStream, log, warn }) {
    this.config = config;
    this.apiPort = apiPort;
    this.onStream = onStream;
    this.log = log;
    this.warn = warn ?? ((...parts) => console.warn('[astrbot-bridge]', ...parts));
    this.socket = null;
    this.connected = false;
    this.stopped = true;
    this.channels = new Map();
    this.loop = null;
    this.backoff = 3000;
    this.lastRxAt = 0;
    this.lastError = '';
    this.wake = null;
    this.writeLock = Promise.resolve();
  }

  get endpoint() {
    return parseRelayAddress(this.config.url);
  }

  get room() {
    return parseRoom(this.config.room);
  }

  get key() {
    return parseRoomKey(this.config.key);
  }

  get enabled() {
    return this.config.enabled !== false;
  }

  status() {
    const endpoint = this.endpoint;
    return {
      enabled: this.enabled,
      configured: endpoint !== null && this.room !== null && this.key !== null,
      connected: this.connected,
      url: endpoint === null ? null : `${endpoint.host}:${endpoint.port}`,
      room: this.room ?? null,
      error: this.lastError || null,
    };
  }

  start() {
    if (this.stopped === false) return;
    this.stopped = false;
    this.loop = this.run();
  }

  async stop() {
    this.stopped = true;
    this.wake?.();
    this.destroyAll();
    if (this.socket !== null) {
      this.socket.destroy();
      this.socket = null;
    }
    await this.loop?.catch(() => {});
    this.loop = null;
    this.connected = false;
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  async run() {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        this.backoff = 3000;
      } catch (error) {
        this.lastError = error?.message ?? String(error);
        if (this.stopped) break;
        this.warn(`relay: ${this.lastError}; retrying in ${Math.round(this.backoff / 1000)}s`);
        await this.sleep(this.backoff);
        this.backoff = Math.min(this.backoff * 2, 30000);
      }
    }
  }

  async connectOnce() {
    const endpoint = this.endpoint;
    const room = this.room;
    const key = this.key;
    if (endpoint === null || room === null || key === null) throw new Error('relay url/room/key incomplete');

    const socket = connect(endpoint.port, endpoint.host);
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    socket.write(handshakeMessage({ v: 1, role: 'host', room }));
    const reader = new ByteReader(socket[Symbol.asyncIterator]());
    const length = (await reader.read(4)).readUInt32BE(0);
    if (length === 0 || length > 4096) throw new Error('bad relay reply');
    const reply = JSON.parse((await reader.read(length)).toString('utf8'));
    if (reply?.ok !== true) throw new Error(`relay refused: ${reply?.error ?? 'unknown'}`);

    this.master = key;
    this.connected = true;
    this.lastError = '';
    this.log(`relay: online at ${endpoint.host}:${endpoint.port} room=${room.slice(0, 8)}`);

    this.lastRxAt = Date.now();
    const heartbeat = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastRxAt > SILENCE_MS) {
        this.warn('relay: heartbeat timeout, redialing');
        socket.destroy();
        return;
      }
      void this.send(0, 0, FRAME.PING).catch(() => {});
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    try {
      await this.readFrames(reader);
    } finally {
      clearInterval(heartbeat);
      this.connected = false;
      this.destroyAll();
      this.socket = null;
      socket.destroy();
    }
  }

  async readFrames(reader) {
    for (;;) {
      const header = await reader.read(8);
      this.lastRxAt = Date.now();
      const channel = header[0];
      const stream = header.readUInt32BE(1);
      const type = header[5];
      const length = header.readUInt16BE(6);
      const payload = length === 0 ? Buffer.alloc(0) : await reader.read(length);

      if (type === FRAME.HELLO) {
        this.openChannel(channel, payload);
        continue;
      }
      if (type === FRAME.CHANNEL_CLOSED) {
        this.closeChannel(channel);
        continue;
      }
      if (type === FRAME.PING) {
        if (channel !== 0) await this.send(channel, 0, FRAME.PING);
        continue;
      }

      const state = this.channels.get(channel);
      if (state === undefined) continue;

      if (type === FRAME.OPEN) {
        this.openStream(state, channel, stream);
        continue;
      }
      if (type === FRAME.DATA) {
        // Counters advance for every DATA frame in wire order, even when its
        // stream is gone, or every later tag on this channel would fail.
        let plaintext;
        try {
          plaintext = openSealed(state.rxKey, state.rxCounter, header, payload);
          state.rxCounter += 1;
        } catch (error) {
          this.warn(`relay: channel ${channel} authentication failed: ${error.message}`);
          this.closeChannel(channel);
          continue;
        }
        const socket = state.streams.get(stream);
        if (socket === undefined || socket.destroyed) continue;
        if (!socket.write(plaintext)) {
          await new Promise((resolve) => {
            socket.once('drain', resolve);
            socket.once('close', resolve);
          });
        }
        continue;
      }
      if (type === FRAME.FIN) {
        // HTTP requests are self-delimiting; the local server closes the
        // socket after answering, and that close sends FIN back to the client.
        continue;
      }
      if (type === FRAME.RST) {
        const socket = state.streams.get(stream);
        if (socket !== undefined) {
          state.streams.delete(stream);
          socket.destroy();
        }
      }
    }
  }

  openChannel(channel, salt) {
    this.closeChannel(channel);
    if (!Buffer.isBuffer(salt) || salt.length !== 16) {
      this.warn(`relay: channel ${channel} carried a bad salt`);
      return;
    }
    this.channels.set(channel, {
      rxKey: deriveKey(this.master, salt, 'dshm/c2h'),
      txKey: deriveKey(this.master, salt, 'dshm/h2c'),
      rxCounter: 0,
      txCounter: 0,
      streams: new Map(),
    });
  }

  closeChannel(channel) {
    const state = this.channels.get(channel);
    if (state === undefined) return;
    for (const socket of state.streams.values()) socket.destroy();
    this.channels.delete(channel);
  }

  openStream(state, channel, stream) {
    if (state.streams.has(stream)) return;
    const socket = connect(this.apiPort, '127.0.0.1');
    state.streams.set(stream, socket);
    socket.setNoDelay(true);
    this.onStream?.(channel, stream);

    socket.on('data', (chunk) => {
      void this.sendData(state, channel, stream, chunk);
    });
    socket.on('close', () => {
      if (state.streams.get(stream) === socket) state.streams.delete(stream);
      void this.send(channel, stream, FRAME.FIN);
    });
    socket.on('error', () => {
      if (state.streams.get(stream) === socket) state.streams.delete(stream);
      void this.send(channel, stream, FRAME.RST);
    });
    socket.on('end', () => {
      // The response side finished; closing also refreshes any pending read.
      socket.end();
    });
  }

  destroyAll() {
    for (const state of this.channels.values()) {
      for (const socket of state.streams.values()) socket.destroy();
    }
    this.channels.clear();
  }

  sendData(state, channel, stream, chunk) {
    const pieces = [];
    for (let offset = 0; offset < chunk.length; offset += MAX_CHUNK) {
      const piece = chunk.subarray(offset, Math.min(offset + MAX_CHUNK, chunk.length));
      const counter = state.txCounter;
      state.txCounter += 1;
      const header = frameHeader(channel, stream, FRAME.DATA, piece.length + 16);
      pieces.push(Buffer.concat([header, seal(state.txKey, counter, header, piece)]));
    }
    return this.write(Buffer.concat(pieces));
  }

  send(channel, stream, type) {
    return this.write(frameHeader(channel, stream, type, 0));
  }

  write(buffer) {
    const socket = this.socket;
    if (socket === null || socket.destroyed) return Promise.resolve(false);
    // Counters must reach the peer in allocation order.
    const next = this.writeLock.then(() => writeAsync(socket, buffer));
    this.writeLock = next.then(() => {}, () => {});
    return next.catch(() => false);
  }
}
