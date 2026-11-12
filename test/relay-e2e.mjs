/**
 * Relay end-to-end test.
 *
 *   node test/relay-e2e.mjs
 *
 * Starts relay-server.mjs, applies the bridge plugin against a fake DSH host,
 * then runs the AstrBot-side Python client over both transports: direct HTTP
 * and the sealed relay tunnel.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeCtx } from './mock-ctx.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PYTHON_CANDIDATES = [
  process.env.DSH_TEST_PYTHON,
  join(ROOT, '..', '.tmp', 'py-dsh-test', 'Scripts', 'python.exe'),
  'C:\Program Files\PyManager\python.exe',
  'python3',
  'python',
].filter((value) => typeof value === 'string' && value !== '');

function pickPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    const probe = spawnSync(candidate, ['-c', 'import cryptography'], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const PYTHON = pickPython();

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
}

async function startRelay() {
  const child = spawn(process.execPath, [join(ROOT, 'relay-server.mjs'), '--port', '0', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolvePort, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('relay did not start')), 5000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const match = /relay listening on [^:]+:(\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited with ${code}`));
    });
  });
  return { child, port };
}

function runPython(args) {
  return new Promise((resolveRun) => {
    const child = spawn(PYTHON, args, { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString('utf8');
      process.stderr.write(chunk);
    });
    child.once('error', (error) => resolveRun({ code: -1, output: `${output}\n${error.message}` }));
    child.once('exit', (code) => resolveRun({ code, output }));
  });
}

const home = await mkdtemp(join(tmpdir(), 'dsh-relay-test-'));
process.env.DSH_HOME = home;

const token = randomBytes(12).toString('base64url');
const room = randomBytes(16).toString('hex');
const key = randomBytes(16).toString('base64url');

const ctx = makeCtx({ reply: (prompt) => `mock reply to: ${prompt}`, delay: 5 });
const plugin = await import('../index.js');
const relay = await startRelay();
console.log(`relay listening on 127.0.0.1:${relay.port}`);

await plugin.apply(ctx, {
  token,
  http: { enabled: true, host: '127.0.0.1', port: 0 },
  relay: { enabled: true, url: `127.0.0.1:${relay.port}`, room, key },
  agent: { timeoutSeconds: 60, sessionsPerPage: 15 },
});

const bridge = plugin.bridgeInstance();
const apiUrl = bridge.api.address;

for (let attempt = 0; attempt < 100; attempt += 1) {
  if (bridge.relay.status().connected) break;
  await new Promise((done) => setTimeout(done, 50));
}
check('bridge joined the relay room', bridge.relay.status().connected === true, bridge.relay.status());

check('python with cryptography is available', PYTHON !== null, PYTHON);
if (PYTHON === null) {
  console.log(`\nrelay-e2e: SKIP python checks (set DSH_TEST_PYTHON)`);
  relay.child.kill();
  ctx.disposeAll();
  process.exit(failures === 0 ? 0 : 1);
}

console.log('direct transport');
const direct = await runPython([
  'test/client_e2e.py',
  '--transport', 'direct',
  '--api-url', apiUrl,
  '--token', token,
]);
check('python direct client passes', direct.code === 0, direct.code);

console.log('relay transport');
const tunnel = await runPython([
  'test/client_e2e.py',
  '--transport', 'relay',
  '--relay-url', `127.0.0.1:${relay.port}`,
  '--room', room,
  '--key', key,
  '--token', token,
]);
check('python relay client passes', tunnel.code === 0, tunnel.code);

relay.child.kill();
ctx.disposeAll();
console.log(failures === 0 ? '\nrelay-e2e: PASS' : `\nrelay-e2e: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
