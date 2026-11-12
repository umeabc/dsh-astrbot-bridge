#!/usr/bin/env node
/**
 * Rendezvous relay for dsh-astrbot-bridge.
 *
 * Wire-compatible with dsh-mobile-relay: a host registers a room, clients join
 * the same room, and the relay forwards opaque framed streams between them.
 * Payloads stay sealed end to end with the room key, which the relay never
 * receives — it only reads the routing header.
 *
 *   handshake  4-byte big-endian length + UTF-8 JSON
 *   frame      1 byte channel | 4 bytes stream | 1 byte type | 2 bytes length | payload
 *
 * Usage: node relay-server.mjs [--port 9443] [--host 0.0.0.0] [--quiet]
 */

import net from 'node:net';

const HEADER = 8;
const MAX_HANDSHAKE = 4096;
const MAX_CLIENTS = 16;
const MAX_CLIENT_BUFFER = 4 * 1024 * 1024;

const TYPE = { HELLO: 0, OPEN: 1, DATA: 2, FIN: 3, RST: 4, PING: 5, CHANNEL_CLOSED: 6 };

function log(...parts) {
  if (process.env.DSH_RELAY_QUIET === '1') return;
  console.log(`[relay ${new Date().toISOString().slice(11, 19)}]`, ...parts);
}

function parseArgs(argv) {
  const options = { port: 9443, host: '0.0.0.0' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--port') options.port = Number(argv[++i]);
    else if (flag === '--host') options.host = argv[++i];
    else if (flag === '--quiet') process.env.DSH_RELAY_QUIET = '1';
    else if (flag === '--help' || flag === '-h') {
      console.log('usage: node relay-server.mjs [--port 9443] [--host 0.0.0.0] [--quiet]');
      process.exit(0);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('relay: --port must be a TCP port');
  }
  return options;
}

class ByteReader {
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

async function writeAll(socket, buffer) {
  if (socket === null || socket.destroyed) return false;
  if (socket.write(buffer)) return true;
  await new Promise((resolve) => {
    const done = () => {
      socket.off('drain', done);
      socket.off('close', done);
      resolve();
    };
    socket.once('drain', done);
    socket.once('close', done);
  });
  return !socket.destroyed;
}

function frame(channel, stream, type, payload) {
  const body = payload ?? Buffer.alloc(0);
  const header = Buffer.alloc(HEADER);
  header[0] = channel & 0xff;
  header.writeUInt32BE(stream >>> 0, 1);
  header[5] = type & 0xff;
  header.writeUInt16BE(body.length, 6);
  return body.length === 0 ? header : Buffer.concat([header, body]);
}

const rooms = new Map();

function roomFor(id) {
  let room = rooms.get(id);
  if (room === undefined) {
    room = { host: null, clients: new Map(), nextChannel: 1 };
    rooms.set(id, room);
  }
  return room;
}

function closeQuietly(socket) {
  try {
    socket.destroy();
  } catch {
    /* already gone */
  }
}

function attachHost(socket, reader, roomId, room) {
  room.host = socket;
  socket.setKeepAlive(true, 30000);
  socket.setNoDelay(true);
  log(`host online   ${roomId.slice(0, 8)}`);

  socket.on('close', () => {
    if (room.host !== socket) return;
    room.host = null;
    for (const client of room.clients.values()) closeQuietly(client.socket);
    room.clients.clear();
    if (room.clients.size === 0) rooms.delete(roomId);
    log(`host offline  ${roomId.slice(0, 8)}`);
  });

  void (async () => {
    try {
      for (;;) {
        const header = await reader.read(HEADER);
        const channel = header[0];
        const length = header.readUInt16BE(6);
        const payload = length === 0 ? null : await reader.read(length);
        const client = room.clients.get(channel);
        if (client === undefined) {
          // Host heartbeat (channel 0): echo it so the host can detect a dead
          // link even when no client is sending traffic.
          if (header[5] === TYPE.PING) await writeAll(socket, header).catch(() => {});
          continue;
        }
        // Never await a client write here: one slow client would stall the
        // host read loop and every other client behind it.
        if (client.socket.writableLength > MAX_CLIENT_BUFFER) {
          closeQuietly(client.socket);
          continue;
        }
        client.socket.write(payload === null ? header : Buffer.concat([header, payload]));
      }
    } catch {
      /* connection ended */
    }
  })();
}

function attachClient(socket, reader, roomId, room, channel, salt) {
  const client = { socket, channel };
  room.clients.set(channel, client);
  socket.setKeepAlive(true, 30000);
  socket.setNoDelay(true);
  log(`client online ${roomId.slice(0, 8)} channel=${channel}`);

  void writeAll(room.host, frame(channel, 0, TYPE.HELLO, salt)).catch(() => {});

  socket.on('close', () => {
    if (room.clients.get(channel) !== client) return;
    room.clients.delete(channel);
    if (room.host !== null) {
      void writeAll(room.host, frame(channel, 0, TYPE.CHANNEL_CLOSED)).catch(() => {});
    }
    log(`client gone   ${roomId.slice(0, 8)} channel=${channel}`);
  });

  void (async () => {
    try {
      for (;;) {
        const header = await reader.read(HEADER);
        const length = header.readUInt16BE(6);
        const payload = length === 0 ? null : await reader.read(length);
        if (room.host === null) break;
        header[0] = channel;
        await writeAll(room.host, payload === null ? header : Buffer.concat([header, payload]));
      }
    } catch {
      /* connection ended */
    }
  })();
}

function allocateChannel(room) {
  for (let attempt = 0; attempt < 255; attempt += 1) {
    const channel = room.nextChannel;
    room.nextChannel = channel >= 255 ? 1 : channel + 1;
    if (!room.clients.has(channel)) return channel;
  }
  return null;
}

function reply(socket, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return writeAll(socket, Buffer.concat([header, body]));
}

async function handle(socket) {
  socket.setNoDelay(true);
  const reader = new ByteReader(socket[Symbol.asyncIterator]());
  let length;
  try {
    length = (await reader.read(4)).readUInt32BE(0);
  } catch {
    socket.destroy();
    return;
  }
  if (length === 0 || length > MAX_HANDSHAKE) {
    await reply(socket, { ok: false, error: 'bad-handshake' });
    socket.destroy();
    return;
  }
  let hello;
  try {
    hello = JSON.parse((await reader.read(length)).toString('utf8'));
  } catch {
    await reply(socket, { ok: false, error: 'bad-handshake' });
    socket.destroy();
    return;
  }
  const roomId = String(hello?.room ?? '').toLowerCase();
  if (hello?.v !== 1 || !/^[0-9a-f]{16,64}$/.test(roomId)) {
    await reply(socket, { ok: false, error: 'bad-room' });
    socket.destroy();
    return;
  }
  const room = roomFor(roomId);

  if (hello.role === 'host') {
    if (room.host !== null) {
      await reply(socket, { ok: false, error: 'room-busy' });
      socket.destroy();
      return;
    }
    await reply(socket, {
      ok: true,
      publicHost: `${String(socket.remoteAddress ?? '').replace(/^::ffff:/, '')}:${socket.remotePort ?? 0}`,
    });
    attachHost(socket, reader, roomId, room);
    return;
  }

  if (hello.role === 'client') {
    if (room.host === null) {
      await reply(socket, { ok: false, error: 'host-offline' });
      socket.destroy();
      return;
    }
    if (room.clients.size >= MAX_CLIENTS) {
      await reply(socket, { ok: false, error: 'room-full' });
      socket.destroy();
      return;
    }
    const salt = Buffer.from(String(hello.salt ?? ''), 'base64');
    if (salt.length !== 16) {
      await reply(socket, { ok: false, error: 'bad-salt' });
      socket.destroy();
      return;
    }
    const channel = allocateChannel(room);
    if (channel === null) {
      await reply(socket, { ok: false, error: 'room-full' });
      socket.destroy();
      return;
    }
    await reply(socket, { ok: true, channel });
    attachClient(socket, reader, roomId, room, channel, salt);
    return;
  }

  await reply(socket, { ok: false, error: 'bad-role' });
  socket.destroy();
}

const options = parseArgs(process.argv.slice(2));
const server = net.createServer((socket) => {
  socket.on('error', () => {});
  void handle(socket).catch(() => closeQuietly(socket));
});
server.listen(options.port, options.host, () => {
  const address = server.address();
  console.log(`relay listening on ${options.host}:${typeof address === 'object' && address !== null ? address.port : options.port}`);
});
server.on('error', (error) => {
  console.error(`relay: ${error.message}`);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref?.();
  });
}
