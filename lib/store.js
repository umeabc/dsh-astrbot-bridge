/**
 * Durable chat → DSH session bookkeeping.
 *
 * Everything here is small metadata the bot needs to answer "/dsh list" and
 * "which session am I continuing": the conversation itself lives in DSH's own
 * session store, never in this file.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function dshHome() {
  const fromEnv = String(process.env.DSH_HOME ?? '').trim();
  return fromEnv === '' ? join(homedir(), '.dsh') : fromEnv;
}

const EMPTY_CHAT = () => ({ mode: 'new', current: null, sessions: {} });

export class BridgeStore {
  constructor(path) {
    this.path = path;
    this.data = { version: 1, token: '', settings: {}, chats: {} };
    this.saving = null;
    this.dirty = false;
  }

  static defaultPath() {
    return join(dshHome(), 'astrbot-bridge.json');
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') {
        this.data = {
          version: 1,
          token: typeof parsed.token === 'string' ? parsed.token : '',
          settings: parsed.settings !== null && typeof parsed.settings === 'object' ? parsed.settings : {},
          chats: parsed.chats !== null && typeof parsed.chats === 'object' ? parsed.chats : {},
        };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return this;
  }

  chat(key) {
    const existing = this.data.chats[key];
    if (existing === undefined || existing === null || typeof existing !== 'object') {
      const created = EMPTY_CHAT();
      this.data.chats[key] = created;
      return created;
    }
    if (existing.mode !== 'continue') existing.mode = 'new';
    if (existing.current === undefined) existing.current = null;
    if (existing.sessions === null || typeof existing.sessions !== 'object') existing.sessions = {};
    return existing;
  }

  /** Keep the per-chat index bounded: drop the least recently used entries. */
  prune(key, maxSessions) {
    const chat = this.chat(key);
    const limit = Number(maxSessions);
    if (!Number.isInteger(limit) || limit <= 0) return;
    const ids = Object.keys(chat.sessions);
    if (ids.length <= limit) return;
    ids.sort((a, b) => (chat.sessions[a]?.lastUsed ?? 0) - (chat.sessions[b]?.lastUsed ?? 0));
    for (const id of ids.slice(0, ids.length - limit)) {
      delete chat.sessions[id];
      if (chat.current === id) {
        chat.current = null;
        chat.mode = 'new';
      }
    }
  }

  /** Coalesce concurrent mutations onto one atomic write. */
  save() {
    this.dirty = true;
    if (this.saving !== null) return this.saving;
    this.saving = (async () => {
      while (this.dirty) {
        this.dirty = false;
        const body = JSON.stringify(this.data, null, 2);
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${process.pid}.tmp`;
        await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, this.path);
      }
      this.saving = null;
    })();
    return this.saving;
  }
}
