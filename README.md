# delta-router

Route **Delta**'s model traffic through whichever provider you already configured in **cc-switch** — with a local MITM proxy that **only Delta uses**.

[中文文档](README.zh-CN.md)

## Why this exists

Delta (Zed Industries' coding agent) has no custom base URL anywhere:

- provider endpoints are compiled into the binary (`api.anthropic.com`, `api.openai.com`, `openrouter.ai/api/v1`, `inference.baseten.co/v1`, `opencode.ai/zen`, `cli-chat-proxy.grok.com/v1`, `api.githubcopilot.com`, `chatgpt.com/backend-api/codex`);
- the string `base_url` / `api_url` does not occur in the binary at all;
- the only overridable URL is `CLOUD_URL`, and that is Zed's own cloud;
- Settings → LLM Providers exposes API keys and OAuth sign-ins, nothing else.

So "use my relay" is impossible from the configuration side. delta-router solves it from the network side: Delta keeps talking to the official hostnames, and this proxy quietly terminates those connections locally and forwards them to your cc-switch provider with **its** credentials. Switching providers stays a cc-switch operation.

## How it works

```
Delta ──┐  native.proxy = http://127.0.0.1:8788   (in Delta's own settings.json)
        ▼
   127.0.0.1:8788 ──┬── intercepted host (config.json:intercept)
                    │     TLS terminate with a local CA → route to cc-switch provider
                    │     inject real credential → stream response back
                    └── anything else
                          blind TCP tunnel (Delta's cloud / telemetry keep working)
                                  │
                                  ▼
                    ~/.cc-switch/cc-switch.db
                    providers where app_type = claude  (Anthropic Messages wire)
                                        or codex       (OpenAI Responses wire)
                                  │
                                  ▼
                    https://your-relay.example/v1/messages
```

Upstream order mirrors cc-switch exactly: its **current** provider first, the remaining ones kept as failover. Retryable upstream answers (`401/402/403/404/429/5xx`) fall through to the next provider automatically, and every request is logged in one line.

## Scope and safety

- **Delta only.** No `/etc/hosts` edit, no system-wide proxy, no `sudo`.
- The local CA is trusted **at user level and restricted to the SSL policy** (`security add-trusted-cert -r trustRoot -p ssl -k ~/Library/Keychains/login.keychain-db`), and is one command to remove.
- Your real API keys never enter Delta. Delta stores a placeholder (`ANTHROPIC_API_KEY=delta-router`, `OPENAI_API_KEY=delta-router`); the router swaps in the credential from cc-switch server-side.
- Only hosts listed in `config.json:intercept` are decrypted. Everything else is a plain TCP tunnel.
- `certs/` (CA + leaf private keys) and `logs/` are gitignored.

## Requirements

- macOS (uses `launchd`, `security`, and the login keychain)
- Node.js ≥ 20
- Delta 0.1.x — verified against 0.1.0 (`com.zed-industries.delta`)
- cc-switch with at least one `claude` or `codex` provider

## Setup

```bash
git clone https://github.com/cc-hearts/delta-router.git
cd delta-router

npm run setup-ca            # local CA + leaf certificate for the intercepted hosts
node src/cli.js trust-ca    # trust that CA (user keychain, SSL only)
node src/cli.js install-delta   # point Delta's native.proxy at 127.0.0.1:8788
node src/cli.js write-keys      # placeholder credentials for Delta
node src/cli.js install-agent   # run the router at login (launchd, KeepAlive)

# restart Delta so it picks up native.proxy and the credentials
node src/cli.js doctor      # expect every check to pass
```

`doctor` sends real requests through the whole chain (Anthropic `/v1/messages` and OpenAI `/v1/responses`) using throwaway credentials, so it proves the wiring, not just the config. It costs a few tokens on your relay.

## TUI

```bash
npm start
```

```
 delta-router · Delta → cc-switch
  router   running pid 1234   127.0.0.1:8788
  delta    proxy ok   key ok   ca ok
────────────────────────────────────────────────────────────
 ROUTES （跟随 cc-switch 的 current provider）
  api.anthropic.com → <your provider>  https://your-relay.example  47/9 259ms
                       ↳ <failover 1>  https://relay-2.example
  api.openai.com → <your provider>  https://your-relay.example  14 1193ms
ACTIVITY
────────────────────────────────────────────────────────────
s 启动/暂停   d doctor   c 卸载证书   q 退出
```

Four keys, nothing else:

| key | action |
| --- | --- |
| `s` | start / pause the router |
| `d` | run `doctor` and stream its output into the panel |
| `c` | install / uninstall the local certificate |
| `q` | quit |

`ACTIVITY` only shows lines from the moment the TUI started (plus `doctor` output) — one line per request, no TLS/tunnel noise. The health counters next to each route are seeded from history so you can see which relay is flaky.

## CLI

| command | purpose |
| --- | --- |
| `node src/cli.js doctor` | end-to-end self test (Anthropic + Codex routes) |
| `node src/cli.js test-delta` | restart Delta and confirm its traffic reaches the router |
| `node src/cli.js status` | config, routes, trust and credential state |
| `node src/cli.js upstreams` | providers found in cc-switch |
| `node src/cli.js write-keys` | write placeholder credentials for Delta |
| `node src/cli.js install-delta` / `uninstall-delta` | point Delta at the router / restore its settings |
| `node src/cli.js install-agent` / `uninstall-agent` | launchd agent |
| `node src/cli.js trust-ca` / `untrust-ca` | local CA trust |
| `npm run serve` | run the router in the foreground |

## Configuration (`config.json`)

| key | meaning |
| --- | --- |
| `listen` | where the proxy listens (default `127.0.0.1:8788`) |
| `tls` | local CA / leaf certificate paths under `certs/` |
| `intercept` | hostnames to decrypt and reroute |
| `routes.<host>.protocol` | wire protocol of the upstream: `anthropic` or `openai` |
| `routes.<host>.ccswitchAppType` | which cc-switch table to read: `claude` or `codex` |
| `routes.<host>.authStyle` | how the credential is sent: `both`, `x-api-key`, `bearer` |
| `routes.<host>.modelMap` | rewrite model ids before forwarding |
| `routes.<host>.stripFields` | drop request fields a relay rejects |
| `routes.<host>.static` / `staticFirst` | hand-written upstreams that take priority |
| `routes.<host>.retryStatuses` | statuses that trigger failover |
| `routes.<host>.modelFallback` | ids returned for `GET /v1/models` when the relay has none |
| `ccswitch.cacheMs` | how long a provider list is cached (default 15 s) |

`config.json` is **hot-reloaded**: edit it and the next request uses the new values, no restart. Changing `src/` code needs a router restart (`s s` in the TUI, or `launchctl kickstart -k gui/$UID/dev.carl-github.delta-router`).

## Adding another provider or protocol

1. Add the hostname to `intercept`.
2. Add a route with the right `protocol` and `ccswitchAppType`.
3. Re-run `npm run setup-ca` (it reuses the existing CA and reissues the leaf with the new SANs), then `node src/cli.js trust-ca` is *not* needed — the CA did not change.

Anthropic Messages (`/v1/messages`, streaming SSE) and OpenAI Responses (`/v1/responses`) are supported, including WebSocket upgrades, plus two convenience fallbacks: `count_tokens` is estimated locally when a relay does not implement it, and `GET /v1/models` falls back to a configured list.

## Troubleshooting

| symptom | fix |
| --- | --- |
| header shows `proxy 未接入` | `node src/cli.js install-delta`, then restart Delta |
| header shows `ca 未信任` | press `c` in the TUI (or `node src/cli.js trust-ca`) |
| header shows `key 缺失` | `node src/cli.js write-keys`, then restart Delta |
| a route logs `RETRY … 401` | that relay's token is dead — switch provider in cc-switch |
| Delta has no network at all | the router is down: press `s` in the TUI; escape hatch is `node src/cli.js uninstall-delta` |
| `count_tokens estimated` in logs | normal: the relay has no `count_tokens`, the router estimates it |
| Delta keeps its own settings | Delta rewrites `settings.json` on save; if `native.proxy` disappears, the header says so |

## Limitations

- The relay must speak the same wire protocol (Anthropic Messages or OpenAI Responses); it is a rerouter, not a protocol translator.
- Requires local TLS interception, so the CA must be trusted; this is inherent to any tool that changes a hardcoded HTTPS endpoint.
- macOS only for now (`launchd`, `security`, keychain trust). The proxy itself is portable Node; the install helpers are not.

## Uninstall

```bash
node src/cli.js uninstall-delta   # restore Delta's settings.json
node src/cli.js uninstall-agent   # stop autostart
node src/cli.js untrust-ca        # remove the CA
rm -f ~/.config/delta/.env        # drop the placeholder credentials
```

## License

MIT — see [LICENSE](LICENSE).
