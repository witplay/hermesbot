# HermesBot — WeChat Mini Program client for Hermes

A native WeChat mini program that talks to your self-hosted [Hermes](https://hermes-agent.nousresearch.com/docs) agent dashboard. Browse sessions, continue a chat, manage cron jobs and workspaces, on a phone.

微信小程序客户端，用来连接你自己部署的 Hermes 智能体面板：查看会话、继续对话、管理定时任务与工作区。

This is a **client only**. It ships no backend, no model keys, and no hosted service — it connects to an endpoint you provide at runtime.

## Features

| Page | What it does |
|---|---|
| `launch` | Restores the last endpoint + session, resumes where you left off |
| `endpoints` / `endpoint-form` | Add, edit, test multiple Hermes endpoints (scheme + host + port); per-endpoint credentials |
| `sessions` | Session list with rename, delete, pin, and workspace filtering |
| `chat` | Conversation view, streaming-ish message rendering with a small local markdown renderer, model + reasoning-level pickers, prompt enhancer, file sheet, audio transcription |
| `cron-form` / `cron-history` | Create / edit scheduled jobs and read their run history |
| `components/ic`, `components/filesheet`, `components/navigation-bar` | Icon set, attachment sheet, custom nav bar |

## Authentication

Three paths, all at runtime — nothing is stored in the source:

1. **Password login** — `POST /auth/password-login` with a manual cookie jar, then exchange the PKCE loopback code at `/auth/native/token` (the dashboard only returns the code when its broker cookie rides along, and `wx.request` does not persist cookies, so the jar is hand-rolled).
2. **Bearer tokens** returned directly in the response body.
3. **Refresh** — `/auth/native/refresh`, with the token bound to its origin (scheme + host + port): after you edit an endpoint, an old token is never sent to the new origin.

Tokens live in `wx` local storage via `utils/store.js`, keyed per endpoint (`hermes.endpoint.v1`), with a migration step on launch.

## Configure

1. Open the project in WeChat DevTools (miniprogram, not mini-game).
2. In `project.config.json`, replace `appid` with your own mini program AppID:
   ```json
   "appid": "wxYOUR_APPID_HERE"
   ```
   The AppID shipped here is a placeholder on purpose. Any AppID you see in a public repo belongs to its owner — using someone else's will fail at compile time.
3. If you build for a phone, add your endpoint domain to **开发管理 → 开发设置 → 服务器域名** (request 合法域名) — mini programs refuse arbitrary hosts at runtime, and `127.0.0.1` only works with "不校验合法域名" enabled in the dev tools.
4. Enter your endpoint in the app: `https://your-hermes-host[:port]`, then log in.

## Local storage keys

| Key | Contents |
|---|---|
| `hermes.endpoints.v1` | endpoint list (label, baseUrl, optional path prefix) |
| `hermes.token.v1:<origin>` | access / refresh token per origin |
| `hermes.last.v1` | last endpoint + session (resume target) |
| `hermes.enhance.v1` | prompt-enhancer settings (optional API base + key you enter yourself) |
| `hermes.theme.v1` | theme choice |

## Structure

```
app.js / app.json / app.wxss       app shell, page registry, global styles
pages/                             one folder per screen (js/json/wxml/wxss)
components/                        ic icons, filesheet attachment sheet, navigation-bar
utils/auth.js                      PKCE + password login + refresh
utils/http.js                      request wrapper, cookie jar, bearer injection
utils/store.js                     endpoint/token storage, origin binding
utils/gateway.js                   gateway request helpers
utils/cron.js sessionsops.js workspaces.js drafts.js files.js last.js
utils/models.js enhance.js markdown.js sha256.js theme.js util.js
```

## Notes and limits

- The prompt enhancer calls an OpenAI-compatible endpoint **you configure yourself** (default suggestion: `https://api.deepseek.com/v1`); without a key it stays disabled.
- Audio transcription uses the dashboard's own endpoint (`/api/audio/transcribe`), so it needs a Hermes instance that exposes it.
- No analytics, no third-party SDKs, no telemetry.
- WeChat mini programs can't use `wss` sockets on some older base library versions; the chat page degrades to polling.

## Need it deployed? · 商业支持

The client is free and stays free. What people actually get stuck on is everything around it:
a Hermes instance that really runs, WeChat 服务器域名 whitelisting, an AppID, HTTPS on your
own domain. That part I do as a paid service, plus custom work on top of this code.

| 服务 | 内容 |
|---|---|
| 部署上线 | Hermes + 本小程序全套跑通：服务器、域名、request 合法域名、AppID、HTTPS 证书 |
| 白标改版 | 换名称 / 主题 / 图标 / 入口，做成你自有品牌的小程序 |
| 二次开发 | 接你的业务接口、加页面、私有化改造 |

**联系方式**：在本仓库开一个 issue，标题写 `[商业合作]` 或 `[commercial]`，48 小时内回复。
Please open an issue titled `[commercial]` — that's the fastest channel.

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, ship it commercially; keep the copyright notice.

## Trademark and affiliation

The MIT license covers the **source code only**. It does not grant rights to the *HermesBot*
name or the app icon — a fork should ship under its own name so users don't mistake it for
the original.

This is an independent client. It is **not affiliated with or endorsed by Nous Research**;
"Hermes" and "Hermes Agent" belong to their respective owner.

协议只覆盖代码，不含名称与图标；本项目是独立客户端，与 Nous Research 无隶属关系。
