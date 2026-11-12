# dsh-astrbot-bridge

让 AstrBot（QQ / 微信 / Telegram 等任意平台）能调用**这台电脑上的 DeepSeek Harness**：
聊天里发 `/dsh 帮我把 D 盘的表格合并一下`，DSH 用真实工具执行，结果回到聊天窗口。

```
AstrBot ──HTTP(+Bearer token)──▶ dsh-astrbot-bridge:8399 ──ctx.agents──▶ DSH 会话
        └─或─ AES-128-GCM 隧道 ─▶ relay-server ─▶ 同上
```

桥接端负责三件事：

- 一个 **token 保护的本地 HTTP API**（`/v1/chat`、`/v1/sessions`…）；
- **聊天 → 会话** 的索引（`~/.dsh/astrbot-bridge.json`），支持列会话、切会话、按工作区分组；
- 可选的**出站 relay 隧道**，两台机器都没有公网端口时也能互通。

会话本身仍然存在 DSH 自己的会话库里，桌面上能直接看到、能接着聊。

## 相关项目

| 项目 | 作用 | 必需 |
|---|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH 桌面端 0.2.x） | 真正执行任务的宿主；本插件跑在它里面 | ✅ |
| [`astrbot-plugin-dsh`](https://github.com/umeabc/astrbot-plugin-dsh) | 聊天侧插件（`/dsh`、`/dshls`…），通过本仓库的 HTTP/relay 接口调用 | ✅ |
| [AstrBot](https://github.com/AstrBotDevs/AstrBot) | 机器人框架，`/dsh` 指令在这里被接住 | ✅ |
| [`relay-server.mjs`](relay-server.mjs)（本仓库自带） | 会合服务器：两边都没有公网端口时让 AstrBot 连到本机 | 跨网时 ✅ |
| [dsh-mobile-relay](https://github.com/umeabc/dsh-mobile-relay) | 同协议的中转服务器，**可直接替代**自带的 `relay-server.mjs`（帧格式、握手、密钥派生完全一致） | 可选 |
| [dsh-remote-plugin](https://github.com/umeabc/dsh-remote-plugin) | 手机/远程访问插件，本项目的协议与连接方式参考它；两者可以同时启用（各用各的房间） | 可选 |

跨网通路只需要「双方都能连到的一台机器」跑一个 relay；它读不到明文，也拿不到房间密钥。
本仓库的 `relay-server.mjs` 与 `dsh-mobile-relay/relay.js` 是同一个线上协议，任选其一即可。

---

## 1. 安装

插件是 `link:` 依赖，改代码后重启 DSH 生效：

```bash
git clone https://github.com/umeabc/dsh-astrbot-bridge
dsh plugin --profile desktop add link:<克隆下来的路径>/dsh-astrbot-bridge
```

再把包名加进 profile 的 `dsh.profile.bundles`（否则 `cordis.patch.yml` 里的
`astrbot-bridge` 行不会被应用）。编辑 `~/.dsh/profiles/desktop/package.json`：

```json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "dsh-astrbot-bridge"
    ]
  }
}
```

然后**完全退出并重启 DSH**（服务端插件不支持热重载；`client.js` 也只有重启后才会注册设置页）。

重启后：

- 日志里出现 `[astrbot-bridge] ready …`；
- **设置 → AstrBot 桥接** 多出一页；
- 令牌写入 `~/.dsh/astrbot-bridge.token`。

> 回滚：从 `bundles` 里删掉这一行并重启即可（插件文件留在磁盘上不影响启动）。

## 2. 设置页：工作区、权限、渠道、模型

**设置 → AstrBot 桥接** 里有三块：桥接状态（接口地址、中转连接、令牌，可复制）、
中转隧道（启用开关 + 地址 / 房间 / 密钥，可一键生成房间）、新会话默认值。
保存即生效（写入 `~/.dsh/astrbot-bridge.json`，优先于 YAML）：

| 项 | 含义 |
|---|---|
| 工作区 | 新建会话的工作目录，例如 `D:/harness`。留空 = 沿用 DSH 默认工作区 |
| 对话权限 | 权限预设名，如 `danger-full-access`；留空 = DSH 默认。聊天里没人能点「允许」，所以无人值守时建议用完全权限预设，否则工具会被自动拒绝 |
| 渠道 | provider，例如 `openai-codex`；下拉列表来自 `ctx.llm.listProviders()` |
| 模型 | 例如 `gpt-6.1-sol`；下拉来自该渠道的 `listModels()` |
| 超时 | 单条指令最长执行时间（秒） |
| 列表每页 | `/dshls` 每页条数，默认 15 |
| 中转地址 / 房间 / 密钥 | 填好后勾「启用中转」保存，DSH 会立刻重连；不用再改 YAML |

> 每轮结束后桥接会**释放**该会话的 agent（`releaseAfterTurn: false` 可关掉），
> 这样桌面端才能打开同一条会话接着聊；下一次 `/dsh` 会重新 `resume`。
> 一旦检测到「不是桥接发起的 turn」（也就是有人在桌面或 dsh-remote-plugin 里继续了它），
> 这条会话被标记为 external，桥接不再为它推送主动消息。

页面顶部显示桥接状态、令牌（可复制）和中转连接状态。

**注意**：工作区/权限在每一轮对话前重新应用；渠道和模型只作用于**新建**的会话——
已经在跑的会话中途换模型会改掉它的请求前缀，这里刻意不做。

## 3. 它能看见哪些会话

除了桥接自己建的会话，插件会读 DSH 自己的会话库（`ctx.sessionQuery.listSessions()`）：

- `/dshls` 里同时列出**桌面端/手机端建过的会话**，末尾标「桌面会话」，按工作区分组、15 条一页；
- `/dsh <序号>` 可以把聊天接到这些会话上，之后 `/dsh <指令>` 就在里面继续——恢复时**沿用该会话自己的渠道/模型**，不会被设置页的默认值改掉；
- 正在桌面端打开着的会话会被占用（同一会话 id 不能有两个 agent），这时会明确回「这个会话正被 DSH 桌面端打开」；
- 子代理（`origin: subagent`）的会话不出现在列表里；标题是按页懒加载并缓存 60 秒，列表最多取最近 200 条（`LocalSessions.list` 的默认上限）。

## 4. HTTP API

只监听 `127.0.0.1:8399`（可改），所有请求都要带令牌：

```bash
TOKEN=$(cat ~/.dsh/astrbot-bridge.token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8399/v1/health
```

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/v1/health` | 版本、工作区、权限、渠道、模型、中转状态 |
| POST | `/v1/chat` | `{chatKey, text, follow?, newSession?, sessionId?, timeoutMs?, user?}` → `{text, sessionId, durationMs, turns, interrupted, workspace, error, attachments, user}` |
| GET | `/v1/sessions?chatKey=&page=&perPage=&includeLocal=` | 按工作区分组的一页会话（默认把本机已有会话也列进来），每条带 `user`/`external`/`origin`，`total/pages/offset/currentSession` |
| POST | `/v1/switch` | `{chatKey, sessionId}` 或 `{chatKey, index}`：把聊天指向某条会话（`index` 就是 `/dshls` 里的全局序号） |
| POST | `/v1/cancel` | `{chatKey}`：取消正在跑的那一轮 |
| GET | `/v1/notify` | 「已结束但没确认收到」的结果/报错；确认前会重复返回（至少一次），可按 `chatKey` 过滤 |
| POST | `/v1/ack` | `{chatKey, turnId}`：确认收到；推送成功后再 ack，失败则下轮重试 |

`chatKey` 由调用方定义（AstrBot 用 `unified_msg_origin`），一个 key 一个「当前会话」；
`user` 只是「谁发起的」，会显示在会话列表里，不会进入提示词。

`/v1/chat` 的响应里还有 `turnId`、`error`（本轮中途的完整报错，例如 `429 Rate Limit Reached`）
和 `attachments`（回复里提到、且确实存在于磁盘上的文件）。HTTP 响应成功写回时桥接会自动 ack；
连接中途断掉的那一轮会在 2.5 秒后进入待推送队列，由 `/v1/notify` 取走——这就是「主动消息」的来源。

`follow=true` 时：如果这个 key 处于 `continue` 模式（用户刚用 `/dsh <n>` 切过会话），就继续当前会话，否则新建。
`newSession=true` 永远新建。

## 5. 中转（两台机器都没有公网端口）

relay 只是一台**双方都能连到**的会合服务器，读不到明文：

```
node relay-server.mjs --port 9443 --host 0.0.0.0
```

它和 `dsh-mobile-relay/relay.js` 帧格式兼容（4 字节长度 + JSON 握手；8 字节帧头；
DATA 载荷 AES-128-GCM 密封），所以已经跑着 dsh-mobile-relay 的话可以直接复用那台。

在 `cordis.patch.yml`（或 profile 覆盖）里打开：

```yaml
    - id: astrbot-bridge
      name: dsh-astrbot-bridge
      config:
        relay:
          enabled: true
          url: relay.example.com:9443     # 双方都能连到的地址
          room: 3f2a…（32 位 hex）
          key:  （base64url 编码的 16 字节）
```

`room` 和 `key` 就是 AstrBot 端要填的两个值：**key 等同于钥匙，谁拿到谁能跑这台电脑上的命令**。
可以用 `node -e "const c=require('crypto');console.log(c.randomBytes(16).toString('hex'), c.randomBytes(16).toString('base64url'))"` 生成。

握手/密钥细节（与 dsh-remote-plugin 一致）：

- 握手：`{"v":1,"role":"host","room":"<hex>"}` / `{"v":1,"role":"client","room":"<hex>","salt":"<base64>"}`；
- 密钥：`HKDF-SHA256(roomKey, salt, "dshm/c2h" | "dshm/h2c")` → 16 字节；
- nonce：4 字节 0 + 8 字节大端计数；AAD 是帧头去掉 channel 字节后的 7 字节；
- 客户端发帧时 channel 填 0，中转改写成分配到的 channel；中转拿不到密钥。

想让 AstrBot 走中转，把 `relay.enabled` 打开、AstrBot 端 `transport=relay`，填同样的 url/room/key/token。

## 6. 安全模型

- HTTP 默认只绑 `127.0.0.1`；要跨机直连得显式改 `http.host` 并自己处理防火墙。
- 每个请求都要 `Authorization: Bearer <token>`，常量时间比较；令牌文件 0600。
- relay 侧只做路由，载荷端到端加密；房间 ID 是 128 位随机数。
- 拿不到令牌就无法执行任何东西；能执行就意味着**这台电脑上的任意命令**——别把设置页截图发出去。

## 7. 聊天里会看到什么

- 执行期间每个 `progress_interval_minutes`（默认 10 分钟，0 关闭）发一句
  `（任务名）已经深度求索了 1 时 5 分…`。
- 结果首行只有 `⏱ 42.3s`；中途报错时紧接着一行
  `会话中途报错，原因：429 Rate Limit Reached`。
- 结果里提到的本地文件会在末尾列成 `附件1：D:/out/report.md`（**不上传文件**）。
- 超时/断线导致没送达的那一轮，稍后作为主动消息补发；有人在别处继续过这条会话则不补发。

## 8. 已知限制

- 渠道/模型改动只影响新会话。
- 一个 `chatKey` 同时只跑一轮（同一会话并发会排队），不同聊天并行。
- 会话由桥接进程持有；DSH 重启后下次调用会自动 `resume` 落盘的会话。
- 同一条会话不要同时从聊天和桌面驱动；桥接在一轮结束后会主动释放，桌面可以随时接管。
- 附件是「从回复文本里认出、且磁盘上存在」的绝对路径；图片类附件（DSH 内部 attachment id）拿不到路径，不会列出。
- 本机会话列表只取最近 200 条；需要看更早的会话请直接在桌面端打开。

## 9. 自测

```bash
npm test            # api-e2e（HTTP+设置路由），relay-e2e（relay + Python 客户端）
node test/relay-e2e.mjs   # 需要带 cryptography 的 Python；自动挑一个
```

`test/api-e2e.mjs` 用一个假宿主（`test/mock-ctx.mjs`）覆盖：鉴权、会话新建/继续/切换、
分页与工作区分组、设置读写与工作区校验、错误码。
`test/relay-e2e.mjs` 会拉起 `relay-server.mjs`，再用 AstrBot 那头的 Python 客户端分别走
直连和隧道各跑一遍完整流程（含 9000 字的多帧大包）。
