/**
 * End-to-end test of the HTTP surface and the desktop settings routes against
 * a fake DSH host.
 *
 *   node test/api-e2e.mjs
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from './mock-ctx.mjs';

const TOKEN = 'test-token-123';
let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
}

async function call(base, path, { method = 'GET', body, token = TOKEN } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

/** Invoke one of the registered desktop routes with a fake request/response. */
function callRoute(ctx, path, { method = 'GET', body = '' } = {}) {
  const handler = ctx._routes.get(path);
  if (handler === undefined) throw new Error(`route ${path} is not registered`);
  return new Promise((resolve, reject) => {
    const listeners = new Map();
    const request = {
      method,
      url: path,
      headers: { cookie: 'dsh-auth-test=1' },
      on(event, callback) {
        listeners.set(event, callback);
        return request;
      },
    };
    const response = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(payload) {
        const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: this.status, json, text });
      },
    };
    handler(request, response);
    if (method !== 'GET') {
      setImmediate(() => {
        const chunk = Buffer.from(body, 'utf8');
        listeners.get('data')?.(chunk);
        listeners.get('end')?.();
      });
    } else {
      setImmediate(() => listeners.get('end')?.());
    }
    setTimeout(() => reject(new Error('route timeout')), 3000);
  });
}

const home = await mkdtemp(join(tmpdir(), 'dsh-bridge-test-'));
const workspace = join(home, 'ws');
await mkdir(workspace, { recursive: true });
process.env.DSH_HOME = home;

const artefact = join(home, 'report.txt');
await writeFile(artefact, 'hello', 'utf8');

const ctx = makeCtx({
  reply: (prompt) => (prompt.includes('with-file')
    ? `mock reply to: ${prompt}

已生成：${artefact}`
    : `mock reply to: ${prompt}`),
  delay: 5,
  onTurn: (agent) => {
    if (ctx._failNext === true) {
      ctx._failNext = false;
      ctx.emit('agent/error', { agent, error: Object.assign(new Error('429 Rate Limit Reached'), { code: 'RATE_LIMIT' }) });
    }
  },
});
ctx.get; // keep the mock shape obvious
const plugin = await import('../index.js');
await plugin.apply(ctx, {
  token: TOKEN,
  http: { enabled: true, host: '127.0.0.1', port: 0 },
  agent: { timeoutSeconds: 30, sessionsPerPage: 15 },
  relay: { enabled: false },
});

const bridge = plugin.bridgeInstance();
const base = bridge.api.address;

// Sessions that already exist on this desktop (created by the GUI or the phone bridge).
const now = Date.now();
ctx._state.localSessions = [
  { header: { id: 'desk-1', cwd: 'D:/work', createdAt: now - 60_000 } },
  { header: { id: 'desk-2', cwd: 'D:/harness', createdAt: now - 120_000 } },
  { header: { id: 'desk-sub', cwd: 'D:/harness', createdAt: now - 5_000, origin: 'subagent' } },
];
console.log(`bridge listening on ${base}`);

console.log('auth');
check('missing token is rejected', (await call(base, '/v1/health', { token: null })).status === 401);
check('wrong token is rejected', (await call(base, '/v1/health', { token: 'nope' })).status === 401);
const health = await call(base, '/v1/health');
check('health with token', health.status === 200 && health.json.ok === true, health.json);
check('health reports the effective settings', health.json.timeoutSeconds === 30 && health.json.sessionsPerPage === 15, health.json);
const tokenFile = (await readFile(join(home, 'astrbot-bridge.token'), 'utf8')).trim();
check('token persisted to disk', tokenFile === TOKEN, tokenFile);

console.log('sessions');
const first = await call(base, '/v1/chat', { method: 'POST', body: { chatKey: 'qq/group/1', text: 'first task', follow: true, user: 'alice(42)' } });
check('first chat succeeds', first.status === 200 && first.json.ok === true, first.json);
check('first chat returns the reply', first.json.text === 'mock reply to: first task', first.json);
check('first chat reports a duration', Number.isFinite(first.json.durationMs), first.json);
check('first chat counts the turn', first.json.turns === 1, first.json);
const firstId = first.json.sessionId;

const second = await call(base, '/v1/chat', { method: 'POST', body: { chatKey: 'qq/group/1', text: 'second task', follow: true } });
check('a plain follow starts a new session while mode=new', second.json.sessionId !== firstId, second.json);

let list = await call(base, '/v1/sessions?chatKey=qq%2Fgroup%2F1&includeLocal=false');
check('list has both sessions', list.json.total === 2, list.json);
check('list marks the newest as current', list.json.currentSession === second.json.sessionId, list.json);
check('list keeps mode=new', list.json.mode === 'new', list.json);
check('sessions are grouped by workspace', list.json.workspaces.length >= 1 && Array.isArray(list.json.workspaces[0].sessions), list.json.workspaces);

const switched = await call(base, '/v1/switch', { method: 'POST', body: { chatKey: 'qq/group/1', sessionId: firstId } });
check('switch succeeds', switched.status === 200 && switched.json.sessionId === firstId, switched.json);
check('switch flips mode to continue', switched.json.mode === 'continue', switched.json);

const third = await call(base, '/v1/chat', { method: 'POST', body: { chatKey: 'qq/group/1', text: 'continue it', follow: true } });
check('follow continues the switched session', third.json.sessionId === firstId, third.json);

list = await call(base, '/v1/sessions?chatKey=qq%2Fgroup%2F1&includeLocal=false');
const firstEntry = list.json.workspaces.flatMap((group) => group.sessions).find((entry) => entry.id === firstId);
check('session turn counter accumulates', firstEntry.turns === 2, firstEntry);
check('session title comes from the first prompt', firstEntry.title === 'first task', firstEntry);
check('session records who asked', firstEntry.user === 'alice(42)', firstEntry);

console.log('local sessions');
{
  const listing = await call(base, '/v1/sessions?chatKey=qq%2Flocal%2F1');
  const entries = listing.json.workspaces.flatMap((group) => group.sessions);
  const desktop = entries.filter((entry) => entry.origin === 'desktop');
  check('desktop sessions are listed', desktop.length === 2, entries.map((entry) => entry.id));
  check('desktop session titles are folded', desktop.every((entry) => entry.title.startsWith('桌面 desk-')), desktop);
  check('subagent sessions are hidden', !entries.some((entry) => entry.id === 'desk-sub'), entries.map((entry) => entry.id));
  check('desktop sessions keep their workspace', entries.some((entry) => entry.workspace === 'D:/work'), entries.map((entry) => entry.workspace));

  const switched = await call(base, '/v1/switch', { method: 'POST', body: { chatKey: 'qq/local/1', sessionId: 'desk-1' } });
  check('switching to a desktop session works', switched.status === 200 && switched.json.sessionId === 'desk-1', switched.json);

  const afterSwitch = await call(base, '/v1/sessions?chatKey=qq%2Flocal%2F1');
  const attached = afterSwitch.json.workspaces.flatMap((group) => group.sessions).find((entry) => entry.id === 'desk-1');
  check('the attached session becomes current', afterSwitch.json.currentSession === 'desk-1', afterSwitch.json.currentSession);
  check('the attached session is owned by the chat now', attached?.origin === 'bridge' && attached?.current === true, attached);

  const hidden = await call(base, '/v1/sessions?chatKey=qq%2Flocal%2F1&includeLocal=false');
  check('includeLocal=false hides foreign sessions', hidden.json.total === 1, hidden.json);

  const byIndex = await call(base, '/v1/switch', { method: 'POST', body: { chatKey: 'qq/local/2', index: 2 } });
  check('switching by global index resolves', byIndex.status === 200 && typeof byIndex.json.sessionId === 'string', byIndex.json);
  check('index switch reports the title', byIndex.json.title !== undefined, byIndex.json);

  const outOfRange = await call(base, '/v1/switch', { method: 'POST', body: { chatKey: 'qq/local/2', index: 99 } });
  check('out-of-range index is a 404', outOfRange.status === 404 && String(outOfRange.json.detail).includes('超出范围'), outOfRange.json);
}

console.log('pagination');
for (let index = 0; index < 17; index += 1) {
  await call(base, '/v1/chat', { method: 'POST', body: { chatKey: 'qq/page/9', text: `page task ${index}`, newSession: true } });
}
const page1 = await call(base, '/v1/sessions?chatKey=qq%2Fpage%2F9&page=1&includeLocal=false');
const page2 = await call(base, '/v1/sessions?chatKey=qq%2Fpage%2F9&page=2&includeLocal=false');
const count1 = page1.json.workspaces.flatMap((group) => group.sessions).length;
const count2 = page2.json.workspaces.flatMap((group) => group.sessions).length;
check('page 1 holds one page', count1 === 15, count1);
check('page 2 holds the rest', count2 === 2, count2);
check('page count is exposed', page1.json.pages === 2 && page1.json.total === 17, page1.json);
check('page 2 offset continues numbering', page2.json.offset === 15, page2.json);
check('page size override', (await call(base, '/v1/sessions?chatKey=qq%2Fpage%2F9&perPage=5&page=4&includeLocal=false')).json.workspaces.flatMap((g) => g.sessions).length === 2);

console.log('desktop settings');
const settingsRoute = await callRoute(ctx, '/__astrbot/settings');
check('settings route is registered', settingsRoute.status === 200, settingsRoute.text?.slice(0, 120));
check('settings expose the token', settingsRoute.json?.state?.token === TOKEN, settingsRoute.json?.state);
check('settings expose provider options', Array.isArray(settingsRoute.json?.providers), settingsRoute.json?.providers);

ctx.connection.admit = () => ({ rejection: 'unauthorized' });
const denied = await callRoute(ctx, '/__astrbot/settings');
check('settings require the desktop session', denied.status === 401, denied.status);
ctx.connection.admit = () => ({ ok: true });

const saved = await callRoute(ctx, '/__astrbot/settings', {
  method: 'POST',
  body: JSON.stringify({ settings: { workspace, permission: '', provider: '', model: '', timeoutSeconds: 120, sessionsPerPage: 10 } }),
});
check('settings save', saved.status === 200 && saved.json?.settings?.workspace === workspace, saved.json?.settings);
check('saved timeout applies', saved.json?.settings?.timeoutSeconds === 120, saved.json?.settings);

const afterSave = await call(base, '/v1/chat', { method: 'POST', body: { chatKey: 'qq/ws/1', text: 'in workspace' } });
check('new sessions use the saved workspace', ctx._created.at(-1)?.meta?.cwd === workspace, ctx._created.at(-1));
check('chat response reports the workspace', afterSave.json.workspace === workspace, afterSave.json);

console.log('relay settings');
{
  const badRoom = await callRoute(ctx, '/__astrbot/settings', {
    method: 'POST',
    body: JSON.stringify({ settings: { relay: { enabled: false, room: 'zz' } } }),
  });
  check('bad room id is rejected', badRoom.status === 400, badRoom.text);

  const missingKey = await callRoute(ctx, '/__astrbot/settings', {
    method: 'POST',
    body: JSON.stringify({ settings: { relay: { enabled: true, url: 'relay.example.com:9443', room: 'ab'.repeat(16) } } }),
  });
  check('enabling without a key is rejected', missingKey.status === 400, missingKey.text);

  const relayRoom = 'cd'.repeat(16);
  const relayKey = Buffer.from('0123456789abcdef').toString('base64url');
  const savedRelay = await callRoute(ctx, '/__astrbot/settings', {
    method: 'POST',
    body: JSON.stringify({ settings: { relay: { enabled: false, url: 'relay.example.com:9443', room: relayRoom, key: relayKey } } }),
  });
  check('relay settings save', savedRelay.status === 200 && savedRelay.json?.settings?.relay?.url === 'relay.example.com:9443', savedRelay.json?.settings?.relay);
  check('relay room is normalized', savedRelay.json?.settings?.relay?.room === relayRoom, savedRelay.json?.settings?.relay);
  check('relay toggle stays off', savedRelay.json?.settings?.relay?.enabled === false, savedRelay.json?.settings?.relay);
  check('relay status reflects settings', savedRelay.json?.state?.relay?.enabled === false && savedRelay.json?.state?.relay?.url === 'relay.example.com:9443', savedRelay.json?.state?.relay);
}

const badWorkspace = await callRoute(ctx, '/__astrbot/settings', {
  method: 'POST',
  body: JSON.stringify({ settings: { workspace: join(home, 'missing-dir') } }),
});
check('missing workspace is rejected', badWorkspace.status === 400, badWorkspace.status);

console.log('errors');

check('missing text is a 400', (await call(base, '/v1/chat', { method: 'POST', body: { chatKey: 'k' } })).status === 400);
check('missing chatKey is a 400', (await call(base, '/v1/chat', { method: 'POST', body: { text: 'x' } })).status === 400);
check('unknown route is a 404', (await call(base, '/v1/nope')).status === 404);
check('cancel with nothing running', (await call(base, '/v1/cancel', { method: 'POST', body: { chatKey: 'k' } })).json.cancelled === false);
check('unknown session id is a 404', (await call(base, '/v1/chat', { method: 'POST', body: { chatKey: 'k', text: 'x', sessionId: 'nope' } })).status === 404);

console.log('isolation');
const other = await call(base, '/v1/chat', { method: 'POST', body: { chatKey: 'qq/private/2', text: 'other chat' } });
const otherList = await call(base, '/v1/sessions?chatKey=qq%2Fprivate%2F2&includeLocal=false');
check('other chat only sees its own sessions', otherList.json.total === 1 && otherList.json.currentSession === other.json.sessionId, otherList.json);
check('chatKey separators survive the query string', otherList.json.chatKey === 'qq/private/2', otherList.json);

console.log('notifications');
{
  // A turn the bot never acknowledges must come back as a notification.
  const direct = await plugin.bridgeInstance().runner.chat({ chatKey: 'qq/late/1', text: 'slow task', user: 'bob(7)' });
  check('a direct turn is recorded', typeof direct.turnId === 'string', direct.turnId);
  await new Promise((done) => setTimeout(done, 2700));
  const firstPoll = await call(base, '/v1/notify?chatKey=qq%2Flate%2F1');
  check('unacknowledged turn is delivered', firstPoll.json.notifications.length === 1, firstPoll.json);
  check('notification carries the answer', firstPoll.json.notifications[0]?.text === 'mock reply to: slow task', firstPoll.json.notifications[0]);
  check('notification carries the asker', firstPoll.json.notifications[0]?.user === 'bob(7)', firstPoll.json.notifications[0]);
  const repeatPoll = await call(base, '/v1/notify?chatKey=qq%2Flate%2F1');
  check('unacknowledged turn repeats (at-least-once)', repeatPoll.json.notifications.length === 1, repeatPoll.json);
  const turnId = firstPoll.json.notifications[0]?.turnId;
  await call(base, '/v1/ack', { method: 'POST', body: { chatKey: 'qq/late/1', turnId } });
  const secondPoll = await call(base, '/v1/notify?chatKey=qq%2Flate%2F1');
  check('acked notification stops repeating', secondPoll.json.notifications.length === 0, secondPoll.json);

  // Acknowledged turns never notify.
  const acknowledged = await call(base, '/v1/chat', { method: 'POST', body: { chatKey: 'qq/late/2', text: 'fast task' } });
  await new Promise((done) => setTimeout(done, 2700));
  const afterAck = await call(base, '/v1/notify?chatKey=qq%2Flate%2F2');
  check('acknowledged turn stays quiet', afterAck.json.notifications.length === 0, afterAck.json);
  check('ack endpoint accepts ids', (await call(base, '/v1/ack', { method: 'POST', body: { chatKey: 'qq/late/2', turnId: acknowledged.json.turnId } })).status === 200);

  // Someone continued the session elsewhere: no notification, list marks it.
  const foreignTurn = await plugin.bridgeInstance().runner.chat({ chatKey: 'qq/late/3', text: 'desktop takes over' });
  ctx.emit('session/event', { id: foreignTurn.sessionId }, { type: 'turn/start', data: { turn: 2 } });
  await new Promise((done) => setTimeout(done, 2700));
  const foreignPoll = await call(base, '/v1/notify?chatKey=qq%2Flate%2F3');
  check('foreign continuation suppresses notifications', foreignPoll.json.notifications.length === 0, foreignPoll.json);
  const foreignList = await call(base, '/v1/sessions?chatKey=qq%2Flate%2F3&includeLocal=false');
  const foreignEntry = foreignList.json.workspaces.flatMap((group) => group.sessions)[0];
  check('list marks the session as external', foreignEntry.external === true, foreignEntry);
}

console.log('mid-turn errors');
{
  ctx._failNext = true;
  const failed = await call(base, '/v1/chat', { method: 'POST', body: { chatKey: 'qq/err/1', text: 'boom' } });
  check('error text is returned with the answer', String(failed.json.error ?? '').includes('429'), failed.json.error);
  check('the answer still comes back', failed.json.text === 'mock reply to: boom', failed.json.text);

  const partial = await call(base, '/v1/chat', { method: 'POST', body: { chatKey: 'qq/err/2', text: 'x' } });
  check('clean turns report no error', partial.json.error === '', partial.json.error);
}

console.log('attachments');
{
  const fileTurn = await call(base, '/v1/chat', {
    method: 'POST',
    body: { chatKey: 'qq/files/2', text: 'with-file report' },
  });
  check('a produced file is listed', fileTurn.json.attachments?.[0]?.path === artefact, fileTurn.json.attachments);
  check('the file is not uploaded', fileTurn.json.attachments?.[0]?.name === 'report.txt', fileTurn.json.attachments);
  const plainTurn = await call(base, '/v1/chat', {
    method: 'POST',
    body: { chatKey: 'qq/files/3', text: 'no file this time' },
  });
  check('answers without files list nothing', plainTurn.json.attachments.length === 0, plainTurn.json.attachments);
}

ctx.disposeAll();
console.log(failures === 0 ? '\napi-e2e: PASS' : `\napi-e2e: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
