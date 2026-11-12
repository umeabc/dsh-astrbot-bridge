/**
 * Renders the settings section to a standalone HTML preview.
 *
 * The real page needs the desktop's authenticated URL, so this renders the same
 * component tree with the bundle's own CSS and DSH design tokens to check the
 * layout by eye.
 *
 *   node test/preview-render.mjs   →   .tmp/astrbot-settings-preview.html
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

let definition = null;
const styles = [];
const sections = [];

globalThis.window = { __ModuleLoader__: { load(value) { definition = value; } } };
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild: (node) => styles.push(node) },
};

await import('../client.js');

function createReact(hookValues) {
  let index = 0;
  const next = () => (index < hookValues.length ? hookValues[index++] : undefined);
  return {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
    },
    useState(initial) {
      const scripted = next();
      return [scripted === undefined ? initial : scripted, () => {}];
    },
    useEffect() {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
  };
}

const snapshot = {
  settings: {
    workspace: 'D:/harness',
    permission: 'danger-full-access',
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    timeoutSeconds: 900,
    sessionsPerPage: 15,
    relay: { enabled: true, url: 'relay.example.com:9443', room: '3f2a9c41d07b6e58a1c4f0d93b7e6a25', key: 'Zm9vYmFyYmF6cXV4MTIzNDU2Nw' },
  },
  presets: { names: ['workspace-write', 'danger-full-access'], current: 'danger-full-access' },
  providers: [{ id: 'workbuddy', name: 'workbuddy', models: ['deepseek-v4.1-flash'] }],
  defaultSelection: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
  workspaces: [{ id: 'w1', path: 'D:/harness', title: 'harness' }],
  state: {
    token: 'n0iRz49QNAukbF2-hnSYiNML3b6RGsoL',
    bridge: { listening: true, address: 'http://127.0.0.1:8399' },
    relay: { enabled: true, connected: true, url: 'relay.example.com:9443' },
    sessions: { running: [], live: 0 },
  },
};

const shim = createReact(['zh', snapshot, {
  ...snapshot.settings,
  relayEnabled: true,
  relayUrl: snapshot.settings.relay.url,
  relayRoom: snapshot.settings.relay.room,
  relayKey: snapshot.settings.relay.key,
}]);

const plugin = definition.factory((id) => {
  if (id === 'react') return shim;
  throw new Error(`unexpected require: ${id}`);
});

const local = [];
plugin.apply({
  effect(callback) { callback(); },
  slots: {
    inject: (_name, callback) => callback(),
    register: (spec, Component) => { local.push({ spec, Component }); return () => {}; },
  },
  locale: { getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => {} },
});

const tree = local[0].Component();

function escape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const ATTRS = {
  className: 'class', 'data-on': 'data-on', 'data-warn': 'data-warn', 'data-kind': 'data-kind',
  placeholder: 'placeholder', value: 'value', type: 'type', min: 'min', max: 'max',
  checked: 'checked', spellCheck: 'spellcheck', list: 'list', id: 'id',
};

function render(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return escape(node);
  if (Array.isArray(node)) return node.map(render).join('');
  const { type, props } = node;
  if (typeof type === 'function') return '';
  const attrs = [];
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === 'children' || key === 'onClick' || key === 'onChange') continue;
    const name = ATTRS[key] ?? key;
    if (name === 'checked' || name === 'value') {
      if (value === true) attrs.push('checked');
      else if (value !== false && value !== null && value !== undefined) attrs.push(`${name}="${escape(value)}"`);
      continue;
    }
    if (value === true) attrs.push(name);
    else if (value !== false && value !== null && value !== undefined) attrs.push(`${name}="${escape(value)}"`);
  }
  const open = `<${type}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
  if (type === 'input') return open;
  return `${open}${render(props?.children)}</${type}>`;
}

const tokens = `
:root{
  color-scheme:light;
  --dsw-alias-bg-base:#ffffff;
  --dsw-alias-bg-layer-1:#fbfbfc;
  --dsw-alias-bg-layer-2:#f1f2f4;
  --dsw-alias-border-l1:#eceef1;
  --dsw-alias-border-l2:#dfe3e8;
  --dsw-alias-label-primary:#1a1d21;
  --dsw-alias-label-secondary:#6b7280;
  --dsw-alias-label-tertiary:#9aa1ab;
  --dsw-alias-label-primary-foreground:#ffffff;
  --dsw-alias-button-primary-fill:#0f1115;
  --dsw-alias-button-primary-hover:#23262b;
  --dsw-alias-brand-primary:#0f1115;
  --dsw-alias-interactive-bg-hover:#eceef1;
  --dsw-alias-button-info-fill:#2563eb;
  --dsw-alias-state-success-primary:#16a34a;
  --dsw-alias-state-idle-primary:#9aa1ab;
  --dsw-alias-state-warn-primary:#d97706;
  --dsw-alias-state-error-primary:#dc2626;
  font-family:-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
}
body{margin:0;padding:24px;background:#eef1f5}
.frame{max-width:560px;border-radius:16px;background:#fff;padding:20px;box-shadow:0 8px 30px rgba(15,17,21,.08)}
`;

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>AstrBot 设置页预览</title>
<style>${tokens}${styles[0]?.textContent ?? ''}</style></head>
<body><div class="frame">${render(tree)}</div></body></html>`;

const out = resolve(import.meta.dirname, '..', '..', '.tmp', 'astrbot-settings-preview.html');
await mkdir(join(out, '..'), { recursive: true });
await writeFile(out, html, 'utf8');
console.log(out);
