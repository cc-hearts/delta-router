#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { loadConfig, ROOT } from './config.js';
import { resolveUpstreams } from './upstreams.js';
import * as agent from './agent.js';
import * as delta from './delta.js';

const OUT = process.stdout;
const C = {
  r: '\x1b[0m',
  b: '\x1b[1m',
  dim: '\x1b[2m',
  g: '\x1b[32m',
  red: '\x1b[31m',
  y: '\x1b[33m',
  gy: '\x1b[90m',
};
const ESC = /^\x1b\[[0-9;]*m/;

/** East-Asian wide ranges occupy two terminal columns. */
function charWidth(cp) {
  return cp >= 0x1100 &&
    (cp <= 0x115f ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
    ? 2
    : 1;
}
const width = (s) => {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
};
const take = (s, w) => {
  let out = '';
  let used = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (used + cw > w) break;
    out += ch;
    used += cw;
  }
  return out;
};
const clip = (s, w) => (width(s) <= w ? s : `${take(s, w - 1)}…`);

/** Truncates to w visible columns, keeping colour escapes intact. */
function clipAnsi(s, w) {
  if (width(s.replace(/\x1b\[[0-9;]*m/g, '')) <= w) return s;
  const budget = w - 1;
  let out = '';
  let used = 0;
  let i = 0;
  while (i < s.length && used < budget) {
    const esc = ESC.exec(s.slice(i));
    if (esc) {
      out += esc[0];
      i += esc[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i));
    const cw = charWidth(s.codePointAt(i));
    if (used + cw > budget) break;
    out += ch;
    used += cw;
    i += ch.length;
  }
  return `${out}\x1b[0m…`;
}

// Only these lines reach the panel: one line per request, no TLS/tunnel noise.
const KEEP = /ROUTE|RETRY|FAIL|WS |listening|shutting down|config reloaded/;
const MAX_LINES = 400;

const state = {
  cfg: loadConfig(),
  routes: [],
  lines: [],
  stats: new Map(),
  pid: null,
  loaded: false,
  message: '就绪',
  busy: false,
  offset: 0,
  children: new Set(),
};

/**
 * Trust probing spawns `security`, which macOS can hold on an authorization prompt. Cache the
 * verdict so the render loop cannot hammer it, and bound each probe (see `delta.caTrusted`).
 */
const TRUST_TTL_MS = 10000;
let trust = { at: 0, value: false };
function caTrusted(force = false) {
  if (force || Date.now() - trust.at > TRUST_TTL_MS) {
    trust = { at: Date.now(), value: delta.caTrusted() };
  }
  return trust.value;
}

function bump(name, ok, ms) {
  if (!state.stats.has(name)) state.stats.set(name, { ok: 0, fail: 0, ms: null });
  const e = state.stats.get(name);
  if (ok) e.ok++;
  else e.fail++;
  if (ms) e.ms = ms;
}

function ingest(lines, { seed = false } = {}) {
  for (const l of lines) {
    if (!KEEP.test(l)) continue;
    const routed = /-> (.+) (\d{3}) (\d+)ms/.exec(l);
    if (routed) bump(routed[1], true, Number(routed[3]));
    else {
      const retry = /-> (.+?) (\d{3}) \(next upstream\)/.exec(l);
      const fail = /FAIL \S+ -> ([^:]+): /.exec(l);
      if (retry) bump(retry[1], false);
      else if (fail) bump(fail[1], false);
    }
    if (!seed) state.lines.push(l);
  }
  if (state.lines.length > MAX_LINES) state.lines = state.lines.slice(-MAX_LINES);
}

function readNewLog() {
  let size;
  try {
    size = fs.statSync(state.cfg.logFile).size;
  } catch {
    return;
  }
  if (size < state.offset) state.offset = 0;
  if (size === state.offset) return;
  const fd = fs.openSync(state.cfg.logFile, 'r');
  const buf = Buffer.alloc(size - state.offset);
  fs.readSync(fd, buf, 0, buf.length, state.offset);
  fs.closeSync(fd);
  state.offset = size;
  ingest(buf.toString('utf8').split('\n').filter(Boolean));
}

/** Starts the panel from "now": existing history seeds the health counters only. */
function startSession() {
  const cfg = loadConfig();
  if (fs.existsSync(cfg.logFile)) {
    const lines = fs.readFileSync(cfg.logFile, 'utf8').split('\n').filter(Boolean);
    ingest(lines.slice(-800), { seed: true });
    state.offset = fs.statSync(cfg.logFile).size;
  }
}

function loadRoutes() {
  state.cfg = loadConfig();
  state.routes = state.cfg.intercept.map((host) => ({
    host,
    upstreams: resolveUpstreams(state.cfg, state.cfg.routes[host]),
  }));
}

function health(name) {
  const st = state.stats.get(name);
  if (!st) return `${C.gy}-${C.r}`;
  return (
    `${C.g}${st.ok}${C.r}` + (st.fail ? `${C.gy}/${C.r}${C.red}${st.fail}${C.r}` : '') + (st.ms ? `${C.dim} ${st.ms}ms${C.r}` : '')
  );
}

// ------------------------------------------------------------------- actions

function doctor() {
  if (state.busy) return;
  state.busy = true;
  state.message = 'doctor 运行中 …（q 可直接退出）';
  render();
  const child = spawn(process.execPath, [path.join(ROOT, 'src/cli.js'), 'doctor'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.children.add(child);
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  child.on('error', (err) => {
    state.busy = false;
    state.message = `doctor 启动失败: ${err.message}`;
    render();
  });
  child.on('close', (status) => {
    state.children.delete(child);
    state.busy = false;
    state.lines.push(`${C.dim}──── doctor ────${C.r}`);
    for (const l of out.trim().split('\n')) state.lines.push(l.startsWith('ok') ? `${C.g}${l}${C.r}` : l.startsWith('FAIL') ? `${C.red}${l}${C.r}` : l);
    state.lines.push('');
    state.message = status === 0 ? 'doctor: 全部通过' : `doctor: 有失败项（exit ${status}）`;
    render();
  });
}

function toggleRouter() {
  if (state.loaded || state.pid) {
    agent.stop();
    state.message = '已暂停：Delta 现在没有网络出口（再按 s 恢复）';
  } else {
    const err = agent.start(state.cfg);
    state.message = err ? `启动失败: ${err}` : '已启动';
  }
}

let certAbort = null;

/**
 * macOS gates trust changes behind an authorization prompt, so this stays async: the panel keeps
 * taking keys (q aborts the pending prompt and exits) instead of freezing on `security`.
 */
async function toggleCertificate() {
  if (certAbort) return;
  const wasTrusted = caTrusted();
  const abort = new AbortController();
  certAbort = abort;
  state.message = `${wasTrusted ? '卸载' : '安装'}证书：等待系统授权 …（q 取消并退出）`;
  render();
  const pending = wasTrusted
    ? delta.untrustCa({ signal: abort.signal })
    : delta.trustCa({ signal: abort.signal });
  const result = await pending.catch((err) => `证书操作失败: ${err.message}`);
  certAbort = null;
  caTrusted(true);
  state.message = `${result}（重启 Delta 生效）`;
  render();
}

// ------------------------------------------------------------------ rendering

function header(width_) {
  const svc = state.pid
    ? `${C.g}running${C.r} pid ${state.pid}`
    : state.loaded
      ? `${C.y}starting…${C.r}`
      : `${C.red}paused${C.r}`;
  const proxy = delta.deltaSettingsProxy();
  const want = delta.proxyUrl(state.cfg);
  const proxyOk = (proxy ?? '').replace(/\/+$/, '') === want;
  const trusted = caTrusted();
  const keys = delta.placeholderKeysPresent();
  const todo = [
    !proxyOk && 'node src/cli.js install-delta',
    !keys && 'node src/cli.js write-keys',
    !trusted && 'node src/cli.js trust-ca',
  ].filter(Boolean);
  return [
    `  router   ${svc}   ${C.dim}${state.cfg.listen.host}:${state.cfg.listen.port}${C.r}`,
    `  delta    ${C.dim}proxy${C.r} ${proxyOk ? `${C.g}ok${C.r}` : `${C.red}未接入${C.r}`}` +
      `   ${C.dim}key${C.r} ${keys ? `${C.g}ok${C.r}` : `${C.red}缺失${C.r}`}` +
      `   ${C.dim}ca${C.r} ${trusted ? `${C.g}ok${C.r}` : `${C.red}未信任${C.r}`}`,
    todo.length ? `  ${C.y}待办: ${todo.join('  |  ')}（重启 Delta 生效）${C.r}` : '',
  ].map((l) => (l ? clipAnsi(l, width_) : ''));
}

const row = (head, tail, w) => clipAnsi(head + tail, w);

function routeRows(w) {
  const rows = [`${C.b} ROUTES${C.r} ${C.dim}（跟随 cc-switch 的 current provider）${C.r}`];
  for (const { host, upstreams } of state.routes) {
    const [active, ...rest] = upstreams;
    if (!active) {
      rows.push(row(`  ${clip(host, 20)} ${C.dim}→${C.r}`, `  ${C.red}cc-switch 里没有可用的 provider${C.r}`, w));
      continue;
    }
    rows.push(
      row(
        `  ${clip(host, 20)} ${C.dim}→${C.r} ${C.b}${active.name}${active.hint ? ` (${active.hint})` : ''}${C.r}`,
        `  ${C.dim}${active.base}${C.r}  ${health(active.name)}`,
        w,
      ),
    );
    for (const u of rest) {
      rows.push(row(`  ${' '.repeat(20)} ${C.gy}↳ ${u.name}${C.r}`, `  ${C.gy}${u.base}${C.r}`, w));
    }
  }
  return rows;
}

function footer(w) {
  const cert = caTrusted() ? '卸载证书' : '安装证书';
  const keys =
    `${C.b}s${C.r} 启动/暂停   ${C.b}d${C.r} doctor   ${C.b}c${C.r} ${cert}   ${C.b}q${C.r} 退出`;
  const msg = state.busy ? `${C.y}${state.message}${C.r}` : state.message;
  return [clipAnsi(keys, w), clipAnsi(msg, w)];
}

function frame() {
  const w = OUT.columns ?? 100;
  const h = OUT.rows ?? 30;
  loadRoutes();
  readNewLog();
  const head = header(w);
  const routes = routeRows(w);
  const foot = footer(w);
  const bodyH = Math.max(3, h - head.length - routes.length - foot.length - 3);
  const visible = state.lines.slice(-bodyH);
  const body = [...new Array(Math.max(0, bodyH - visible.length)).fill(''), ...visible].map((l) => clipAnsi(l, w));
  const sep = C.gy + '─'.repeat(w) + C.r;
  return [
    clipAnsi(`${C.b} delta-router${C.r} ${C.dim}· Delta → cc-switch${C.r}`, w),
    ...head,
    sep,
    ...routes,
    `${C.dim}ACTIVITY${C.r}`,
    ...body,
    sep,
    ...foot,
  ];
}

let lastFrame = [];
function render() {
  const lines = frame();
  if (lines.length === lastFrame.length && lines.every((l, i) => l === lastFrame[i])) return;
  lastFrame = lines;
  OUT.write('\x1b[H');
  for (const l of lines) OUT.write('\x1b[2K' + l + '\n');
}

// -------------------------------------------------------------------- input

const KEYS = {
  q: () => quit(),
  s: toggleRouter,
  d: doctor,
  c: toggleCertificate,
};

let quitting = false;

/** Quitting is unconditional and instant: no teardown, no certificate work, no waiting. */
function quit() {
  if (quitting) return;
  quitting = true;
  certAbort?.abort();
  for (const child of state.children) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/F', '/T'], { stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    } catch {}
  }
  OUT.write('\x1b[?25h\x1b[?1049l');
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
}

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('keypress', (str, key) => {
  // readline reports Ctrl-<letter> with the bare letter as `name`, so Ctrl-C used to fire the
  // certificate toggle (and its password prompt). Ctrl chords never trigger single-key actions.
  if (key?.ctrl) {
    if (key.name === 'c') quit();
    return;
  }
  const handler = KEYS[key?.name ?? str];
  if (handler) {
    handler();
    lastFrame = [];
    render();
  }
});

startSession();
OUT.write('\x1b[?1049h\x1b[?25l');
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, quit);
process.on('exit', () => OUT.write('\x1b[?25h\x1b[?1049l'));
OUT.on('resize', () => {
  lastFrame = [];
  render();
});
setInterval(() => {
  state.pid = agent.listenerPid(state.cfg.listen.port);
  state.loaded = agent.isLoaded();
  render();
}, 1000);
state.pid = agent.listenerPid(state.cfg.listen.port);
state.loaded = agent.isLoaded();
render();
