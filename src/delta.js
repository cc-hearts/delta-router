import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { loadConfig } from './config.js';

export function getDeltaSettingsPath() {
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'delta',
      'settings.json',
    );
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/delta/settings.json');
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'delta',
    'settings.json',
  );
}

export const DELTA_SETTINGS = getDeltaSettingsPath();
export const DELTA_BACKUP = `${DELTA_SETTINGS}.bak-delta-router`;

export function deltaSettingsProxy() {
  if (!fs.existsSync(DELTA_SETTINGS)) return null;
  try {
    return JSON.parse(fs.readFileSync(DELTA_SETTINGS, 'utf8')).native?.proxy ?? null;
  } catch {
    return null;
  }
}

function patch(value) {
  fs.mkdirSync(path.dirname(DELTA_SETTINGS), { recursive: true });
  let j = {};
  if (fs.existsSync(DELTA_SETTINGS)) {
    try {
      j = JSON.parse(fs.readFileSync(DELTA_SETTINGS, 'utf8'));
    } catch {}
  }
  j.native ??= {};
  if (value === null) delete j.native.proxy;
  else j.native.proxy = value;
  fs.writeFileSync(DELTA_SETTINGS, JSON.stringify(j, null, 2) + '\n');
}

export function proxyUrl(cfg) {
  return `http://${cfg.listen.host}:${cfg.listen.port}`;
}

export function installProxy(cfg) {
  if (fs.existsSync(DELTA_SETTINGS) && !fs.existsSync(DELTA_BACKUP)) {
    fs.copyFileSync(DELTA_SETTINGS, DELTA_BACKUP);
  }
  patch(proxyUrl(cfg));
  return proxyUrl(cfg);
}

export function uninstallProxy() {
  if (fs.existsSync(DELTA_BACKUP)) fs.copyFileSync(DELTA_BACKUP, DELTA_SETTINGS);
  else patch(null);
}

/** Delta reads provider credentials from ~/.config/delta/.env at launch. */
export const DELTA_ENV = path.join(os.homedir(), '.config/delta/.env');

const PLACEHOLDER = 'delta-router';
/**
 * One placeholder per provider Delta needs a credential for — the router swaps in the real token
 * on the way out, so Delta never holds one. Delta only surfaces a provider's models once it has
 * some credential, which is why these have to exist even though the value is meaningless.
 */
const PLACEHOLDER_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENCODE_API_KEY',
  'OPENCODE_GO_API_KEY',
];

function getEnvFiles() {
  const files = [DELTA_ENV];
  if (process.platform === 'win32') {
    const roamingEnv = path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'delta',
      '.env',
    );
    if (!files.includes(roamingEnv)) files.push(roamingEnv);
  }
  return files;
}

export function placeholderKeysPresent() {
  for (const f of getEnvFiles()) {
    if (fs.existsSync(f)) {
      const text = fs.readFileSync(f, 'utf8');
      if (PLACEHOLDER_VARS.every((name) => new RegExp(`^\\s*${name}\\s*=\\s*\\S+`, 'm').test(text))) {
        return true;
      }
    }
  }
  return false;
}

export function writePlaceholderKeys() {
  for (const envFile of getEnvFiles()) {
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    // Keys the router does not own (a real OPENROUTER_API_KEY lives here) survive a rewrite.
    const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split('\n') : [];
    const foreign = existing.filter(
      (line) =>
        /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line) &&
        !PLACEHOLDER_VARS.some((name) => new RegExp(`^\\s*${name}\\s*=`).test(line)),
    );
    fs.writeFileSync(
      envFile,
      [
        '# 占位符：Delta 里一个真 key 都不需要，推理时由 delta-router 换成 cc-switch 的凭据。',
        '# Delta 是「有凭据才启用该 provider」，所以这些占位符就是它出现模型的前提。',
        '# 改完需要重启 Delta（凭据在启动时读取）。',
        ...PLACEHOLDER_VARS.map((name) => `${name}=${PLACEHOLDER}`),
        ...foreign,
        '',
      ].join('\n'),
    );
    try {
      fs.chmodSync(envFile, 0o600);
    } catch {}
  }
}

// ------------------------------------------------------------------ certificate

const SECURITY_TIMEOUT_MS = 3000;

export function caTrusted() {
  const cfg = loadConfig();
  if (process.platform === 'win32') {
    if (!fs.existsSync(cfg.tls.ca)) return false;
    try {
      const cert = new crypto.X509Certificate(fs.readFileSync(cfg.tls.ca, 'utf8'));
      const thumbprint = cert.fingerprint.replace(/:/g, '').toUpperCase();
      const res = spawnSync('certutil', ['-user', '-verifystore', 'Root', thumbprint], {
        stdio: 'ignore',
        timeout: SECURITY_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      return res.status === 0;
    } catch {
      return false;
    }
  }

  if (!fs.existsSync(cfg.tls.cert)) return false;
  const res = spawnSync('security', ['verify-cert', '-p', 'ssl', '-c', cfg.tls.cert], {
    stdio: 'ignore',
    timeout: SECURITY_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return res.status === 0;
}

/**
 * Async execution wrapper supporting AbortSignal
 */
function commandRun(cmd, args, { signal } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { signal });
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk) => (out += chunk));
    child.stderr?.on('data', (chunk) => (err += chunk));
    child.on('error', (e) =>
      resolve({ ok: false, detail: e.name === 'AbortError' ? '已取消' : e.message }),
    );
    child.on('close', (status) =>
      resolve({ ok: status === 0, detail: (err || out).trim() }),
    );
  });
}

export async function trustCa({ signal } = {}) {
  const cfg = loadConfig();
  if (!fs.existsSync(cfg.tls.ca)) return '未找到 CA 证书文件，请先运行: npm run setup-ca';

  if (process.platform === 'win32') {
    const res = await commandRun('certutil', ['-addstore', '-user', 'Root', cfg.tls.ca], { signal });
    return res.ok
      ? `已安装证书（${path.basename(cfg.tls.ca)} 导入至 CurrentUser\\Root）`
      : `安装失败: ${res.detail}`;
  }

  const keychain = path.join(os.homedir(), 'Library/Keychains/login.keychain-db');
  const res = await commandRun(
    'security',
    ['add-trusted-cert', '-r', 'trustRoot', '-p', 'ssl', '-k', keychain, cfg.tls.ca],
    { signal },
  );
  return res.ok
    ? `已安装证书（${path.basename(cfg.tls.ca)} 信任范围：SSL，仅本用户）`
    : `安装失败: ${res.detail}`;
}

export async function untrustCa({ signal } = {}) {
  const cfg = loadConfig();
  if (!fs.existsSync(cfg.tls.ca)) return '未找到 CA 证书文件';

  if (process.platform === 'win32') {
    try {
      const cert = new crypto.X509Certificate(fs.readFileSync(cfg.tls.ca, 'utf8'));
      const thumbprint = cert.fingerprint.replace(/:/g, '').toUpperCase();
      const res = await commandRun('certutil', ['-delstore', '-user', 'Root', thumbprint], { signal });
      return res.ok ? `已卸载证书（${thumbprint.slice(0, 12)}…）` : `卸载失败: ${res.detail}`;
    } catch (err) {
      return `卸载失败: ${err.message}`;
    }
  }

  const der = execFileSync('openssl', ['x509', '-outform', 'der'], { input: fs.readFileSync(cfg.tls.ca, 'utf8') });
  const sha = execFileSync('openssl', ['sha1', '-r'], { input: der }).toString().split(' ')[0].toUpperCase();
  const res = await commandRun('security', ['delete-certificate', '-Z', sha], { signal });
  return res.ok ? `已卸载证书（${sha.slice(0, 12)}…）` : `卸载失败: ${res.detail}`;
}
