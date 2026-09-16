import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Upstreams come from cc-switch's own database, so switching provider in cc-switch
 * re-routes Delta without touching this project.
 *
 *   app_type=claude  -> Anthropic Messages protocol (what Delta's Anthropic provider speaks)
 *   app_type=codex   -> OpenAI protocol (config.toml base_url + auth.json key)
 */

export function readCcSwitchProviders(dbFile) {
  if (!fs.existsSync(dbFile)) return [];
  let rows;
  try {
    const out = execFileSync(
      'sqlite3',
      ['-json', dbFile, 'SELECT id, app_type, name, is_current, settings_config, meta FROM providers'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    rows = JSON.parse(out || '[]');
  } catch {
    return [];
  }

  const providers = [];
  for (const row of rows) {
    let cfg;
    try {
      cfg = JSON.parse(row.settings_config);
    } catch {
      continue;
    }
    if (row.app_type === 'claude') {
      const env = cfg.env ?? {};
      if (!env.ANTHROPIC_BASE_URL) continue;
      providers.push({
        id: row.id,
        origin: 'cc-switch:claude',
        name: row.name,
        hint: env.ANTHROPIC_MODEL ?? '',
        current: !!row.is_current,
        protocol: 'anthropic',
        base: env.ANTHROPIC_BASE_URL.replace(/\/+$/, ''),
        key: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '',
      });
    } else if (row.app_type === 'codex') {
      const text = cfg.config ?? '';
      const base = /base_url\s*=\s*"([^"]+)"/.exec(text)?.[1];
      const key = cfg.auth?.OPENAI_API_KEY;
      if (!base || !key) continue;
      providers.push({
        id: row.id,
        origin: 'cc-switch:codex',
        name: row.name,
        hint: /^model\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? '',
        current: !!row.is_current,
        protocol: 'openai',
        base: base.replace(/\/+$/, ''),
        key,
      });
    }
  }
  return providers;
}

let cache = new Map();

/** Order mirrors cc-switch: its current provider first, the rest kept for failover. */
export function resolveUpstreams(cfg, route) {
  const ttl = cfg.ccswitch.cacheMs ?? 15000;
  const cacheKey = route.ccswitchAppType ?? '';
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < ttl) return hit.list;

  const fromCc = readCcSwitchProviders(cfg.ccswitch.db).filter(
    (p) => p.protocol === route.protocol,
  );
  fromCc.sort((a, b) => Number(b.current) - Number(a.current));

  const statics = (route.static ?? []).map((u) => ({
    origin: 'config',
    name: u.name,
    protocol: route.protocol,
    base: u.base.replace(/\/+$/, ''),
    key: u.key ?? '',
  }));

  const list = route.staticFirst ? [...statics, ...fromCc] : [...fromCc, ...statics];
  cache.set(cacheKey, { at: Date.now(), list });
  return list;
}

export function invalidateUpstreamCache() {
  cache = new Map();
}
