/**
 * Settings → AstrBot.
 *
 * Edits the four things a chat-driven session needs (workspace, permission,
 * provider, model), the relay tunnel the bot can reach through, and shows the
 * bridge's own status. Host routes under /__astrbot are behind the normal
 * desktop browser session.
 */

window.__ModuleLoader__.load({
  id: 'dsh-astrbot-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const CSS = `
.dsha-root{display:flex;flex-direction:column;gap:16px;width:100%;color:var(--dsw-alias-label-primary)}
.dsha-lead{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dsha-card{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);padding:16px 18px;display:flex;flex-direction:column;gap:12px}
.dsha-head{display:flex;align-items:center;gap:8px;min-height:28px}
.dsha-title{font-size:14px;font-weight:600;line-height:20px}
.dsha-head .dsha-btn{margin-left:auto}
.dsha-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.dsha-dot[data-on="true"]{background:var(--dsw-alias-state-success-primary)}
.dsha-dot[data-warn="true"]{background:var(--dsw-alias-state-warn-primary)}
.dsha-grid{display:grid;grid-template-columns:96px minmax(0,1fr);gap:10px 14px;align-items:center}
.dsha-label{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsha-value{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;font-size:13px;line-height:20px}
.dsha-input,.dsha-select{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 10px;font-size:13px;line-height:18px;outline:none}
.dsha-input:focus,.dsha-select:focus{border-color:var(--dsw-alias-button-info-fill)}
.dsha-input[disabled]{opacity:.55;cursor:not-allowed}
.dsha-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:18px;overflow-wrap:anywhere;min-width:0}
.dsha-token{flex:1 1 220px;padding:4px 8px;border-radius:6px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1)}
.dsha-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsha-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:12.5px;line-height:18px;cursor:pointer;white-space:nowrap}
.dsha-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsha-btn[data-kind="primary"]{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#0f1115));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:600}
.dsha-btn:disabled{opacity:.5;cursor:default}
.dsha-switch{display:inline-flex;align-items:center;gap:7px;margin-left:auto;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
.dsha-switch input{accent-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#0f1115));width:15px;height:15px;margin:0;cursor:pointer}
.dsha-check{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer;user-select:none}
.dsha-check input{accent-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#0f1115));width:15px;height:15px;margin:0;cursor:pointer}
.dsha-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:0}
.dsha-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.dsha-ok{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}
.dsha-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsha-row > .dsha-input{flex:1 1 200px;width:auto}
@media (max-width:560px){.dsha-grid{grid-template-columns:88px minmax(0,1fr)}}
`;

    const TEXT = {
      zh: {
        lead: 'AstrBot 通过 /dsh 指令调用这台电脑上的 DSH。这里设置新建会话使用的工作区、对话权限、渠道（provider）和默认模型；「跟随 DSH 默认」表示由 DSH 的全局设置决定。',
        bridge: '桥接状态',
        http: 'HTTP 接口',
        relay: '中转隧道',
        on: '运行中',
        off: '未启用',
        connected: '已连接',
        connecting: '未连接',
        token: '桥接令牌',
        tokenHint: '把令牌填进 AstrBot 插件配置的 token；它等同于这台电脑的执行权限，不要外传。',
        copy: '复制',
        copied: '已复制',
        refresh: '刷新',
        defaults: '新会话默认值',
        workspace: '工作区',
        workspaceHint: '会话的工作目录；留空则沿用 DSH 的默认工作区。',
        permission: '对话权限',
        followDefault: '跟随 DSH 默认',
        provider: '渠道',
        model: '模型',
        modelHint: '留空则跟随桌面默认',
        timeout: '超时（秒）',
        perPage: '列表每页',
        relayTitle: '中转隧道',
        relayEnable: '启用中转',
        relayLead: '两台机器都没有公网端口时用这个通路：在双方都能连到的机器上运行 relay-server.mjs，DSH 主动连出去，AstrBot 端 transport 选 relay 并填同样的三个值。',
        relayUrl: '中转地址',
        relayRoom: '房间 ID',
        relayKey: '房间密钥',
        relayHint: '房间 ID 是 16–64 位十六进制，密钥是 base64url 编码的 16 字节；密钥等同于钥匙，不要外传。',
        generate: '生成一对',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        loadFailed: '读取设置失败',
        listTitle: '对话列表',
        showUntitled: '显示未命名会话（没有标题的空白会话）',
        workspacesOnly: '只显示桌面工作区里的会话',
        listHint: '关闭「未命名」可以把桌面上没聊过就关掉的空会话挡掉；「只显示桌面工作区」按 DSH 注册的工作区过滤，方向和桌面端一致。',
        tip: '工作区与权限从下一轮对话起生效；渠道和模型只影响新建的会话；中转修改保存后立即重连。',
      },
      en: {
        lead: 'AstrBot drives this desktop through /dsh. Choose the workspace, permission preset, provider and default model new sessions use; "DSH default" leaves the choice to the desktop.',
        bridge: 'Bridge status',
        http: 'HTTP API',
        relay: 'Relay tunnel',
        on: 'listening',
        off: 'disabled',
        connected: 'connected',
        connecting: 'offline',
        token: 'Bridge token',
        tokenHint: 'Paste this into the AstrBot plugin token setting. It grants execution on this machine — keep it private.',
        copy: 'Copy',
        copied: 'Copied',
        refresh: 'Refresh',
        defaults: 'New session defaults',
        workspace: 'Workspace',
        workspaceHint: 'Working directory for new sessions; empty keeps the DSH default.',
        permission: 'Permission',
        followDefault: 'DSH default',
        provider: 'Provider',
        model: 'Model',
        modelHint: 'empty = desktop default',
        timeout: 'Timeout (s)',
        perPage: 'Per page',
        relayTitle: 'Relay tunnel',
        relayEnable: 'Enable relay',
        relayLead: 'Use this when neither machine can accept inbound connections: run relay-server.mjs somewhere both can reach, the desktop dials out, and the bot uses transport=relay with the same three values.',
        relayUrl: 'Relay address',
        relayRoom: 'Room id',
        relayKey: 'Room key',
        relayHint: 'Room id is 16–64 hex chars; the key is 16 bytes in base64url. The key is the key to this machine — keep it private.',
        generate: 'Generate',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        loadFailed: 'Cannot load settings',
        listTitle: 'Conversation list',
        showUntitled: 'Show untitled sessions (blank conversations)',
        workspacesOnly: 'Only sessions inside workspace folders',
        listHint: 'Hiding untitled sessions drops blank ones that were opened and closed; the workspace filter mirrors what the desktop shows.',
        tip: 'Workspace and permission apply from the next turn; provider and model only affect new sessions; relay changes reconnect immediately after saving.',
      },
    };

    function languageOf(ctx) {
      try {
        return ctx.locale?.getSnapshot?.().active === 'zh' ? 'zh' : 'en';
      } catch {
        return 'zh';
      }
    }

    function useLanguage(ctx) {
      const [lang, setLang] = React.useState(() => languageOf(ctx));
      React.useEffect(() => {
        const off = ctx.locale?.subscribe?.(() => setLang(languageOf(ctx)));
        return () => off?.();
      }, []);
      return lang;
    }

    async function call(path, options) {
      const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...options });
      const text = await response.text();
      let value = null;
      try {
        value = text === '' ? null : JSON.parse(text);
      } catch {
        value = null;
      }
      if (!response.ok) throw new Error(value?.detail || value?.error || `HTTP ${response.status}`);
      return value;
    }

    function toBase64Url(bytes) {
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function randomRoom() {
      return [...crypto.getRandomValues(new Uint8Array(16))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    }

    function randomKey() {
      return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    }

    function createSection(ctx) {
      return function AstrBotSection() {
        const lang = useLanguage(ctx);
        const t = TEXT[lang];
        const [state, setState] = React.useState(null);
        const [draft, setDraft] = React.useState(null);
        const [error, setError] = React.useState('');
        const [notice, setNotice] = React.useState('');
        const [busy, setBusy] = React.useState(false);
        const [copied, setCopied] = React.useState(false);

        const apply = React.useCallback((value) => {
          const settings = value?.settings ?? {};
          const relay = settings.relay ?? {};
          setState(value);
          setDraft({
            workspace: settings.workspace ?? '',
            permission: settings.permission ?? '',
            provider: settings.provider ?? '',
            model: settings.model ?? '',
            timeoutSeconds: settings.timeoutSeconds ?? 900,
            sessionsPerPage: settings.sessionsPerPage ?? 15,
            showUntitled: settings.showUntitled === true,
            workspacesOnly: settings.workspacesOnly !== false,
            relayEnabled: relay.enabled === true,
            relayUrl: relay.url ?? '',
            relayRoom: relay.room ?? '',
            relayKey: relay.key ?? '',
          });
        }, []);

        const load = React.useCallback(() => {
          call('/__astrbot/settings')
            .then(apply)
            .catch((reason) => setError(`${t.loadFailed}: ${reason.message ?? reason}`));
        }, [t]);

        React.useEffect(() => {
          load();
          const timer = setInterval(() => {
            call('/__astrbot/settings')
              .then((value) => setState(value))
              .catch(() => {});
          }, 15000);
          return () => clearInterval(timer);
        }, [load]);

        const update = (key) => (event) => {
          const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
          setDraft((current) => ({ ...current, [key]: value }));
          setNotice('');
        };

        const save = () => {
          if (draft === null) return;
          setBusy(true);
          setError('');
          setNotice('');
          const payload = {
            workspace: draft.workspace,
            permission: draft.permission,
            provider: draft.provider,
            model: draft.model,
            timeoutSeconds: draft.timeoutSeconds,
            sessionsPerPage: draft.sessionsPerPage,
            showUntitled: draft.showUntitled === true,
            workspacesOnly: draft.workspacesOnly !== false,
            relay: {
              enabled: draft.relayEnabled === true,
              url: draft.relayUrl,
              room: draft.relayRoom,
              key: draft.relayKey,
            },
          };
          call('/__astrbot/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ settings: payload }),
          })
            .then((value) => {
              apply(value);
              setNotice(t.saved);
            })
            .catch((reason) => setError(String(reason.message ?? reason)))
            .finally(() => setBusy(false));
        };

        const copyToken = () => {
          const token = state?.state?.token ?? '';
          if (token === '') return;
          navigator.clipboard?.writeText(token).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }).catch(() => {});
        };

        const generate = () => {
          setDraft((current) => ({ ...current, relayRoom: randomRoom(), relayKey: randomKey() }));
          setNotice('');
        };

        if (state === null || draft === null) {
          return h('div', { className: 'dsha-root' },
            h('p', { className: 'dsha-lead' }, t.lead),
            h('div', { className: 'dsha-card' },
              h('p', { className: 'dsha-note' }, busy ? t.saving : '…'),
              error !== '' ? h('p', { className: 'dsha-error' }, error) : null));
        }

        const bridge = state.state?.bridge ?? {};
        const relayStatus = state.state?.relay ?? {};
        const presets = state.presets?.names ?? [];
        const providers = state.providers ?? [];
        const selected = providers.find((entry) => entry.id === draft.provider);
        const models = selected?.models ?? [];
        const workspaceOptions = state.workspaces ?? [];
        const defaultSelection = state.defaultSelection ?? null;
        const relayState = relayStatus.enabled !== true
          ? t.off
          : (relayStatus.connected === true ? t.connected : t.connecting);

        return h('div', { className: 'dsha-root' },
          h('p', { className: 'dsha-lead' }, t.lead),

          h('div', { className: 'dsha-card' },
            h('div', { className: 'dsha-head' },
              h('span', { className: 'dsha-title' }, t.bridge),
              h('button', { className: 'dsha-btn', onClick: load }, t.refresh)),
            h('div', { className: 'dsha-grid' },
              h('span', { className: 'dsha-label' }, t.http),
              h('div', { className: 'dsha-value' },
                h('span', { className: 'dsha-dot', 'data-on': bridge.listening === true ? 'true' : 'false' }),
                h('span', { className: 'dsha-mono' }, bridge.address ?? t.off)),
              h('span', { className: 'dsha-label' }, t.relay),
              h('div', { className: 'dsha-value' },
                h('span', {
                  className: 'dsha-dot',
                  'data-on': relayStatus.connected === true ? 'true' : 'false',
                  'data-warn': relayStatus.enabled === true && relayStatus.connected !== true ? 'true' : 'false',
                }),
                h('span', null, relayState),
                relayStatus.url ? h('span', { className: 'dsha-mono' }, relayStatus.url) : null),
              h('span', { className: 'dsha-label' }, t.token),
              h('div', { className: 'dsha-value' },
                h('span', { className: 'dsha-mono dsha-token' }, state.state?.token ?? ''),
                h('button', { className: 'dsha-btn', onClick: copyToken }, copied ? t.copied : t.copy))),
            h('p', { className: 'dsha-note' }, t.tokenHint)),

          h('div', { className: 'dsha-card' },
            h('div', { className: 'dsha-head' },
              h('span', { className: 'dsha-title' }, t.relayTitle),
              h('label', { className: 'dsha-switch' },
                h('input', {
                  type: 'checkbox',
                  checked: draft.relayEnabled === true,
                  onChange: update('relayEnabled'),
                }),
                t.relayEnable)),
            h('p', { className: 'dsha-note' }, t.relayLead),
            h('div', { className: 'dsha-grid' },
              h('span', { className: 'dsha-label' }, t.relayUrl),
              h('input', {
                className: 'dsha-input',
                spellCheck: false,
                placeholder: 'relay.example.com:9443',
                value: draft.relayUrl,
                onChange: update('relayUrl'),
              }),
              h('span', { className: 'dsha-label' }, t.relayRoom),
              h('div', { className: 'dsha-row' },
                h('input', {
                  className: 'dsha-input dsha-mono',
                  spellCheck: false,
                  placeholder: '32 位十六进制',
                  value: draft.relayRoom,
                  onChange: update('relayRoom'),
                }),
                h('button', { className: 'dsha-btn', onClick: generate }, t.generate)),
              h('span', { className: 'dsha-label' }, t.relayKey),
              h('input', {
                className: 'dsha-input dsha-mono',
                spellCheck: false,
                placeholder: 'base64url',
                value: draft.relayKey,
                onChange: update('relayKey'),
              })),
            h('p', { className: 'dsha-note' }, t.relayHint)),

          h('div', { className: 'dsha-card' },
            h('div', { className: 'dsha-head' }, h('span', { className: 'dsha-title' }, t.defaults)),
            h('div', { className: 'dsha-grid' },
              h('span', { className: 'dsha-label' }, t.workspace),
              h('div', null,
                h('input', {
                  className: 'dsha-input',
                  list: 'dsha-workspaces',
                  spellCheck: false,
                  placeholder: workspaceOptions[0]?.path ?? '',
                  value: draft.workspace,
                  onChange: update('workspace'),
                }),
                h('datalist', { id: 'dsha-workspaces' },
                  workspaceOptions.map((entry) => h('option', { key: entry.id, value: entry.path }, entry.title))),
                h('p', { className: 'dsha-note' }, t.workspaceHint)),

              h('span', { className: 'dsha-label' }, t.permission),
              h('select', { className: 'dsha-select', value: draft.permission, onChange: update('permission') },
                h('option', { value: '' }, t.followDefault),
                presets.map((name) => h('option', { key: name, value: name }, name))),

              h('span', { className: 'dsha-label' }, t.provider),
              h('select', { className: 'dsha-select', value: draft.provider, onChange: update('provider') },
                h('option', { value: '' }, `${t.followDefault}${defaultSelection?.provider ? ` · ${defaultSelection.provider}` : ''}`),
                providers.map((entry) => h('option', { key: entry.id, value: entry.id }, `${entry.name} (${entry.id})`))),

              h('span', { className: 'dsha-label' }, t.model),
              h('div', null,
                h('input', {
                  className: 'dsha-input',
                  list: 'dsha-models',
                  spellCheck: false,
                  placeholder: defaultSelection?.model ?? '',
                  value: draft.model,
                  onChange: update('model'),
                }),
                h('datalist', { id: 'dsha-models' },
                  models.map((id) => h('option', { key: id, value: id }))),
                h('p', { className: 'dsha-note' }, t.modelHint)),

              h('span', { className: 'dsha-label' }, t.timeout),
              h('input', {
                className: 'dsha-input',
                type: 'number',
                min: 30,
                max: 3600,
                value: draft.timeoutSeconds,
                onChange: update('timeoutSeconds'),
              }),

              h('span', { className: 'dsha-label' }, t.perPage),
              h('input', {
                className: 'dsha-input',
                type: 'number',
                min: 1,
                max: 50,
                value: draft.sessionsPerPage,
                onChange: update('sessionsPerPage'),
              })),

            h('div', { className: 'dsha-actions' },
              h('button', {
                className: 'dsha-btn',
                'data-kind': 'primary',
                disabled: busy,
                onClick: save,
              }, busy ? t.saving : t.save),
              notice !== '' ? h('span', { className: 'dsha-ok' }, notice) : null,
              error !== '' ? h('span', { className: 'dsha-error' }, error) : null),

            h('p', { className: 'dsha-note' }, t.tip)),

          h('div', { className: 'dsha-card' },
            h('div', { className: 'dsha-head' }, h('span', { className: 'dsha-title' }, t.listTitle)),
            h('label', { className: 'dsha-check' },
              h('input', {
                type: 'checkbox',
                checked: draft.showUntitled === true,
                onChange: update('showUntitled'),
              }),
              h('span', null, t.showUntitled)),
            h('label', { className: 'dsha-check' },
              h('input', {
                type: 'checkbox',
                checked: draft.workspacesOnly !== false,
                onChange: update('workspacesOnly'),
              }),
              h('span', null, t.workspacesOnly)),
            h('p', { className: 'dsha-note' }, t.listHint)));
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const tag = document.createElement('style');
          tag.dataset.plugin = 'dsh-astrbot-bridge';
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => tag.remove();
        });

        const Section = createSection(ctx);
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'astrbot',
          order: 19,
          label: () => (languageOf(ctx) === 'zh' ? 'AstrBot 桥接' : 'AstrBot bridge'),
        }, Section));
      },
    };
  },
});
