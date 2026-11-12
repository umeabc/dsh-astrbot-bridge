/**
 * Load the plugin into a real cordis Context.
 *
 * The mock host in api-e2e is a plain object and cannot catch cordis-specific
 * contract violations (a Context proxy rejects writes to properties nobody
 * provided, and that unwinds the whole plugin). This test loads the plugin the
 * way DSH does and fails on any throw.
 *
 *   node test/cordis-load.mjs
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CORDIS_PATH = process.env.DSH_CORDIS_PATH
  ?? 'C:/Users/Administrator/.dsh/profiles/node_modules/@deepseek-ai/cordis/lib/index.js';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
}

const { Context } = await import(pathToFileURL(CORDIS_PATH).href);
const home = await mkdtemp(join(tmpdir(), 'dsh-cordis-test-'));
process.env.DSH_HOME = home;

const routes = new Map();
const agents = new Map();
const ctx = new Context();

ctx.provide('agents', {
  get: (id) => agents.get(id),
  list: () => [...agents.values()],
  create: async ({ sessionId }) => {
    const agent = {
      id: sessionId,
      status: 'idle',
      options: {},
      session: { id: sessionId, header: { cwd: '' }, events: [], seq: 0 },
      followup() {},
      whenIdle: async () => {},
      cancel() {},
    };
    agents.set(sessionId, agent);
    return { agent, dispose: async () => agents.delete(sessionId) };
  },
  resume: async () => {
    throw new Error('no persistence in this harness');
  },
});
ctx.provide('sessions', {
  flush: async () => {},
  create: () => ({}),
  get: () => undefined,
});
ctx.provide('webServer', {
  register: ({ path, handler }) => {
    routes.set(path, handler);
    return () => routes.delete(path);
  },
});
ctx.provide('connection', { admit: () => ({ ok: true }) });

const plugin = await import('../index.js');
let fiber = null;
let failure = null;
try {
  fiber = ctx.plugin(plugin, {
    token: 'cordis-test-token',
    http: { enabled: true, host: '127.0.0.1', port: 0 },
    relay: { enabled: false },
    agent: { timeoutSeconds: 60, sessionsPerPage: 15 },
  });
  await fiber;
} catch (error) {
  failure = error;
}

check('plugin loads without throwing', failure === null, failure?.message ?? String(failure));
check('desktop settings route is registered', routes.has('/__astrbot/settings'), [...routes.keys()]);
check('desktop state route is registered', routes.has('/__astrbot/state'), [...routes.keys()]);

const bridge = plugin.bridgeInstance();
check('bridge instance is reachable', bridge !== null);
check('http api is listening', bridge?.api?.port > 0, bridge?.api?.port);

if (bridge?.api?.port > 0) {
  const response = await fetch(`${bridge.api.address}/v1/health`, {
    headers: { authorization: 'Bearer cordis-test-token' },
  });
  const body = await response.json();
  check('health answers over http', response.status === 200 && body.ok === true, body);
}

if (fiber !== null) {
  await fiber.dispose();
  check('dispose unregisters the routes', routes.size === 0, [...routes.keys()]);
  check('dispose clears the instance', plugin.bridgeInstance() === null);
}

console.log(failures === 0 ? '\ncordis-load: PASS' : `\ncordis-load: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
