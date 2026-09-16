import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadConfig } from './config.js';

export const DELTA_SETTINGS = path.join(
  os.homedir(),
  'Library/Application Support/delta/settings.json',
);
export const DELTA_BACKUP = `${DELTA_SETTINGS}.bak-delta-router`;

export function deltaSettingsProxy() {
  if (!fs.existsSync(DELTA_SETTINGS)) return null;
  return JSON.parse(fs.readFileSync(DELTA_SETTINGS, 'utf8')).native?.proxy ?? null;
}

function patch(value) {
  const j = JSON.parse(fs.readFileSync(DELTA_SETTINGS, 'utf8'));
  j.native ??= {};
  if (value === null) delete j.native.proxy;
  else j.native.proxy = value;
  fs.writeFileSync(DELTA_SETTINGS, JSON.stringify(j, null, 2) + '\n');
}

export function proxyUrl(cfg) {
  return `http://${cfg.listen.host}:${cfg.listen.port}`;
}

export function installProxy(cfg) {
  if (!fs.existsSync(DELTA_BACKUP)) fs.copyFileSync(DELTA_SETTINGS, DELTA_BACKUP);
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

export function placeholderKeysPresent() {
  if (!fs.existsSync(DELTA_ENV)) return false;
  const text = fs.readFileSync(DELTA_ENV, 'utf8');
  return (
    new RegExp(`^\\s*ANTHROPIC_API_KEY\\s*=\\s*\\S+`, 'm').test(text) &&
    new RegExp(`^\\s*OPENAI_API_KEY\\s*=\\s*\\S+`, 'm').test(text)
  );
}

export function writePlaceholderKeys() {
  fs.mkdirSync(path.dirname(DELTA_ENV), { recursive: true });
  fs.writeFileSync(
    DELTA_ENV,
    [
      '# 占位符：真实 token 由 delta-router 注入，不会写进 Delta。',
      '# 改完需要重启 Delta（凭据在启动时读取）。',
      `ANTHROPIC_API_KEY=${PLACEHOLDER}`,
      `OPENAI_API_KEY=${PLACEHOLDER}`,
      '',
    ].join('\n'),
  );
  fs.chmodSync(DELTA_ENV, 0o600);
}

// ------------------------------------------------------------------ certificate

export function caTrusted() {
  const cfg = loadConfig();
  if (!fs.existsSync(cfg.tls.cert)) return false;
  return (
    spawnSync('security', ['verify-cert', '-p', 'ssl', '-c', cfg.tls.cert], { stdio: 'ignore' })
      .status === 0
  );
}

export function trustCa() {
  const cfg = loadConfig();
  const keychain = path.join(os.homedir(), 'Library/Keychains/login.keychain-db');
  const res = spawnSync(
    'security',
    ['add-trusted-cert', '-r', 'trustRoot', '-p', 'ssl', '-k', keychain, cfg.tls.ca],
    { encoding: 'utf8' },
  );
  return res.status === 0
    ? `已安装证书（${path.basename(cfg.tls.ca)} 信任范围：SSL，仅本用户）`
    : `安装失败: ${(res.stderr || res.stdout).trim()}`;
}

export function untrustCa() {
  const cfg = loadConfig();
  const der = execFileSync('openssl', ['x509', '-outform', 'der'], { input: fs.readFileSync(cfg.tls.ca, 'utf8') });
  const sha = execFileSync('openssl', ['sha1', '-r'], { input: der }).toString().split(' ')[0].toUpperCase();
  const res = spawnSync('security', ['delete-certificate', '-Z', sha], { encoding: 'utf8' });
  return res.status === 0 ? `已卸载证书（${sha.slice(0, 12)}…）` : `卸载失败: ${(res.stderr || res.stdout).trim()}`;
}
