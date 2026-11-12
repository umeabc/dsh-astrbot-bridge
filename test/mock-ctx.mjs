/**
 * A minimal stand-in for the parts of the DSH host a bridge plugin talks to.
 *
 * It is deliberately small: the goal is to exercise the bridge's own logic
 * (routing, tokens, session bookkeeping, timeouts) without a live desktop.
 */

class FakeSession {
  constructor(id, cwd = '') {
    this.id = id;
    this.header = { version: 1, cwd };
    this._events = [];
  }

  get events() {
    return this._events;
  }

  get seq() {
    return this._events.length;
  }

  append(type, data) {
    this._events.push({ seq: this._events.length, at: Date.now(), type, data });
  }
}

class FakeAgent {
  constructor({ id, options, reply, delay, echo, cwd = '', onTurn }) {
    this.id = id;
    this.options = options ?? {};
    this.session = new FakeSession(id, cwd);
    this.status = 'idle';
    this.reply = reply;
    this.delay = delay;
    this.echo = echo;
    this.waiters = [];
    this.turn = 0;
    this.timer = null;
    this.onTurn = onTurn;
  }

  followup(message) {
    if (this.status === 'running') throw new Error('agent is already running');
    this.status = 'running';
    this.turn += 1;
    this.session.append('turn/start', { turn: this.turn });
    this.session.append('user/message', message);
    const prompt = message.content.map((block) => block.text ?? '').join('');
    this.timer = setTimeout(() => {
      this.session.append('assistant/message', {
        turn: this.turn,
        step: 1,
        message: {
          id: `reply-${this.turn}`,
          role: 'assistant',
          content: [{ type: 'text', text: this.echo ? this.echo(prompt) : this.reply(prompt) }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        },
      });
      this.session.append('turn/end', { turn: this.turn, reason: 'completed' });
      this.onTurn?.(this);
      this.finish();
    }, this.delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  whenIdle() {
    if (this.status === 'idle') return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  cancel() {
    if (this.status !== 'running') return;
    clearTimeout(this.timer);
    this.session.append('assistant/message', {
      turn: this.turn,
      step: 1,
      interrupted: true,
      message: {
        id: `cancel-${this.turn}`,
        role: 'assistant',
        content: [{ type: 'text', text: '(cancelled)' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      },
    });
    this.finish();
  }

  finish() {
    this.status = 'idle';
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

export function makeCtx({ reply = (prompt) => `echo: ${prompt}`, delay = 10, onTurn } = {}) {
  const agents = new Map();
  const persisted = new Set();
  const disposers = [];
  const listeners = new Map();
  const routes = new Map();
  const state = {
    authorized: true,
    created: [],
    presets: [],
    providers: [],
    models: {},
    currentSelection: null,
    localSessions: [],
  };

  const ctx = {
    sessions: { flush: async () => {} },
    agents: {
      get: (id) => agents.get(id),
      list: () => [...agents.values()],
      create: async ({ sessionId, agentOptions, meta }) => {
        if (agents.has(sessionId)) throw new Error('duplicate session id');
        state.created.push({ sessionId, agentOptions, meta });
        const agent = new FakeAgent({ id: sessionId, options: agentOptions, reply, delay, cwd: meta?.cwd ?? '', onTurn });
        agents.set(sessionId, agent);
        persisted.add(sessionId);
        return {
          agent,
          dispose: async () => {
            agents.delete(sessionId);
          },
        };
      },
      resume: async ({ resumeSessionId, agentOptions }) => {
        if (!persisted.has(resumeSessionId)) throw new Error(`cannot load persisted session ${resumeSessionId}`);
        const agent = new FakeAgent({ id: resumeSessionId, reply, delay, options: agentOptions });
        agents.set(resumeSessionId, agent);
        return {
          agent,
          dispose: async () => {
            agents.delete(resumeSessionId);
          },
        };
      },
    },
    on: (event, handler) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {
        const current = listeners.get(event) ?? [];
        listeners.set(event, current.filter((entry) => entry !== handler));
      };
    },
    get: (name) => {
      if (name === 'permissionPresets') {
        return { names: state.presets, defaultPreset: state.presets[0] ?? '', set: () => {} };
      }
      if (name === 'llm') {
        return {
          listProviders: () => state.providers,
          listModels: async (provider) => (state.models[provider] ?? []).map((id) => ({ id })),
        };
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => state.currentSelection };
      }
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => state.localSessions.map((entry) => ({ header: entry.header, live: false, persisted: true })),
          readTitleSnapshots: async (ids) => ids.map((id) => ({
            sessionId: id,
            status: 'fulfilled',
            value: { session: { id }, title: { title: `桌面 ${id}` } },
          })),
        };
      }
      if (name === 'workspaceRegistry') {
        return { list: () => state.workspaces ?? [] };
      }
      return undefined;
    },
    webServer: {
      register: ({ path, handler }) => {
        routes.set(path, handler);
        return () => routes.delete(path);
      },
    },
    connection: {
      admit: () => (state.authorized ? { ok: true } : { rejection: 'unauthorized' }),
    },
    inject: (_deps, callback) => {
      callback(ctx);
      return undefined;
    },
    effect: (callback) => {
      const dispose = callback();
      disposers.push(dispose);
    },
    disposeAll: () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose?.();
        } catch {
          /* ignored */
        }
      }
    },
    emit: (event, ...args) => {
      for (const handler of listeners.get(event) ?? []) handler(...args);
    },
    // Test helpers.
    dropAgent: (id) => agents.delete(id),
    liveAgents: () => [...agents.values()],
    _routes: routes,
    _created: state.created,
    _state: state,
  };
  return ctx;
}
