/**
 * Read the sessions that already exist on this desktop.
 *
 * The bridge keeps its own chat → session index, but the desktop (and the phone
 * bridge) create sessions too. This adapter reads DSH's own corpus so /dshls can
 * show everything, and so /dsh <n> can attach a chat to a session it did not
 * create. Titles are folded lazily, per visible page, with a short cache.
 */

const LIST_CACHE_MS = 10_000;
const TITLE_CACHE_MS = 60_000;

export class LocalSessions {
  constructor({ ctx, warn }) {
    this.ctx = ctx;
    this.warn = warn ?? (() => {});
    this.listCache = null;
    this.listAt = 0;
    this.titles = new Map();
  }

  get query() {
    return typeof this.ctx.get === 'function' ? this.ctx.get('sessionQuery') : undefined;
  }

  get persistence() {
    return typeof this.ctx.get === 'function' ? this.ctx.get('sessionPersistence') : undefined;
  }

  /** Canonical paths of the workspaces the desktop actually shows. */
  registeredWorkspaces() {
    const registry = typeof this.ctx.get === 'function' ? this.ctx.get('workspaceRegistry') : undefined;
    if (registry === undefined || typeof registry.list !== 'function') return [];
    try {
      return (registry.list() ?? [])
        .map((entry) => normalizePath(entry?.path))
        .filter((path) => path !== '');
    } catch {
      return [];
    }
  }

  /**
   * Every top-level session known to this desktop, newest first.
   *
   * @returns {Promise<Array<{id: string, workspace: string, createdAt: number, live: boolean, persisted: boolean, title: string}>>}
   */
  async list({ limit = 200, workspacesOnly = true } = {}) {
    const now = Date.now();
    if (this.listCache !== null && now - this.listAt < LIST_CACHE_MS) {
      return limit > 0 ? this.listCache.slice(0, limit) : this.listCache;
    }

    let records = [];
    try {
      if (this.query !== undefined && typeof this.query.listSessions === 'function') {
        records = await this.query.listSessions();
      } else if (this.persistence !== undefined && typeof this.persistence.list === 'function') {
        records = (await this.persistence.list()).map((header) => ({ header, live: false, persisted: true }));
      }
    } catch (error) {
      this.warn(`cannot list local sessions: ${error?.message ?? error}`);
      records = [];
    }

    const sessions = records
      .map((record) => {
        const header = record?.header ?? record;
        return {
          id: typeof header?.id === 'string' ? header.id : '',
          workspace: typeof header?.cwd === 'string' ? header.cwd : '',
          createdAt: Number.isFinite(header?.createdAt) ? header.createdAt : 0,
          live: record?.live === true,
          persisted: record?.persisted === true,
          origin: header?.origin === 'subagent' ? 'subagent' : 'desktop',
          title: '',
        };
      })
      // Subagent children are implementation detail, not conversations.
      .filter((entry) => entry.id !== '' && entry.origin !== 'subagent');

    sessions.sort((left, right) => right.createdAt - left.createdAt);
    this.listCache = sessions;
    this.listAt = now;

    const workspaces = workspacesOnly ? this.registeredWorkspaces() : [];
    const visible = workspaces.length === 0
      ? sessions
      : sessions.filter((session) => inWorkspace(session.workspace, workspaces));
    return limit > 0 ? visible.slice(0, limit) : visible;
  }

  /** Title text for the given ids (missing ones resolve to an empty string). */
  async foldedTitles(ids) {
    const wanted = [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))];
    const out = new Map();
    if (wanted.length === 0) return out;

    const now = Date.now();
    const stale = wanted.filter((id) => {
      const hit = this.titles.get(id);
      return hit === undefined || now - hit.at > TITLE_CACHE_MS;
    });

    if (stale.length > 0 && this.query !== undefined && typeof this.query.readTitleSnapshots === 'function') {
      try {
        const results = await this.query.readTitleSnapshots(stale);
        for (const result of results ?? []) {
          const id = result?.sessionId;
          if (typeof id !== 'string') continue;
          const title = result?.status === 'fulfilled' ? (result.value?.title?.title ?? '') : '';
          this.titles.set(id, { title, at: now });
        }
      } catch (error) {
        this.warn(`cannot fold session titles: ${error?.message ?? error}`);
      }
    }

    for (const id of wanted) out.set(id, this.titles.get(id)?.title ?? '');
    return out;
  }

  /** One known session by id, or null when this desktop does not have it. */
  async one(id) {
    const sessions = await this.list();
    const found = sessions.find((entry) => entry.id === id);
    if (found !== undefined) return found;
    return null;
  }

  /** Whether the id exists here (live or persisted). */
  async has(id) {
    if (typeof this.ctx.get === 'function') {
      const agent = this.ctx.agents?.get?.(id);
      if (agent !== undefined) return true;
    }
    return (await this.one(id)) !== null;
  }
}

function normalizePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  const slashed = value.split('\\').join('/');
  return slashed.replace(/\/+$/, '').toLowerCase();
}

/** A session belongs to a workspace when it sits in that directory tree. */
function inWorkspace(cwd, workspaces) {
  const path = normalizePath(cwd);
  if (path === '') return false;
  return workspaces.some((root) => path === root || path.startsWith(`${root}/`));
}
