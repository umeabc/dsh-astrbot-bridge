/**
 * Effective bridge settings.
 *
 * Precedence: what the settings page saved > what `cordis.patch.yml` declared >
 * whatever DSH itself would use. Only new sessions pick up a model/provider
 * change; workspace and permission are re-applied to every turn.
 */

import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parseRelayAddress, parseRoom, parseRoomKey } from './relay.js';

export const DEFAULT_SETTINGS = {
  workspace: '',
  permission: '',
  provider: '',
  model: '',
  timeoutSeconds: 900,
  sessionsPerPage: 15,
  relay: { enabled: false, url: '', room: '', key: '' },
};

const LIMITS = { timeoutSeconds: [30, 3600], sessionsPerPage: [1, 50] };

export class SettingsService {
  constructor({ store, config, ctx, warn }) {
    this.store = store;
    this.config = config;
    this.ctx = ctx;
    this.warn = warn ?? (() => {});
  }

  /** Raw values saved from the settings page. */
  get saved() {
    const value = this.store.data.settings;
    return value !== null && typeof value === 'object' ? value : {};
  }

  /** Composition-time defaults from the plugin config. */
  get configured() {
    const agent = this.config.agent ?? {};
    return {
      workspace: String(agent.workspace ?? '').trim(),
      permission: String(agent.permission ?? '').trim(),
      provider: String(agent.provider ?? '').trim(),
      model: String(agent.model ?? '').trim(),
      timeoutSeconds: Number(agent.timeoutSeconds ?? DEFAULT_SETTINGS.timeoutSeconds),
      sessionsPerPage: Number(agent.sessionsPerPage ?? DEFAULT_SETTINGS.sessionsPerPage),
      relay: {
        enabled: (this.config.relay ?? {}).enabled === true,
        url: String((this.config.relay ?? {}).url ?? '').trim(),
        room: String((this.config.relay ?? {}).room ?? '').trim().toLowerCase(),
        key: String((this.config.relay ?? {}).key ?? '').trim(),
      },
    };
  }

  effective() {
    const configured = this.configured;
    const saved = this.saved;
    const pick = (key) => {
      const value = saved[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
      return configured[key];
    };
    const numeric = (key) => {
      const raw = Number(saved[key]);
      if (Number.isFinite(raw) && raw > 0) return clamp(key, raw);
      return clamp(key, configured[key]);
    };
    const relaySaved = saved.relay !== null && typeof saved.relay === 'object' ? saved.relay : {};
    const relayConfigured = configured.relay;
    const relayText = (key) => {
      const value = relaySaved[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
      return relayConfigured[key];
    };
    return {
      workspace: pick('workspace'),
      permission: pick('permission'),
      provider: pick('provider'),
      model: pick('model'),
      timeoutSeconds: numeric('timeoutSeconds'),
      sessionsPerPage: numeric('sessionsPerPage'),
      relay: {
        enabled: typeof relaySaved.enabled === 'boolean' ? relaySaved.enabled : relayConfigured.enabled === true,
        url: relayText('url'),
        room: relayText('room'),
        key: relayText('key'),
      },
    };
  }

  /** The workspace directory a new session should run in, validated. */
  async resolveWorkspace() {
    const configured = this.effective().workspace;
    if (configured === '') return '';
    const absolute = isAbsolute(configured) ? configured : resolve(configured);
    const info = await stat(absolute).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new Error(`workspace is not a directory: ${absolute}`);
    }
    return absolute;
  }

  async presets() {
    const service = this.ctx.get('permissionPresets');
    if (service === undefined) return { names: [], current: '' };
    try {
      return { names: [...(service.names ?? [])], current: service.defaultPreset ?? '' };
    } catch {
      return { names: [], current: '' };
    }
  }

  async providers() {
    const llm = this.ctx.get('llm');
    if (llm === undefined || typeof llm.listProviders !== 'function') return [];
    try {
      const list = llm.listProviders().map((entry) => ({
        id: String(entry.id ?? ''),
        name: String(entry.name ?? entry.id ?? ''),
        models: [],
      }));
      await Promise.all(list.map(async (entry) => {
        if (entry.id === '' || typeof llm.listModels !== 'function') return;
        try {
          const models = await llm.listModels(entry.id);
          entry.models = (models ?? []).map((model) => String(model.id ?? model.name ?? '')).filter((id) => id !== '');
        } catch {
          entry.models = [];
        }
      }));
      return list;
    } catch (error) {
      this.warn(`cannot list providers: ${error?.message ?? error}`);
      return [];
    }
  }

  defaultSelection() {
    const service = this.ctx.get('agentDefaultModel');
    if (service === undefined || typeof service.currentSelection !== 'function') return null;
    try {
      const selection = service.currentSelection();
      return { provider: selection?.provider ?? '', model: selection?.model ?? '' };
    } catch {
      return null;
    }
  }

  async snapshot() {
    const [presets, providers] = await Promise.all([this.presets(), this.providers()]);
    return {
      settings: this.effective(),
      saved: this.saved,
      configured: this.configured,
      defaults: DEFAULT_SETTINGS,
      presets,
      providers,
      defaultSelection: this.defaultSelection(),
    };
  }

  /** Validate one settings patch from the settings page and persist it. */
  async save(patch) {
    const next = { ...this.saved };
    const raw = patch ?? {};
    if ('workspace' in raw) {
      const value = String(raw.workspace ?? '').trim();
      if (value !== '') {
        const absolute = isAbsolute(value) ? value : resolve(value);
        const info = await stat(absolute).catch(() => null);
        if (info === null || !info.isDirectory()) throw new Error(`workspace is not a directory: ${value}`);
        next.workspace = absolute;
      } else {
        next.workspace = '';
      }
    }
    if ('permission' in raw) {
      const value = String(raw.permission ?? '').trim();
      const { names } = await this.presets();
      if (value !== '' && names.length > 0 && !names.includes(value)) {
        throw new Error(`unknown permission preset: ${value}`);
      }
      next.permission = value;
    }
    if ('provider' in raw) {
      const value = String(raw.provider ?? '').trim();
      const providers = await this.providers();
      if (value !== '' && providers.length > 0 && !providers.some((entry) => entry.id === value)) {
        throw new Error(`unknown provider: ${value}`);
      }
      next.provider = value;
    }
    if ('model' in raw) next.model = String(raw.model ?? '').trim();
    if ('relay' in raw && raw.relay !== null && typeof raw.relay === 'object') {
      const relay = raw.relay;
      const nextRelay = { ...(this.saved.relay ?? {}) };
      if ('enabled' in relay) nextRelay.enabled = relay.enabled === true;
      if ('url' in relay) {
        const value = String(relay.url ?? '').trim();
        if (value !== '' && parseRelayAddress(value) === null) {
          throw new Error('中转地址应形如 host:port，例如 relay.example.com:9443');
        }
        nextRelay.url = value;
      }
      if ('room' in relay) {
        const value = String(relay.room ?? '').trim().toLowerCase();
        if (value !== '' && parseRoom(value) === null) {
          throw new Error('房间 ID 应是 16-64 位十六进制');
        }
        nextRelay.room = value;
      }
      if ('key' in relay) {
        const value = String(relay.key ?? '').trim();
        if (value !== '' && parseRoomKey(value) === null) {
          throw new Error('房间密钥应是 base64url 编码的 16 字节');
        }
        nextRelay.key = value;
      }
      if (nextRelay.enabled === true) {
        const missing = ['url', 'room', 'key'].filter((key) => !nextRelay[key]);
        if (missing.length > 0) {
          throw new Error(`启用中转需要填好 ${missing.join(' / ')}`);
        }
      }
      next.relay = nextRelay;
    }
    for (const key of ['timeoutSeconds', 'sessionsPerPage']) {
      if (!(key in raw)) continue;
      const value = Number(raw[key]);
      if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
      next[key] = clamp(key, value);
    }
    this.store.data.settings = next;
    await this.store.save();
    return this.effective();
  }
}

function clamp(key, value) {
  const [min, max] = LIMITS[key] ?? [0, Number.MAX_SAFE_INTEGER];
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_SETTINGS[key];
  return Math.min(max, Math.max(min, Math.round(number)));
}
