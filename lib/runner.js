/**
 * Drive DSH agent sessions on behalf of the AstrBot bridge.
 *
 * One chat key owns at most one *current* session, and one session is driven by
 * exactly one turn at a time. The runner reuses a live agent when the desktop
 * already has it open, resumes a persisted session otherwise, and creates a
 * fresh one when asked to.
 *
 * Two behaviours exist for the bot's benefit:
 *   - a turn that finished without the bot confirming receipt becomes a
 *     notification ("主动消息"), so an answer is not lost when the bot timed out
 *     or its connection dropped;
 *   - a session someone continued on the desktop (or through dsh-remote-plugin)
 *     is marked foreign, and the bot stops notifying for it.
 */

import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { collectAttachments } from './attachments.js';

const MAX_TITLE = 48;
const DEFAULT_PER_PAGE = 15;
/** A turn must stay unacknowledged this long before it counts as undelivered. */
const DELIVERY_GRACE_MS = 2500;
const TURN_RETENTION_MS = 10 * 60 * 1000;

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class SessionRunner {
  constructor({ ctx, store, config, settings, local, log, warn }) {
    this.ctx = ctx;
    this.store = store;
    this.config = config;
    this.settings = settings;
    this.local = local;
    this.log = log;
    this.warn = warn;
    /** sessionId -> AgentHandle (only while a turn is in flight or recently used). */
    this.handles = new Map();
    /** chatKey -> tail promise, one serialized turn per chat. */
    this.queues = new Map();
    /** chatKey -> in-flight turn record. */
    this.running = new Map();
    /** sessionId -> last agent-level failure text. */
    this.failures = new Map();
    /** sessionIds the bridge created or drove; used to spot outside continuation. */
    this.known = new Set();
    /** sessionIds someone else continued; notifications are suppressed for them. */
    this.foreign = new Set();
    /** sessionIds with a turn driven right now. */
    this.activeTurns = new Set();
    /** turnId -> finished turn waiting for acknowledgement. */
    this.turns = new Map();

    for (const chat of Object.values(this.store.data.chats ?? {})) {
      for (const id of Object.keys(chat?.sessions ?? {})) this.known.add(id);
    }

    if (typeof this.ctx.on === 'function') {
      this.ctx.on('agent/error', (payload) => {
        const id = payload?.agent?.id;
        if (typeof id !== 'string') return;
        this.failures.set(id, describeError(payload?.error));
      });
      this.ctx.on('session/event', (session, event) => {
        if (event?.type !== 'turn/start') return;
        const id = session?.id;
        if (typeof id !== 'string' || !this.known.has(id)) return;
        if (this.activeTurns.has(id)) return;
        this.markForeign(id);
      });
    }
  }

  agentOptions() {
    const settings = this.settings.effective();
    const options = {};
    if (settings.provider !== '') options.provider = settings.provider;
    if (settings.model !== '') options.model = settings.model;
    return options;
  }

  /** Serialize turns per chat key so one conversation never overlaps itself. */
  enqueue(chatKey, task) {
    const previous = this.queues.get(chatKey) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => {});
    this.queues.set(chatKey, settled);
    settled.then(() => {
      if (this.queues.get(chatKey) === settled) this.queues.delete(chatKey);
    });
    return next;
  }

  async agentFor(sessionId, { owned = false } = {}) {
    const live = this.ctx.agents.get(sessionId);
    if (live !== undefined) {
      this.applyPreset(live);
      return live;
    }
    let handle;
    try {
      // A session the bridge did not create keeps its own recorded model route;
      // only bridge-owned sessions take the settings-page default.
      handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        ...(owned ? { agentOptions: this.agentOptions() } : {}),
      });
    } catch (error) {
      const message = String(error?.message ?? error);
      if (/duplicate|already|collision|registered/i.test(message)) {
        throw new BridgeError('session-busy', '这个会话正被 DSH 桌面端打开，请先在桌面端关掉它再试');
      }
      throw new BridgeError('session-not-found', `cannot resume session ${sessionId}: ${message}`);
    }
    this.handles.set(sessionId, handle);
    this.applyPreset(handle.agent);
    return handle.agent;
  }

  async createAgent() {
    const sessionId = randomUUID();
    const workspace = await this.settings.resolveWorkspace().catch((error) => {
      throw new BridgeError('bad-workspace', error.message);
    });
    let handle;
    try {
      handle = await this.ctx.agents.create({
        sessionId,
        agentOptions: this.agentOptions(),
        ...(workspace === '' ? {} : { meta: { cwd: workspace } }),
      });
    } catch (error) {
      throw new BridgeError('create-failed', `cannot create a session: ${error?.message ?? error}`);
    }
    this.handles.set(sessionId, handle);
    this.applyPreset(handle.agent);
    return handle.agent;
  }

  /**
   * Let the desktop take a session back as soon as the turn is over: a live
   * agent always wins the id collision, and while the bridge holds one the GUI
   * could not open that conversation.
   */
  async release(agent) {
    if (this.config.releaseAfterTurn === false) return;
    const handle = this.handles.get(agent.id);
    if (handle === undefined) return;
    this.handles.delete(agent.id);
    try {
      await this.ctx.sessions.flush(agent.session);
    } catch (error) {
      this.warn(`cannot flush ${agent.id} before release: ${error?.message ?? error}`);
    }
    try {
      await handle.dispose();
    } catch (error) {
      this.warn(`cannot release ${agent.id}: ${error?.message ?? error}`);
    }
  }

  /**
   * Unattended runs must never block on a permission prompt nobody can answer.
   * An empty preset keeps whatever the desktop pinned for a new session.
   */
  applyPreset(agent) {
    const preset = this.settings.effective().permission;
    if (preset === '') return;
    const service = typeof this.ctx.get === 'function' ? this.ctx.get('permissionPresets') : undefined;
    if (service === undefined) return;
    try {
      service.set(agent.session, preset);
    } catch (error) {
      this.warn(`cannot apply permission preset "${preset}": ${error?.message ?? error}`);
    }
  }

  /** Build the identified user message the model sees for one chat instruction. */
  message(text) {
    const body = text.length > 20000 ? `${text.slice(0, 20000)}\n\n[truncated by dsh-astrbot-bridge]` : text;
    return deepFreeze({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: body }],
      source: { kind: 'user' },
    });
  }

  async runTurn(agent, text, timeoutMs) {
    const before = agent.session.seq;
    const message = this.message(text);
    this.failures.delete(agent.id);
    this.activeTurns.add(agent.id);

    try {
      agent.followup(message);
    } catch (error) {
      this.activeTurns.delete(agent.id);
      throw new BridgeError('busy', `session is busy: ${error?.message ?? error}`);
    }

    // followup() wakes the driver synchronously; let the loop publish its turn
    // before waiting so whenIdle() cannot observe the moment before the wake.
    await new Promise((resolve) => setImmediate(resolve));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        agent.cancel({ kind: 'user' });
      } catch (error) {
        this.warn(`cancel failed for ${agent.id}: ${error?.message ?? error}`);
      }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      await agent.whenIdle();
    } finally {
      clearTimeout(timer);
      this.activeTurns.delete(agent.id);
    }

    const events = agent.session.events.slice(before);
    let reply = '';
    let turns = 0;
    let steps = 0;
    let interrupted = false;
    for (const event of events) {
      if (event.type === 'assistant/message') {
        if (event.data?.interrupted === true) interrupted = true;
        const text = textOfMessage(event.data?.message);
        if (text.trim() !== '') reply = text;
        steps += 1;
      } else if (event.type === 'turn/end') {
        turns += 1;
      }
    }
    return {
      reply,
      turns,
      steps,
      interrupted: interrupted || timedOut,
      timedOut,
      failure: this.failures.get(agent.id) ?? '',
    };
  }

  /**
   * Run one instruction.
   *
   * `follow` keeps the chat on its current session when the user switched to
   * one with "/dsh <n>"; otherwise each call starts a fresh conversation.
   */
  async chat({ chatKey, text, follow = false, newSession = false, sessionId = '', timeoutMs, user = '' }) {
    const key = String(chatKey ?? '').trim();
    if (key === '') throw new BridgeError('bad-request', 'chatKey is required');
    if (key.length > 200) throw new BridgeError('bad-request', 'chatKey is too long');
    const prompt = String(text ?? '').trim();
    if (prompt === '') throw new BridgeError('bad-request', 'text is required');
    // Who asked, for the session list and notifications; never part of the prompt.
    const who = String(user ?? '').trim().slice(0, 80);

    const entry = this.store.chat(key);
    let target = '';
    if (newSession) {
      target = '';
    } else if (String(sessionId ?? '').trim() !== '') {
      target = String(sessionId).trim();
    } else if (follow && entry.mode === 'continue' && entry.current !== null) {
      target = entry.current;
    }

    return this.enqueue(key, async () => {
      const settings = this.settings.effective();
      const timeout = Number.isInteger(timeoutMs) && timeoutMs > 0
        ? Math.min(timeoutMs, 3_600_000)
        : settings.timeoutSeconds * 1000;

      const turnId = randomUUID();
      const agent = target === ''
        ? await this.createAgent()
        : await this.agentFor(target, { owned: entry.sessions[target] !== undefined });
      this.known.add(agent.id);
      this.foreign.delete(agent.id);
      this.log(`chat ${key}: ${target === '' ? 'new session' : `continue ${target.slice(0, 8)}`} -> ${agent.id.slice(0, 8)}`);

      const startedAt = Date.now();
      this.running.set(key, { sessionId: agent.id, startedAt, text: prompt, turnId });
      let result;
      try {
        result = await this.runTurn(agent, prompt, timeout);
      } finally {
        this.running.delete(key);
      }
      const durationMs = Date.now() - startedAt;

      const id = agent.id;
      const workspace = workspaceOf(agent) || entry.sessions[id]?.workspace || '';
      const previous = entry.sessions[id] ?? { createdAt: startedAt, turns: 0 };
      entry.sessions[id] = {
        title: previous.title || titleOf(prompt),
        user: who || previous.user || '',
        workspace,
        createdAt: previous.createdAt ?? startedAt,
        lastUsed: Date.now(),
        turns: (previous.turns ?? 0) + result.turns,
      };
      entry.current = id;
      // A plain "/dsh <text>" stays in new-session mode; only an explicit
      // switch makes the chat continue this conversation.
      if (newSession || target === '') entry.mode = 'new';
      this.store.prune(key, settings.sessionsPerPage * 20);
      await this.store.save().catch((error) => this.warn(`cannot persist chat index: ${error.message}`));

      await this.release(agent);

      const attachments = collectAttachments(result.reply);
      this.turns.set(turnId, {
        turnId,
        chatKey: key,
        sessionId: id,
        title: entry.sessions[id].title,
        workspace,
        text: result.reply,
        error: result.failure,
        attachments,
        user: entry.sessions[id].user,
        finishedAt: Date.now(),
        acked: false,
        notified: false,
      });
      this.pruneTurns();

      // A failed turn still answers 200: the bot renders `error` as
      // "会话中途报错，原因：…" instead of a transport failure.
      return {
        turnId,
        sessionId: id,
        text: result.reply,
        durationMs,
        turns: result.turns,
        steps: result.steps,
        interrupted: result.interrupted,
        timedOut: result.timedOut,
        title: entry.sessions[id].title,
        user: entry.sessions[id].user,
        workspace,
        error: result.failure,
        attachments,
      };
    });
  }

  /** Confirm the bot received a turn, so it is not re-sent as a notification. */
  ack({ chatKey, turnId }) {
    const key = String(chatKey ?? '').trim();
    const records = [...this.turns.values()].filter((record) => record.chatKey === key);
    let changed = 0;
    for (const record of records) {
      if (turnId === undefined || turnId === null || turnId === '' || record.turnId === turnId) {
        if (record.acked === false) changed += 1;
        record.acked = true;
      }
    }
    return { acked: changed };
  }

  /**
   * Turns that finished but were never acknowledged. At-least-once: a record
   * stays here until `ack()` confirms the bot actually delivered it, so a
   * skipped or failed push is retried on the next poll.
   */
  pending(chatKey) {
    const key = chatKey === undefined || chatKey === null ? '' : String(chatKey).trim();
    const now = Date.now();
    const out = [];
    for (const record of this.turns.values()) {
      if (key !== '' && record.chatKey !== key) continue;
      if (record.notified || record.acked) continue;
      if (now - record.finishedAt < DELIVERY_GRACE_MS) continue;
      if (this.foreign.has(record.sessionId)) {
        // Continued elsewhere: never deliver, and never look at it again.
        record.notified = true;
        continue;
      }
      out.push({
        kind: record.error === '' ? 'result' : 'error',
        turnId: record.turnId,
        chatKey: record.chatKey,
        sessionId: record.sessionId,
        title: record.title,
        user: record.user,
        workspace: record.workspace,
        text: record.text,
        error: record.error,
        attachments: record.attachments,
        finishedAt: record.finishedAt,
      });
    }
    this.pruneTurns();
    return out;
  }

  pruneTurns() {
    const oldest = Date.now() - TURN_RETENTION_MS;
    for (const [turnId, record] of this.turns) {
      if (record.acked) this.turns.delete(turnId);
      else if (record.finishedAt < oldest) this.turns.delete(turnId);
    }
  }

  /** Someone else drove this session; stop notifying about it. */
  markForeign(sessionId) {
    if (this.foreign.has(sessionId)) return;
    this.foreign.add(sessionId);
    this.log(`session ${sessionId.slice(0, 8)} was continued outside the bridge; notifications off`);
  }

  /** Point a chat at an existing session without running anything. */
  async use({ chatKey, sessionId, index }) {
    const key = String(chatKey ?? '').trim();
    if (key === '') throw new BridgeError('bad-request', 'chatKey is required');
    const entry = this.store.chat(key);
    let id = String(sessionId ?? '').trim();
    if (id === '' && Number.isInteger(index)) {
      // Resolve the same numbering /dshls printed, without shipping the corpus.
      const { sessions } = await this.collect(key, { localLimit: 1000 });
      const picked = index > 0 ? sessions[index - 1] : undefined;
      if (picked === undefined) {
        throw new BridgeError('session-not-found', `序号 ${index} 超出范围（共 ${sessions.length} 条）`);
      }
      id = picked.id;
    }
    if (id === '') throw new BridgeError('bad-request', 'sessionId or index is required');
    if (entry.sessions[id] === undefined) {
      const local = this.local === undefined ? null : await this.local.one(id);
      if (local === null) {
        throw new BridgeError('session-not-found', `session ${id} is not part of this chat`);
      }
      entry.sessions[id] = {
        title: local.title,
        user: '',
        workspace: local.workspace,
        createdAt: local.createdAt || Date.now(),
        lastUsed: Date.now(),
        turns: 0,
      };
    }
    entry.current = id;
    entry.mode = 'continue';
    this.known.add(id);
    this.foreign.delete(id);
    await this.store.save();
    const meta = entry.sessions[id] ?? {};
    return {
      sessionId: id,
      mode: entry.mode,
      title: meta.title ?? '',
      workspace: meta.workspace ?? '',
      origin: meta.origin ?? 'bridge',
    };
  }

  /**
   * One page of the chat's sessions, grouped by workspace.
   *
   * Numbering is global (page 2 continues at 16), so "/dsh <n>" can address a
   * session the user saw on any page.
   */
  /**
   * One page of sessions, grouped by workspace.
   *
   * Bridge sessions carry chat metadata (turns, requester); every other session
   * this desktop knows about is listed too, so a conversation started in the
   * desktop can be picked up with "/dsh <n>". Numbering is global across pages.
   */
  /** Every session this chat can address, newest first. */
  async collect(chatKey, { includeLocal = true, localLimit = 200 } = {}) {
    const key = String(chatKey ?? '').trim();
    const entry = this.store.chat(key);
    const sessions = Object.entries(entry.sessions).map(([id, meta]) => ({
      id,
      title: meta?.title ?? '',
      user: meta?.user ?? '',
      workspace: meta?.workspace ?? '',
      createdAt: meta?.createdAt ?? 0,
      lastUsed: meta?.lastUsed ?? 0,
      turns: meta?.turns ?? 0,
      current: entry.current === id,
      external: this.foreign.has(id),
      origin: 'bridge',
    }));

    if (includeLocal && this.local !== undefined) {
      const visible = this.settings.effective();
      const known = new Set(sessions.map((session) => session.id));
      const localList = (await this.local.list({
        limit: localLimit,
        workspacesOnly: visible.workspacesOnly !== false,
      })).filter((item) => !known.has(item.id));

      // Titles decide whether a session ever held a conversation, so they must
      // be folded before the untitled ones are dropped.
      let titles = new Map();
      if (localList.length > 0) {
        try {
          titles = await this.local.foldedTitles(localList.map((item) => item.id));
        } catch (error) {
          this.warn(`cannot resolve session titles: ${error?.message ?? error}`);
        }
      }

      for (const item of localList) {
        const title = titles.get(item.id) ?? item.title ?? '';
        if (visible.showUntitled !== true && title.trim() === '') continue;
        sessions.push({
          id: item.id,
          title,
          user: '',
          workspace: item.workspace,
          createdAt: item.createdAt,
          lastUsed: item.createdAt,
          turns: 0,
          current: entry.current === item.id,
          external: false,
          origin: 'desktop',
          live: item.live,
        });
      }
    }

    sessions.sort((left, right) => right.lastUsed - left.lastUsed);
    return { key, entry, sessions };
  }

  /**
   * One page of sessions, grouped by workspace.
   *
   * Bridge sessions carry chat metadata (turns, requester); every other session
   * this desktop knows about is listed too, so a conversation started in the
   * desktop can be picked up with "/dsh <n>". Numbering is global across pages.
   */
  async list(chatKey, { page = 1, perPage, includeLocal = true } = {}) {
    const size = Math.min(50, Math.max(1, Number(perPage) || this.settings.effective().sessionsPerPage || DEFAULT_PER_PAGE));
    const { key, entry, sessions } = await this.collect(chatKey, { includeLocal });
    const pages = Math.max(1, Math.ceil(sessions.length / size));
    const currentPage = Math.min(pages, Math.max(1, Number(page) || 1));
    const slice = sessions.slice((currentPage - 1) * size, currentPage * size);

    // Titles need the full log; only the visible page pays for it.
    if (this.local !== undefined) {
      const untitled = slice.filter((session) => session.title === '').map((session) => session.id);
      if (untitled.length > 0) {
        try {
          const titles = await this.local.foldedTitles(untitled);
          for (const session of slice) {
            if (session.title === '') session.title = titles.get(session.id) ?? '';
          }
        } catch (error) {
          this.warn(`cannot resolve session titles: ${error?.message ?? error}`);
        }
      }
    }

    const groups = [];
    const byPath = new Map();
    for (const session of slice) {
      const path = session.workspace ?? '';
      let group = byPath.get(path);
      if (group === undefined) {
        group = { path, label: path === '' ? '(DSH 默认工作区)' : (basename(path) || path), sessions: [] };
        byPath.set(path, group);
        groups.push(group);
      }
      group.sessions.push(session);
    }
    groups.sort((a, b) => Math.max(...b.sessions.map((s) => s.lastUsed)) - Math.max(...a.sessions.map((s) => s.lastUsed)));

    return {
      chatKey: key,
      mode: entry.mode,
      currentSession: entry.current,
      page: currentPage,
      perPage: size,
      pages,
      total: sessions.length,
      offset: (currentPage - 1) * size,
      workspaces: groups,
    };
  }

  /** Cancel the turn currently running for a chat, if any. */
  cancel(chatKey) {
    const key = String(chatKey ?? '').trim();
    const record = this.running.get(key);
    if (record === undefined) return { cancelled: false, sessionId: null };
    const agent = this.ctx.agents.get(record.sessionId);
    if (agent === undefined) return { cancelled: false, sessionId: record.sessionId };
    try {
      agent.cancel({ kind: 'user' });
      return { cancelled: true, sessionId: record.sessionId };
    } catch {
      return { cancelled: false, sessionId: record.sessionId };
    }
  }

  status() {
    return {
      running: [...this.running.entries()].map(([chatKey, record]) => ({
        chatKey,
        sessionId: record.sessionId,
        startedAt: record.startedAt,
      })),
      pendingNotifications: [...this.turns.values()].filter((record) => !record.acked && !record.notified).length,
      live: this.handles.size,
    };
  }
}

function textOfMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function workspaceOf(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === 'string' ? cwd : '';
}

function titleOf(text) {
  const first = String(text).split('\n').find((line) => line.trim() !== '') ?? '';
  const clean = first.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE - 1)}…` : clean;
}

/** Full, human-readable failure text — the bot forwards it verbatim. */
export function describeError(error) {
  if (error === undefined || error === null) return '';
  if (typeof error === 'string') return error;
  const parts = [];
  const name = typeof error.name === 'string' ? error.name : '';
  if (name !== '' && name !== 'Error') parts.push(name);
  const code = error.code ?? error.kind;
  if (typeof code === 'string' && code !== '') parts.push(code);
  const status = error.status ?? error.statusCode;
  if (Number.isFinite(status)) parts.push(`HTTP ${status}`);
  const message = typeof error.message === 'string' ? error.message : '';
  if (message !== '') parts.push(message);
  if (parts.length === 0) {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return parts.join(' · ');
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
