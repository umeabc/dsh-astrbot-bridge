/**
 * dsh-astrbot-bridge — let an AstrBot instance drive DeepSeek Harness sessions.
 *
 * The bridge owns four things:
 *   - a token-protected loopback HTTP API (`/v1/chat`, `/v1/sessions`, …);
 *   - the chat → session bookkeeping the bot needs to list and switch
 *     conversations (`~/.dsh/astrbot-bridge.json`);
 *   - an optional outbound relay tunnel, so a bot that cannot reach this
 *     machine can still join a room and speak HTTP through it;
 *   - a Settings → AstrBot section that edits workspace, permission, provider
 *     and model without touching YAML.
 */

import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeStore, dshHome } from './lib/store.js';
import { SettingsService } from './lib/settings.js';
import { SessionRunner } from './lib/runner.js';
import { LocalSessions } from './lib/local.js';
import { BridgeApi } from './lib/api.js';
import { RelayHost } from './lib/relay.js';
import { parseJsonObject, readText, sendJson, sendText } from './lib/http.js';

export const name = 'dsh-astrbot-bridge';
export const inject = ['agents', 'sessions'];

const VERSION = '0.2.0';

const DEFAULTS = {
  token: '',
  releaseAfterTurn: true,
  http: { enabled: true, host: '127.0.0.1', port: 8399 },
  relay: { enabled: false, url: '', room: '', key: '' },
  agent: {
    workspace: '',
    permission: '',
    provider: '',
    model: '',
    timeoutSeconds: 900,
    sessionsPerPage: 15,
  },
};

const TOKEN_FILE = 'astrbot-bridge.token';

/**
 * Last active bridge instance, for tests and same-process diagnostics.
 *
 * This deliberately stays off the cordis Context: assigning a property a
 * Context never provided throws, and that would unwind the whole plugin.
 */
let currentInstance = null;

export function bridgeInstance() {
  return currentInstance;
}

function mergeConfig(config) {
  const raw = config ?? {};
  return {
    token: typeof raw.token === 'string' ? raw.token.trim() : '',
    releaseAfterTurn: raw.releaseAfterTurn !== false,
    http: { ...DEFAULTS.http, ...(raw.http ?? {}) },
    relay: { ...DEFAULTS.relay, ...(raw.relay ?? {}) },
    agent: { ...DEFAULTS.agent, ...(raw.agent ?? {}) },
  };
}

function randomToken() {
  return randomBytes(24).toString('base64url');
}

export async function apply(ctx, config) {
  const settings = mergeConfig(config);
  const startedAt = Date.now();
  const log = (...parts) => console.log('[astrbot-bridge]', ...parts);
  const warn = (...parts) => console.warn('[astrbot-bridge]', ...parts);

  const store = await new BridgeStore(BridgeStore.defaultPath()).load();
  const settingsService = new SettingsService({ store, config: settings, ctx, warn });

  // A configured token wins; otherwise reuse the generated one so restarts do
  // not invalidate the bot's config, and keep a copy on disk for humans.
  let token = settings.token;
  if (token === '') {
    token = store.data.token;
    if (token === '') {
      token = randomToken();
      store.data.token = token;
      await store.save();
    }
  }
  const tokenPath = join(dshHome(), TOKEN_FILE);
  try {
    await writeFile(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    warn(`cannot write ${tokenPath}: ${error.message}`);
  }

  const local = new LocalSessions({ ctx, warn });
  const runner = new SessionRunner({ ctx, store, config: settings, settings: settingsService, local, log, warn });

  let api = null;
  if (settings.http.enabled !== false) {
    api = new BridgeApi({
      runner,
      store,
      config: settings,
      token,
      version: VERSION,
      log,
      warn,
      startedAt,
    });
    try {
      await api.start();
      log(`http: listening on ${api.address}`);
    } catch (error) {
      warn(`http: cannot listen: ${error.message}`);
      api = null;
    }
  }

  // The tunnel is configured from the settings page, so it can be restarted
  // when those values change instead of being pinned at boot.
  let relay = null;
  const relayController = {
    status() {
      if (relay !== null) return relay.status();
      const desired = settingsService.effective().relay;
      return {
        enabled: desired.enabled === true,
        configured: desired.url !== '' && desired.room !== '' && desired.key !== '',
        connected: false,
        url: desired.url === '' ? null : desired.url,
        room: desired.room === '' ? null : desired.room,
        error: null,
      };
    },
    async stop() {
      await relay?.stop().catch(() => {});
      relay = null;
    },
    async start() {
      await this.stop();
      if (api === null) return null;
      const desired = settingsService.effective().relay;
      if (desired.enabled !== true) return null;
      const host = new RelayHost({
        config: desired,
        apiPort: api.port,
        log,
        warn,
        onStream: (channel, stream) => log(`relay: stream ${channel}/${stream}`),
      });
      if (host.endpoint === null || host.room === null || host.key === null) {
        warn('relay: 地址 / 房间 / 密钥不完整，隧道保持空闲');
        return null;
      }
      host.start();
      relay = host;
      log(`relay: connecting to ${desired.url} room=${desired.room.slice(0, 8)}`);
      return host;
    },
  };
  await relayController.start();
  if (api !== null) api.relayStatus = () => relayController.status();

  const instance = {
    version: VERSION,
    api,
    relay: relayController,
    runner,
    local,
    store,
    settings: settingsService,
    token,
    tokenPath,
    restartRelay: () => relayController.start(),
  };

  // Settings → AstrBot exists only where a desktop web server does; a headless
  // profile still gets the HTTP API and the relay.
  ctx.inject(['webServer', 'connection'], (scoped) => {
    registerDesktopRoutes(scoped, instance, { log, warn, tokenPath, startedAt });
  });

  ctx.effect(() => () => {
    void relayController.stop().catch(() => {});
    void api?.stop().catch(() => {});
    for (const handle of runner.handles.values()) {
      void handle.dispose().catch(() => {});
    }
    runner.handles.clear();
    if (currentInstance === instance) currentInstance = null;
  });

  currentInstance = instance;

  log(`ready (v${VERSION}) · home=${dshHome()} · token=${tokenPath} · cwd=${settingsService.effective().workspace || homedir()}`);
}

/**
 * Desktop-only routes behind the normal DSH browser session, reading and
 * writing the same settings the bot API uses.
 */
function registerDesktopRoutes(scoped, instance, { log, warn, tokenPath, startedAt }) {
  const { settings, runner, api } = instance;
  const routes = [];

  const authorized = (request) => {
    try {
      const admission = scoped.connection.admit({ headers: request.headers });
      return !('rejection' in admission);
    } catch {
      return false;
    }
  };

  const route = (kind, path, handler) => {
    routes.push(scoped.webServer.register({ kind, path, handler }));
  };

  const workspaces = () => {
    const registry = scoped.get('workspaceRegistry');
    if (registry === undefined) return [];
    try {
      return registry.list().map((entry) => ({ id: entry.id, path: entry.path, title: entry.title }));
    } catch {
      return [];
    }
  };

  const snapshot = async () => ({
    ...(await settings.snapshot()),
    workspaces: workspaces(),
    state: {
      version: instance.version,
      home: dshHome(),
      token: instance.token,
      tokenPath,
      uptimeMs: Date.now() - startedAt,
      bridge: {
        enabled: api !== null,
        listening: api !== null,
        address: api?.address ?? null,
      },
      relay: instance.relay.status(),
      sessions: runner.status(),
    },
  });

  route('exact', '/__astrbot/settings', async (request, response) => {
    if (!authorized(request)) return sendText(response, 401, 'unauthorized');
    try {
      if (request.method === 'GET' || request.method === 'HEAD') {
        sendJson(response, 200, await snapshot());
        return;
      }
      if (request.method !== 'POST') return sendText(response, 405, 'method not allowed');
      const body = parseJsonObject(await readText(request));
      const patch = body.settings !== null && typeof body.settings === 'object' ? body.settings : body;
      await settings.save(patch);
      if (patch !== null && typeof patch === 'object' && 'relay' in patch) {
        await instance.restartRelay();
      }
      log(`settings saved: ${JSON.stringify(await settings.snapshot().then((value) => value.settings))}`);
      sendJson(response, 200, await snapshot());
    } catch (error) {
      sendJson(response, 400, { error: 'bad-request', detail: String(error?.message ?? error) });
    }
  });

  route('exact', '/__astrbot/state', (request, response) => {
    if (!authorized(request)) return sendText(response, 401, 'unauthorized');
    sendJson(response, 200, {
      bridge: { enabled: api !== null, listening: api !== null, address: api?.address ?? null },
      relay: instance.relay.status(),
      sessions: runner.status(),
    });
  });

  scoped.effect(() => () => {
    for (const dispose of routes.splice(0)) {
      try {
        dispose();
      } catch {
        /* already gone */
      }
    }
  });

  log('desktop settings route: /__astrbot/settings');
}
