/**
 * Loads the settings-page bundle outside DSH and checks both render branches.
 *
 * A tiny React shim supplies hook values, so this catches the failures that
 * would otherwise break the whole Settings dialog (missing export, a hook
 * outside a component, a broken createElement tree) without restarting the
 * desktop app.
 *
 *   node test/client-render.mjs
 */

let definition = null;
const styles = [];
const sections = [];
let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
}

globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      definition = value;
    },
  },
};

globalThis.document = {
  createElement() {
    return {
      dataset: {},
      textContent: '',
      remove() {
        const index = styles.indexOf(this);
        if (index >= 0) styles.splice(index, 1);
      },
    };
  },
  head: {
    appendChild(node) {
      styles.push(node);
    },
  },
};

await import('../client.js');

check('the bundle registers itself', definition !== null);
check('bundle id is namespaced', definition?.id === 'dsh-astrbot-bridge', definition?.id);

/** Minimal React: element objects plus scripted hook values. */
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
    useCallback(fn) {
      return fn;
    },
    useMemo(fn) {
      return fn();
    },
    useRef() {
      return { current: null };
    },
  };
}

function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node === 'object' && node.props !== undefined) {
    for (const [key, value] of Object.entries(node.props)) {
      if (key !== 'children' && (typeof value === 'string' || typeof value === 'number')) out.push(String(value));
      if (key === 'children') flatten(value, out);
      if (Array.isArray(value)) flatten(value, out);
    }
  }
  return out;
}

const snapshot = {
  settings: {
    workspace: 'D:/harness',
    permission: 'danger-full-access',
    provider: 'openai-codex',
    model: 'gpt-6.1-sol',
    timeoutSeconds: 900,
    sessionsPerPage: 15,
    showUntitled: false,
    workspacesOnly: true,
    relay: { enabled: true, url: 'relay.example.com:9443', room: 'ab'.repeat(16), key: 'Zm9vYmFyYmF6cXV4MTIzNDU2Nw' },
  },
  saved: {},
  configured: {},
  defaults: {},
  presets: { names: ['workspace-write', 'danger-full-access'], current: 'danger-full-access' },
  providers: [{ id: 'openai-codex', name: 'Codex', models: ['gpt-6.1-sol', 'gpt-6.1'] }],
  defaultSelection: { provider: 'openai-codex', model: 'gpt-6.1-sol' },
  workspaces: [{ id: 'w1', path: 'D:/harness', title: 'harness' }],
  state: {
    version: '0.1.0',
    home: 'C:/Users/test/.dsh',
    token: 'secret-token',
    tokenPath: 'C:/Users/test/.dsh/astrbot-bridge.token',
    uptimeMs: 1000,
    bridge: { enabled: true, listening: true, address: 'http://127.0.0.1:8399' },
    relay: { enabled: true, connected: false, url: 'relay.example.com:9443' },
    sessions: { running: [], live: 0 },
  },
};

const plugin = definition.factory((id) => {
  if (id === 'react') return createReact([]);
  throw new Error(`unexpected require: ${id}`);
});
check('factory returns the plugin hooks', Array.isArray(plugin.inject) && typeof plugin.apply === 'function', plugin.inject);

const slots = {
  inject(name, callback) {
    callback();
  },
  register(spec, Component) {
    sections.push({ spec, Component });
    return () => {};
  },
};

plugin.apply({
  effect(callback) {
    callback();
  },
  slots,
  locale: {
    getSnapshot: () => ({ active: 'zh' }),
    subscribe: () => () => {},
  },
});

check('a settings section is registered', sections.length === 1, sections.length);
check('section is the astrbot page', sections[0]?.spec?.id === 'astrbot', sections[0]?.spec);
check('section has a label', sections[0]?.spec?.label() === 'AstrBot 桥接', sections[0]?.spec?.label?.());
check('stylesheet was injected', styles.length === 1 && styles[0].textContent.includes('.dsha-root'), styles.length);

const Component = sections[0].Component;

// First frame: no data yet (state and draft are null).
{
  const shim = createReact(['zh', null, null]);
  const tree = withSideEffects(shim);
  const text = flatten(tree).join(' ');
  check('first frame renders the shell', text.includes('AstrBot 通过 /dsh'), text.slice(0, 160));
}

// Loaded frame: scripted state/draft values.
{
  const shim = createReact(['zh', snapshot, {
    ...snapshot.settings,
    relayEnabled: true,
    relayUrl: snapshot.settings.relay.url,
    relayRoom: snapshot.settings.relay.room,
    relayKey: snapshot.settings.relay.key,
  }]);
  const tree = withSideEffects(shim);
  const text = flatten(tree).join(' ');
  check('loaded frame shows the token', text.includes('secret-token'), text.slice(0, 200));
  check('loaded frame shows the workspace', text.includes('D:/harness'), text.slice(0, 200));
  check('loaded frame shows the provider', text.includes('openai-codex'), text.slice(0, 300));
  check('loaded frame shows the model', text.includes('gpt-6.1-sol'), text.slice(0, 300));
  check('loaded frame shows the bridge pill', text.includes('http://127.0.0.1:8399'), text.slice(0, 300));
  check('loaded frame offers the presets', text.includes('danger-full-access'), text.slice(0, 400));
  check('loaded frame shows the section title', text.includes('新会话默认值'), text.slice(0, 400));
  check('relay card is rendered', text.includes('中转隧道') && text.includes('启用中转'), text.slice(0, 500));
  check('relay address is shown', text.includes('relay.example.com:9443'), text.slice(0, 500));
  check('relay room is prefilled', text.includes('abababababababab'), text.slice(0, 600));
  check('generate button is offered', text.includes('生成一对'), text.slice(0, 600));
  check('status shows relay state', text.includes('未连接'), text.slice(0, 500));
  check('list visibility controls are offered', text.includes('显示未命名会话') && text.includes('只显示桌面工作区里的会话'), text.slice(-400));
}

/** The bundle captured `React` from factory(require); reuse the scripted shim. */
function withSideEffects(shim) {
  // Re-run the factory so the component closes over the shim with the right
  // hook script; definitions are cheap and this keeps the test honest.
  const fresh = definition.factory((id) => {
    if (id === 'react') return shim;
    throw new Error(`unexpected require: ${id}`);
  });
  const local = [];
  fresh.apply({
    effect(callback) {
      callback();
    },
    slots: {
      inject(name, callback) {
        callback();
      },
      register(spec, Component) {
        local.push({ spec, Component });
        return () => {};
      },
    },
    locale: {
      getSnapshot: () => ({ active: 'zh' }),
      subscribe: () => () => {},
    },
  });
  return local[0].Component();
}

console.log(failures === 0 ? '\nclient-render: PASS' : `\nclient-render: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
