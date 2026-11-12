/**
 * The bridge's own HTTP surface.
 *
 * It listens on loopback only and every route requires the shared token, so
 * exposing it beyond this machine (relay tunnel, SSH forward, LAN bind) never
 * hands out DSH access to an anonymous caller.
 */

import { createServer } from 'node:http';
import { safeEqual } from './crypto.js';
import { parseJsonObject, readText, sendJson } from './http.js';
import { BridgeError } from './runner.js';

const STATUS_FOR = {
  'bad-request': 400,
  unauthorized: 401,
  'session-not-found': 404,
  busy: 409,
  'create-failed': 500,
  'agent-error': 500,
  'bad-workspace': 400,
  'session-busy': 409,
};


export class BridgeApi {
  constructor({ runner, store, config, token, version, log, warn, startedAt }) {
    this.runner = runner;
    this.store = store;
    this.config = config;
    this.token = token;
    this.version = version;
    this.log = log;
    this.warn = warn;
    this.startedAt = startedAt;
    this.relayStatus = null;
    this.server = null;
    this.port = 0;
    this.host = '';
  }

  get address() {
    return `http://${this.host}:${this.port}`;
  }

  authorized(request) {
    const header = request.headers['authorization'];
    const bearer = typeof header === 'string' && /^Bearer\s+/i.test(header)
      ? header.replace(/^Bearer\s+/i, '').trim()
      : '';
    const direct = request.headers['x-dsh-token'];
    const presented = bearer !== '' ? bearer : (typeof direct === 'string' ? direct.trim() : '');
    return presented !== '' && safeEqual(presented, this.token);
  }

  async start() {
    const settings = this.config.http ?? {};
    const host = String(settings.host ?? '127.0.0.1').trim() || '127.0.0.1';
    const port = Number(settings.port ?? 8399);
    this.host = host;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(Number.isInteger(port) ? port : 8399, host, () => {
        this.server.off('error', reject);
        this.port = this.server.address().port;
        resolve();
      });
    });
    return this.port;
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      server.close(finish);
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      const timer = setTimeout(finish, 1500);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  async handle(request, response) {
    if (!this.authorized(request)) {
      sendJson(response, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const path = (request.url ?? '/').split('?')[0];
    const query = new URL(request.url ?? '/', `http://${this.host}:${this.port}`).searchParams;
    try {
      if (path === '/v1/health' && request.method === 'GET') {
        sendJson(response, 200, this.health());
        return;
      }
      if (path === '/v1/sessions' && request.method === 'GET') {
        const page = Number(query.get('page') ?? '1');
        const perPage = Number(query.get('perPage') ?? '');
        const includeLocal = query.get('includeLocal') !== 'false';
        sendJson(response, 200, {
          ok: true,
          ...(await this.runner.list(query.get('chatKey') ?? '', {
            page: Number.isFinite(page) && page > 0 ? page : 1,
            perPage: Number.isFinite(perPage) && perPage > 0 ? perPage : undefined,
            includeLocal,
          })),
        });
        return;
      }
      if (path === '/v1/chat' && request.method === 'POST') {
        const body = parseJsonObject(await readText(request));
        const result = await this.runner.chat({
          chatKey: body.chatKey,
          text: body.text,
          follow: body.follow === true,
          newSession: body.newSession === true,
          sessionId: body.sessionId ?? '',
          timeoutMs: Number.isInteger(body.timeoutMs) ? body.timeoutMs : undefined,
          user: typeof body.user === 'string' ? body.user : '',
        });
        sendJson(response, 200, { ok: true, ...result });
        // The answer reached a live connection; only a dropped client needs
        // the notification path later.
        if (!response.destroyed) {
          this.runner.ack({ chatKey: body.chatKey, turnId: result.turnId });
        }
        return;
      }
      if (path === '/v1/notify' && request.method === 'GET') {
        const chatKey = query.get('chatKey');
        sendJson(response, 200, {
          ok: true,
          notifications: this.runner.pending(chatKey === null ? '' : chatKey),
        });
        return;
      }
      if (path === '/v1/ack' && request.method === 'POST') {
        const body = parseJsonObject(await readText(request));
        sendJson(response, 200, {
          ok: true,
          ...this.runner.ack({ chatKey: body.chatKey, turnId: body.turnId }),
        });
        return;
      }
      if (path === '/v1/switch' && request.method === 'POST') {
        const body = parseJsonObject(await readText(request));
        const result = await this.runner.use({
          chatKey: body.chatKey,
          sessionId: body.sessionId,
          index: Number.isInteger(body.index) ? body.index : undefined,
        });
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (path === '/v1/cancel' && request.method === 'POST') {
        const body = parseJsonObject(await readText(request));
        sendJson(response, 200, { ok: true, ...this.runner.cancel(body.chatKey) });
        return;
      }
      sendJson(response, 404, { ok: false, error: 'not-found' });
    } catch (error) {
      const code = error instanceof BridgeError ? error.code : 'internal';
      const status = STATUS_FOR[code] ?? 500;
      if (status === 500) this.warn(`${request.method} ${path}: ${error?.stack ?? error}`);
      sendJson(response, status, { ok: false, error: code, detail: String(error?.message ?? error) });
    }
  }

  health() {
    const settings = this.runner.settings.effective();
    return {
      ok: true,
      version: this.version,
      uptimeMs: Date.now() - this.startedAt,
      startedAt: new Date(this.startedAt).toISOString(),
      provider: settings.provider,
      model: settings.model,
      workspace: settings.workspace,
      permission: settings.permission,
      timeoutSeconds: settings.timeoutSeconds,
      sessionsPerPage: settings.sessionsPerPage,
      liveSessions: this.runner.handles.size,
      relay: this.relayStatus?.() ?? null,
      ...this.runner.status(),
    };
  }
}
