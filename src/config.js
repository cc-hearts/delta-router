import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function loadConfig(file = path.join(ROOT, 'config.json')) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.file = file;
  cfg.ccswitch.db = expandHome(cfg.ccswitch.db);
  cfg.tls.ca = path.resolve(ROOT, expandHome(cfg.tls.ca));
  cfg.tls.cert = path.resolve(ROOT, expandHome(cfg.tls.cert));
  cfg.tls.key = path.resolve(ROOT, expandHome(cfg.tls.key));
  cfg.logFile = path.resolve(ROOT, expandHome(cfg.logFile));
  return cfg;
}
