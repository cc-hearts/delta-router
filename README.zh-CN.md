# delta-router

把 **Delta** 的模型流量，接到你已经在 **cc-switch** 里配好的任意 provider 上 —— 用一个**只对 Delta 生效**的本地 MITM 代理实现。

[English](README.md)

## 为什么需要它

Delta（Zed Industries 的编码 agent）没有任何自定义 base URL 的口子：

- 各家 endpoint 是编译进二进制的常量（`api.anthropic.com`、`api.openai.com`、`openrouter.ai/api/v1`、`inference.baseten.co/v1`、`opencode.ai/zen`、`cli-chat-proxy.grok.com/v1`、`api.githubcopilot.com`、`chatgpt.com/backend-api/codex`）；
- 整个二进制里 `base_url` / `api_url` 这两个字符串出现 **0 次**；
- 唯一能被覆盖的 URL 是 `CLOUD_URL`，那是 Zed 自家的云；
- Settings → LLM Providers 只提供 API key 和 OAuth 登录，没有第三样东西。

所以"用我自己的中转"从配置层面走不通。delta-router 从网络层面解决：Delta 照旧请求官方域名，代理在本机把这些连接终止掉，换成 **cc-switch 里当前生效 provider** 的地址和凭据转发出去。换 provider 依然是 cc-switch 的操作。

## 工作原理

```
Delta ──┐  native.proxy = http://127.0.0.1:8788   （写在 Delta 自己的 settings.json 里）
        ▼
   127.0.0.1:8788 ──┬── 命中 config.json:intercept 的域名
                    │     用本地 CA 终止 TLS → 转发到 cc-switch 的 provider
                    │     注入真实凭据 → 原样流式回传
                    └── 其它一切
                          盲隧道直通（Delta 的云同步 / 遥测照常工作）
                                  │
                                  ▼
                    ~/.cc-switch/cc-switch.db
                    providers 表 app_type = claude    （Anthropic Messages）
                                     或 codex     （OpenAI Responses）
                                     或 opencode  （OpenAI Chat Completions）
                                  │
                                  ▼
                    https://your-relay.example/v1/messages
```

每条通道只打**一条**上游：cc-switch 里那个 app（claude / codex / opencode）**当前选中的 provider**。换 provider 就是在 cc-switch 里点一下，路由器下一个请求就跟着换。没有 failover。每个请求一行日志。

## 作用域与安全

- **只影响 Delta**：不改 `/etc/hosts`、不改系统代理、不需要 `sudo`。
- 本地 CA **只装在本用户的登录钥匙串里，并且信任策略限定为 SSL**（`security add-trusted-cert -r trustRoot -p ssl -k ~/Library/Keychains/login.keychain-db`），一条命令就能卸掉。
- 你的真实 key 永远不进 Delta：`write-keys` 会写四个占位符（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`OPENCODE_API_KEY`、`OPENCODE_GO_API_KEY`），真实凭据由路由器在服务端替换。Delta 是「有凭据才启用该 provider」，所以占位符就是它列出模型的前提 —— 值本身无意义，也从不会被上游看到。
- 只有 `config.json:intercept` 里列出的域名会被解密，其余流量原样隧道透传。
- `certs/`（CA 与叶子私钥）和 `logs/` 已在 `.gitignore` 中。

## 环境要求

- macOS（用到 `launchd`、`security` 和登录钥匙串）
- Node.js ≥ 20
- Delta 0.1.x —— 在 0.1.0（`com.zed-industries.delta`）上验证
- cc-switch 里至少有一条 `claude` 或 `codex` provider

## 安装

```bash
git clone https://github.com/cc-hearts/delta-router.git
cd delta-router

npm run setup-ca                # 生成本地 CA + 覆盖拦截域名的叶子证书
node src/cli.js trust-ca        # 信任该 CA（用户级，仅 SSL）
node src/cli.js install-delta   # 把 Delta 的 native.proxy 指向 127.0.0.1:8788
node src/cli.js write-keys      # 给 Delta 写占位凭据
node src/cli.js install-agent   # 路由器随登录自启（launchd，KeepAlive）

# 重启 Delta，让它读到 native.proxy 和占位凭据
node src/cli.js doctor          # 期望全部通过
```

`doctor` 用一次性占位凭据**真打**整条链路（Anthropic `/v1/messages` 与 OpenAI `/v1/responses`），所以它验证的是接线而不是配置。会消耗你中转上几十个 token。

## TUI

```bash
npm start
```

```
 delta-router · Delta → cc-switch
  router   running pid 1234   127.0.0.1:8788
  delta    proxy ok   key ok   ca ok
────────────────────────────────────────────────────────────
 ROUTES （= cc-switch 里各 app 当前选中的 provider）
  api.anthropic.com → <选中的 claude>  https://your-relay.example  47/9 259ms
  api.openai.com → <选中的 codex>  https://relay-2.example  14 1193ms
  opencode.ai → <选中的 opencode>  https://api.moonshot.cn/v1  8 640ms
ACTIVITY
────────────────────────────────────────────────────────────
s 启动/暂停   d doctor   c 卸载证书   q 退出
```

只有四个键（`q` 和 `Ctrl-C` 等价）：

| 键 | 作用 |
| --- | --- |
| `s` | 启动 / 暂停路由器 |
| `d` | 跑 `doctor`，输出直接打进面板 |
| `c` | 安装 / 卸载本地证书 |
| `q` | 退出 |

退出是立即的、不做任何清理：不碰证书，也不会等正在跑的命令 —— 按 `q` / `Ctrl-C` 会杀掉面板起的子进程直接走。证书操作要等 macOS 授权弹窗，等待期间面板照常响应（提示会显示"等待系统授权 …"），`q` 会取消它并退出。`Ctrl-C` 只退出，不会误触 `c` 的证书开关。

`ACTIVITY` 只显示**本次启动之后**的日志（外加 `doctor` 输出），一个请求一行，没有 TLS / 隧道的噪音。每条路由右侧的成功/失败计数来自历史流量，用来看哪条中转不稳。

## 命令行

| 命令 | 用途 |
| --- | --- |
| `node src/cli.js doctor` | 全链路自检（Anthropic + Codex 两条路由） |
| `node src/cli.js test-delta` | 重启 Delta 并确认它的流量真的到了路由器 |
| `node src/cli.js status` | 配置、路由、证书信任、凭据状态 |
| `node src/cli.js upstreams` | 列出 cc-switch 里的 provider |
| `node src/cli.js write-keys` | 写入 Delta 的占位凭据 |
| `node src/cli.js install-delta` / `uninstall-delta` | 接入 Delta / 还原它的设置 |
| `node src/cli.js install-agent` / `uninstall-agent` | launchd 自启 |
| `node src/cli.js trust-ca` / `untrust-ca` | 本地 CA 信任 |
| `npm run serve` | 前台运行路由器 |

## 配置（`config.json`）

| 键 | 含义 |
| --- | --- |
| `listen` | 代理监听地址（默认 `127.0.0.1:8788`） |
| `tls` | `certs/` 下的本地 CA 与叶子证书 |
| `intercept` | 需要解密并改道的域名 |
| `routes.<host>.ccswitchAppType` | 这条通道接到 cc-switch 的哪个 app：`claude` / `codex` / `opencode`。上游就是该 app 当前选中的那条 provider |
| `routes.<host>.authStyle` | 凭据的发送方式：`both` / `x-api-key` / `bearer` |
| `routes.<host>.modelMap` | 转发前改写模型 id（默认不写，模型 id 原样透传） |
| `routes.<host>.stripFields` | 丢掉上游不认的请求字段 |
| `routes.<host>.stripPrefix` | 转发前剥掉拦截域名自己的路径前缀（`opencode.ai/zen/go` → 上游 `/v1/...`） |
| `routes.<host>.modelFallback` | 上游没有 `GET /v1/models` 时返回的模型列表 |
| `ccswitch.cacheMs` | provider 列表缓存时长（默认 15 秒） |

`config.json` 是**热加载**的：改完下一个请求就生效，不用重启。改 `src/` 里的代码才需要重启路由器（TUI 里按两次 `s`，或 `launchctl kickstart -k gui/$UID/dev.carl-github.delta-router`）。

## 再加一家 / 再支持一种协议

1. 把域名加进 `intercept`；
2. 加一条路由，填 `ccswitchAppType`（`claude` / `codex` / `opencode`）；
3. 重跑 `npm run setup-ca`（复用现有 CA，只重签叶子证书覆盖新 SAN），**不需要**重新 `trust-ca`；
4. 如果拦截域名把流量放在自己的路径前缀下（`opencode.ai/zen/v1/chat/completions`），加 `stripPrefix` 把它剥掉 —— 除此之外没有别的开关，`doctor` 的探针形状也是按 `ccswitchAppType` 推出来的。

三种形状：Anthropic Messages（`/v1/messages`）、OpenAI Responses（`/v1/responses`）、OpenAI Chat Completions（`/v1/chat/completions`），各自对应 `claude` / `codex` / `opencode`。改道器不做协议转换 —— cc-switch 里选中的那条上游必须说同一种形状。WebSocket 升级原样转发。

已接的路由：

| 拦截域名 | 形状 | 上游来自 |
| --- | --- | --- |
| `api.anthropic.com` | Anthropic Messages | cc-switch `claude` 当前选中 |
| `api.openai.com` | Responses（含 wss） | cc-switch `codex` 当前选中 |
| `opencode.ai` | Chat Completions（Zen `/zen/v1`、Go `/zen/go/v1`） | cc-switch `opencode` 当前选中 |

`opencode.ai` 的目录来自 `models.opencode.ai`（**不**拦截），Delta 的 OpenCode 目录里是裸 id（`kimi-k3`、`glm-5.3`…），和 cc-switch `opencode` provider 的 `models` 键名一致 → 不需要 `modelMap`。非推理路径（`/zen/go/v1/usage`、登录）不在拦截之列 —— 它们也会被改道到 cc-switch 那条上游，用量显示因此不可用（仅影响显示）。

模型 id 一律原样转给上游；只有你显式写了 `modelMap` 才会改写。

## 排错

| 现象 | 处理 |
| --- | --- |
| 顶部显示 `proxy 未接入` | `node src/cli.js install-delta`，然后重启 Delta |
| 顶部显示 `ca 未信任` | TUI 里按 `c`（或 `node src/cli.js trust-ca`） |
| 顶部显示 `key 缺失`，或 Delta 里某个 provider 没有模型 | `node src/cli.js write-keys`，然后重启 Delta —— Delta 是「有凭据才列出模型」，占位符就够 |
| 某条通道报 401/403/5xx | 那是 cc-switch 里该 app **当前选中**那条上游的声音 —— 去 cc-switch 换一条，或修它的 token |
| `doctor` 有 FAIL | 逐条就是「cc-switch 当前选的那条 provider 不通」；`cc-switch providers for <host>` 一行会告诉你是哪条 |
| Delta 完全没网 | 路由器挂了：TUI 里按 `s`；逃生出口是 `node src/cli.js uninstall-delta` |
| 日志出现 `count_tokens estimated` | 正常：上游没有 `count_tokens`，由本机估算 |
| Delta 自己改回设置 | Delta 保存设置时会重写 `settings.json`；若 `native.proxy` 消失，顶部会提示 |

## 限制

- 中转必须说同一种协议（Anthropic Messages 或 OpenAI Responses）—— 这是改道器，不是协议转换器。
- OpenCode 的账号接口（`/zen/*/v1/usage`）由路由器**本地应答** `200 {}`：Delta 要从这里拿到 200 才肯启用该 provider，否则报 `API endpoint not found.`（改道后这个请求会落到 cc-switch 的上游，那边没有这个路径）。代价是用量显示为空；数字本来也无意义 —— 推理用的是 cc-switch 的凭据。
- 依赖本地 TLS 拦截，因此必须信任本地 CA；任何"改掉硬编码 HTTPS 端点"的方案都躲不开这一步。
- 目前仅 macOS（`launchd`、`security`、钥匙串信任）。代理本身是纯 Node、可移植，只是安装辅助脚本不是。

## 卸载

```bash
node src/cli.js uninstall-delta   # 还原 Delta 的 settings.json
node src/cli.js uninstall-agent   # 关掉自启
node src/cli.js untrust-ca        # 移除 CA
rm -f ~/.config/delta/.env        # 删掉占位凭据
```

## License

MIT —— 见 [LICENSE](LICENSE)。
