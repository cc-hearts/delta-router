import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { resolveUpstreams, invalidateUpstreamCache } from './upstreams.js';

let cfg = loadConfig();
fs.mkdirSync(path.dirname(cfg.logFile), { recursive: true });

let cfgMtime = fs.statSync(cfg.file).mtimeMs;

/** The TUI rewrites config.json (eg. preferred upstream); pick that up without a restart. */
function reloadIfChanged() {
  let mtime;
  try {
    mtime = fs.statSync(cfg.file).mtimeMs;
  } catch {
    return;
  }
  if (mtime === cfgMtime) return;
  cfgMtime = mtime;
  try {
    cfg = loadConfig();
    invalidateUpstreamCache();
    log(`config reloaded (${cfg.file})`);
  } catch (err) {
    log(`config reload failed: ${err.message}`);
  }
}

const logStream = fs.createWriteStream(cfg.logFile, { flags: 'a' });
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  logStream.write(line + '\n');
  process.stdout.write(line + '\n');
}

const tlsOptions = {
  key: fs.readFileSync(cfg.tls.key),
  cert: fs.readFileSync(cfg.tls.cert),
  ALPNProtocols: ['http/1.1'],
};

const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });
const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'proxy-authorization',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
]);

// ---------------------------------------------------------------- interception

/** Inner server that serves the decrypted requests of intercepted hosts. */
const mitmServer = http.createServer((req, res) => {
  const host = req.socket.routerHost;
  handleRouted(req, res, host).catch((err) => {
    log(`ERROR ${host} ${req.method} ${req.url}: ${err.stack ?? err}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err) } }));
  });
});

const proxy = http.createServer((req, res) => {
  log(`PLAIN ${req.method} ${req.url} (only CONNECT is proxied)`);
  res.writeHead(502, { 'content-type': 'text/plain' });
  res.end('delta-router: only CONNECT is supported\n');
});

proxy.on('connect', (req, clientSocket, head) => {
  reloadIfChanged();
  const [host, portRaw] = splitHostPort(req.url);
  const port = Number(portRaw) || 443;

  if (!cfg.intercept.includes(host)) {
    return blindTunnel(clientSocket, head, host, port);
  }

  log(`MITM ${host}:${port}`);
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  const tlsSocket = new tls.TLSSocket(clientSocket, { isServer: true, ...tlsOptions });
  tlsSocket.routerHost = host;
  tlsSocket.on('error', (err) => log(`TLS ${host}: ${err.message}`));
  if (head?.length) tlsSocket.unshift(head);
  mitmServer.emit('connection', tlsSocket);
});

function splitHostPort(authority) {
  const idx = authority.lastIndexOf(':');
  return idx === -1 ? [authority, 443] : [authority.slice(0, idx), authority.slice(idx + 1)];
}

function blindTunnel(clientSocket, head, host, port) {
  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', (err) => {
    log(`TUNNEL ${host}:${port} failed: ${err.message}`);
    clientSocket.destroy();
  });
  clientSocket.on('error', () => upstream.destroy());
}

// ------------------------------------------------------------------- routing

/** Joins an upstream base with the incoming path, without duplicating /v1. */
function joinUrl(base, reqPath) {
  const b = base.replace(/\/+$/, '');
  const p = reqPath.startsWith('/') ? reqPath : `/${reqPath}`;
  if (b.endsWith('/v1') && p.startsWith('/v1/')) return b + p.slice(3);
  return b + p;
}

function upstreamHeaders(req, upstream, route) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k) && k !== 'host' && k !== 'content-length') headers[k] = v;
  }
  delete headers['content-encoding'];
  headers['user-agent'] = 'delta-router/0.1';

  const style = route.authStyle ?? 'both';
  delete headers.authorization;
  delete headers['x-api-key'];
  if (upstream.key) {
    if (style === 'x-api-key' || style === 'both') headers['x-api-key'] = upstream.key;
    if (style === 'bearer' || style === 'both') headers.authorization = `Bearer ${upstream.key}`;
  }
  return headers;
}

/** WebSocket upgrades (OpenAI's Responses transport can try wss://) are proxied verbatim. */
mitmServer.on('upgrade', (req, socket, head) => {
  reloadIfChanged();
  const host = socket.routerHost;
  const route = cfg.routes[host];
  const upstream = route ? resolveUpstreams(cfg, route)[0] : null;
  if (!upstream) {
    socket.destroy();
    return;
  }
  const target = new URL(joinUrl(upstream.base, req.url));
  const headers = upstreamHeaders(req, upstream, route);
  headers.host = target.host;

  const up = tls.connect({ host: target.hostname, port: target.port || 443, servername: target.hostname });
  let buffered = Buffer.alloc(0);
  let pending = head?.length ? head : Buffer.alloc(0);
  let upgraded = false;

  up.on('secureConnect', () => {
    up.write(
      `${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n` +
        Object.entries(headers)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`)
          .join('') +
        '\r\n',
    );
    if (pending.length) up.write(pending);
    pending = Buffer.alloc(0);
  });

  up.on('data', (chunk) => {
    if (upgraded) return;
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf('\r\n\r\n');
    if (end === -1) return;
    const responseHead = buffered.subarray(0, end + 4).toString('latin1');
    const status = Number(responseHead.split(' ')[1]);
    log(`WS ${host}${req.url} -> ${upstream.name} ${status}`);
    socket.write(buffered);
    buffered = Buffer.alloc(0);
    upgraded = true;
    if (status === 101) {
      up.pipe(socket);
      socket.pipe(up);
    } else {
      socket.end();
      up.end();
    }
  });

  up.on('error', (err) => {
    log(`WS ${host}${req.url} -> ${upstream.name} failed: ${err.message}`);
    socket.destroy();
  });
  socket.on('error', () => up.destroy());
});

async function handleRouted(req, res, host) {
  const route = cfg.routes[host];
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: `no route for ${host}` }));
  }

  const raw = await readBody(req);
  const { body, model } = prepareBody(route, req, raw);
  const upstreams = resolveUpstreams(cfg, route);

  if (upstreams.length === 0) {
    log(`ROUTE ${host}${req.url}: no upstream configured`);
    res.writeHead(502, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'delta-router: no upstream provider configured' },
      }),
    );
  }

  const retryStatuses = new Set(route.retryStatuses ?? []);
  let lastFailure = 'no attempt made';

  for (let i = 0; i < upstreams.length; i++) {
    const upstream = upstreams[i];
    const last = i === upstreams.length - 1;
    let target;
    try {
      target = new URL(joinUrl(upstream.base, req.url));
    } catch (err) {
      lastFailure = `${upstream.name}: bad base url ${upstream.base}`;
      continue;
    }

    const headers = upstreamHeaders(req, upstream, route);
    if (body.length) headers['content-length'] = String(body.length);
    const started = Date.now();

    try {
      const outcome = await attempt({ req, res, target, upstream, headers, body, retryStatuses, last, route, started });
      if (outcome === 'retry') {
        lastFailure = `${upstream.name}: retryable response`;
        invalidateUpstreamCache();
        continue;
      }
      log(
        `ROUTE ${req.method} ${host}${req.url} model=${model ?? '-'} -> ${upstream.name} ` +
          `${outcome.status} ${Date.now() - started}ms${outcome.note ? ` (${outcome.note})` : ''}`,
      );
      return;
    } catch (err) {
      lastFailure = `${upstream.name}: ${err.message}`;
      log(`FAIL ${host}${req.url} -> ${upstream.name}: ${err.message}`);
      invalidateUpstreamCache();
    }
  }

  if (!res.headersSent) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: `delta-router: all upstreams failed (${lastFailure})` },
      }),
    );
  }
}

function attempt({ req, res, target, upstream, headers, body, retryStatuses, last, route, started }) {
  return new Promise((resolve, reject) => {
    const upReq = https.request(
      {
        protocol: 'https:',
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: req.method,
        headers,
        agent,
        timeout: cfg.upstreamTimeoutMs,
      },
      (upRes) => {
        const status = upRes.statusCode ?? 502;

        if (retryStatuses.has(status) && !last) {
          log(`RETRY ${target.hostname}${target.pathname} -> ${upstream.name} ${status} (next upstream)`);
          upRes.resume();
          return resolve('retry');
        }

        // Some relays do not implement count_tokens; Delta uses it for the context meter.
        if (route.protocol === 'anthropic' && req.url.endsWith('/count_tokens') && status >= 400) {
          upRes.resume();
          const estimate = Math.ceil(body.length / 4);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ input_tokens: estimate }));
          return resolve({ status: 200, note: 'count_tokens estimated' });
        }

        // /v1/models fallback so an empty picker is not the only outcome.
        if (req.method === 'GET' && req.url.replace(/\?.*$/, '') === '/v1/models' && status >= 400) {
          upRes.resume();
          const fallback = route.modelFallback ?? [];
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: fallback.map((id) => ({ id, type: 'model' })) }));
          return resolve({ status: 200, note: 'models fallback' });
        }

        const outHeaders = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (!HOP_BY_HOP.has(k)) outHeaders[k] = v;
        }
        res.writeHead(status, outHeaders);
        upRes.pipe(res);
        upRes.on('error', (err) => { log(`STREAM ${target.host} broke: ${err.message}`); res.destroy(); });
        res.on('close', () => { if (!upRes.complete) upRes.destroy(); });
        resolve({ status });
      },
    );

    upReq.on('timeout', () => upReq.destroy(new Error(`upstream timeout after ${Date.now() - started}ms`)));
    upReq.on('error', reject);
    if (body.length) upReq.write(body);
    upReq.end();
  });
}

// ------------------------------------------------------------------ transform

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Applies modelMap / stripFields. Returns { body, model }. */
function prepareBody(route, req, raw) {
  const isJson = (req.headers['content-type'] ?? '').includes('json');
  const hasTransforms =
    Object.keys(route.modelMap ?? {}).length > 0 || (route.stripFields ?? []).length > 0;
  if (!isJson || !raw.length || !hasTransforms || req.headers['content-encoding']) {
    return { body: raw, model: bodyModel(raw, isJson) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { body: raw, model: undefined };
  }
  const model = parsed.model;
  if (model && route.modelMap?.[model]) parsed.model = route.modelMap[model];
  for (const field of route.stripFields ?? []) delete parsed[field];
  return { body: Buffer.from(JSON.stringify(parsed), 'utf8'), model };
}

function bodyModel(raw, isJson) {
  if (!isJson || !raw.length) return undefined;
  try {
    return JSON.parse(raw.toString('utf8')).model;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------- boot

if (!fs.existsSync(cfg.tls.cert) || !fs.existsSync(cfg.tls.key)) {
  console.error('missing TLS material — run: npm run setup-ca');
  process.exit(1);
}

proxy.listen(cfg.listen.port, cfg.listen.host, () => {
  log(
    `delta-router listening on ${cfg.listen.host}:${cfg.listen.port} ` +
      `intercept=[${cfg.intercept.join(', ')}]`,
  );
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`shutting down (${sig})`);
    proxy.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}
