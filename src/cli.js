#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { readCcSwitchProviders, resolveUpstreams } from './upstreams.js';
import * as agent from './agent.js';
import * as delta from './delta.js';

const cfg = loadConfig();
const cmd = process.argv[2] ?? 'help';

const mask = (k) => (k ? `${k.slice(0, 6)}…(${k.length})` : '(none)');
const routesOf = (c) => c.intercept.map((host) => ({ host, route: c.routes[host] }));

function logLines() {
  if (!fs.existsSync(cfg.logFile)) return [];
  return fs.readFileSync(cfg.logFile, 'utf8').split('\n');
}

/** Sends a request through the router exactly like Delta would, with a throwaway credential. */
function throughProxy(host, route, pathname, body, method = 'POST') {
  const args = [
    '-sS', '--noproxy', '', '-x', delta.proxyUrl(cfg), '--cacert', cfg.tls.ca,
    '-w', '\n%{http_code}', '--max-time', '180', '-X', method,
  ];
  if (route.ccswitchAppType === 'claude') {
    args.push('-H', 'anthropic-version: 2023-06-01', '-H', 'x-api-key: doctor-placeholder');
  } else {
    args.push('-H', 'authorization: Bearer doctor-placeholder');
  }
  if (body) args.push('-H', 'content-type: application/json', '-d', JSON.stringify(body));
  args.push(`https://${host}${pathname}`);
  const out = execFileSync('curl', args, { encoding: 'utf8' });
  const nl = out.lastIndexOf('\n');
  return { status: Number(out.slice(nl + 1).trim()), body: out.slice(0, nl) };
}

/**
 * How `doctor` proves each route end to end. The shape follows the cc-switch app the route maps
 * to, and the path Delta itself uses is the route's `stripPrefix` plus that shape's path.
 */
const PROBE_SHAPES = {
  claude: {
    path: '/v1/messages',
    body: (model) => ({
      model,
      max_tokens: 32,
      stream: true,
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
    }),
    sse: /event: message_start/,
  },
  codex: {
    path: '/v1/responses',
    body: (model) => ({ model, input: [{ role: 'user', content: 'say pong' }], stream: true }),
    sse: /^event: /m,
  },
  opencode: {
    path: '/v1/chat/completions',
    body: (model) => ({
      model,
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
      max_tokens: 16,
      stream: true,
    }),
    sse: /^data: /m,
  },
};

function routeProbe(c, route) {
  const shape = PROBE_SHAPES[route.ccswitchAppType];
  const model = resolveUpstreams(c, route)[0]?.hint || 'gpt-5.6-sol';
  return {
    ...shape,
    body: shape.body(model),
    path: (route.stripPrefix?.[0] ?? '') + shape.path,
  };
}

const commands = {
  doctor() {
    const results = [];
    const check = (name, ok, detail = '') => {
      results.push({ name, ok });
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`);
    };

    check('router listening', agent.listenerPid(cfg.listen.port) !== null, `${cfg.listen.host}:${cfg.listen.port}`);
    check('CA trusted for SSL', delta.caTrusted(), cfg.tls.ca);
    check(
      'Delta native.proxy',
      delta.deltaSettingsProxy()?.replace(/\/+$/, '') === delta.proxyUrl(cfg),
      delta.deltaSettingsProxy() ?? '(unset)',
    );
    check('Delta placeholder keys', delta.placeholderKeysPresent(), delta.DELTA_ENV);

    for (const { host, route } of routesOf(cfg)) {
      const upstreams = resolveUpstreams(cfg, route);
      check(
        `cc-switch providers for ${host}`,
        upstreams.length > 0,
        upstreams.map((u) => u.name).join(' -> ') || `cc-switch has no ${route.ccswitchAppType} provider`,
      );
    }

    const before = logLines().length;
    for (const { host, route } of routesOf(cfg)) {
      const { path, body, sse } = routeProbe(cfg, route);
      const name = `${host} POST ${path} (streaming)`;
      try {
        const res = throughProxy(host, route, path, body);
        const ok = res.status === 200 && sse.test(res.body);
        check(name, ok, `HTTP ${res.status}${ok ? ', SSE ok' : ''}`);
      } catch (err) {
        check(name, false, err.message);
      }
    }

    console.log('\nrouter log for this run:');
    for (const line of logLines()
      .slice(before)
      .filter((l) => /ROUTE|FAIL|RETRY/.test(l))) {
      console.log(`  ${line.replace(/^\S+ /, '')}`);
    }

    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    if (failed) process.exit(1);
  },

  'test-delta'() {
    const marker = logLines().length;
    console.log('restarting Delta …');
    spawnSync('osascript', ['-e', 'quit app "Delta"']);
    spawnSync('sleep', ['5']);
    spawnSync('open', ['-a', 'Delta']);
    for (let i = 0; i < 12; i++) {
      spawnSync('sleep', ['5']);
      const fresh = logLines().slice(marker);
      const hits = fresh.filter((l) => cfg.intercept.some((h) => l.includes(h)));
      if (hits.some((l) => l.includes('ROUTE'))) {
        console.log('\nDelta is routing through delta-router:');
        for (const l of hits.filter((x) => /ROUTE|MITM|WS/.test(x))) console.log(`  ${l.replace(/^\S+ /, '')}`);
        console.log('\nresult: PASS — Delta traffic reached the upstream');
        return;
      }
    }
    console.log('\nresult: no Delta traffic on the intercepted hosts yet.');
    console.log('Delta calls a provider once it has a key: check Settings > LLM Providers,');
    console.log('or press e in the TUI to write the placeholder keys, then restart Delta.');
    process.exit(1);
  },

  status() {
    console.log(`config        ${cfg.file}`);
    console.log(`listen        ${cfg.listen.host}:${cfg.listen.port}`);
    console.log(`router        ${agent.listenerPid(cfg.listen.port) ?? 'stopped'}${agent.isLoaded() ? ' (launchd)' : ''}`);
    console.log(`delta proxy   ${delta.deltaSettingsProxy() ?? '(unset)'}`);
    console.log(`delta keys    ${delta.placeholderKeysPresent() ? 'placeholder set' : 'missing'}`);
    console.log(`ca trusted    ${delta.caTrusted() ? 'yes' : 'no'}  (${cfg.tls.ca})`);
    console.log('routes (mirror of cc-switch):');
    for (const { host, route } of routesOf(cfg)) {
      const list = resolveUpstreams(cfg, route);
      if (!list.length) console.log(`  ${host}: cc-switch has no ${route.ccswitchAppType} provider`);
      list.forEach((u, i) => {
        console.log(
          `  ${i === 0 ? '*' : ' '} ${host.padEnd(20)} ${u.name.padEnd(24)} ${u.base.padEnd(34)}` +
            ` key=${mask(u.key)}${u.current ? ' cc-switch-current' : ''}`,
        );
      });
    }
  },

  upstreams() {
    for (const p of readCcSwitchProviders(cfg.ccswitch.db)) {
      console.log(
        `${p.protocol.padEnd(9)} ${p.name.padEnd(26)} current=${p.current ? 'y' : 'n'} ${p.base} key=${mask(p.key)}`,
      );
    }
  },

  'install-delta'() {
    console.log(`native.proxy = ${delta.installProxy(cfg)}`);
    console.log(`backup       ${delta.DELTA_BACKUP}`);
    console.log('restart Delta to load it (settings are read at launch).');
  },

  'uninstall-delta'() {
    delta.uninstallProxy();
    console.log(`restored ${delta.DELTA_SETTINGS}`);
  },

  'write-keys'() {
    delta.writePlaceholderKeys();
    console.log(`wrote placeholder keys to ${delta.DELTA_ENV} (restart Delta)`);
  },

  'install-agent'() {
    const err = agent.start(cfg);
    console.log(err ? `bootstrap failed: ${err}` : `loaded ${agent.LABEL}`);
    console.log(agent.PLIST);
  },

  'uninstall-agent'() {
    agent.uninstall();
    console.log(`removed ${agent.LABEL}`);
  },

  async 'trust-ca'() {
    console.log(await delta.trustCa());
    const bad = !delta.caTrusted();
    if (bad) process.exit(1);
  },

  async 'untrust-ca'() {
    console.log(await delta.untrustCa());
  },
};

const USAGE = `delta-router — 把 Delta 的 Anthropic / OpenAI 流量接到 cc-switch 的 provider 上

  npm start / node src/tui.js   TUI 控制台（推荐入口）
  node src/cli.js doctor        全链路自检（Anthropic + Codex 两条路由）
  node src/cli.js test-delta    重启 Delta 并确认它的流量真的走了路由器
  node src/cli.js status        配置 / 路由 / 信任状态
  node src/cli.js upstreams     列出 cc-switch 里的 provider
  node src/cli.js write-keys    写入占位 key（重启 Delta 生效）
  node src/cli.js install-delta | uninstall-delta
  node src/cli.js install-agent | uninstall-agent
  node src/cli.js trust-ca | untrust-ca
`;

if (!commands[cmd]) {
  console.error(USAGE);
  process.exit(cmd === 'help' ? 0 : 2);
}
const pending = commands[cmd]();
if (pending instanceof Promise) {
  pending.catch((err) => {
    console.error(err?.stack ?? err);
    process.exit(1);
  });
}
