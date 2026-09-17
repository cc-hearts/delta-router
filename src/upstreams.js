import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Upstreams come from cc-switch's own database, so switching provider there re-routes Delta
 * without touching this project.
 *
 * A route names one cc-switch app type, and its upstream is the provider cc-switch currently
 * has selected for that app:
 *
 *   claude   -> Anthropic Messages       (env.ANTHROPIC_BASE_URL)
 *   codex    -> OpenAI Responses         (config.toml base_url + auth.OPENAI_API_KEY)
 *   opencode -> OpenAI Chat Completions  (options.baseURL, @ai-sdk/openai-compatible)
 */
const APP_TYPES = {
  claude: (cfg) => {
    const env = cfg.env ?? {};
    return {
      base: env.ANTHROPIC_BASE_URL,
      key: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY,
      hint: env.ANTHROPIC_MODEL ?? cfg.model ?? '',
    };
  },
  codex: (cfg) => {
    const text = cfg.config ?? '';
    return {
      base: /base_url\s*=\s*"([^"]+)"/.exec(text)?.[1],
      key: cfg.auth?.OPENAI_API_KEY,
      hint: /^model\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? '',
    };
  },
  opencode: (cfg) => ({
    base: cfg.options?.baseURL,
    key: cfg.options?.apiKey,
    hint: Object.keys(cfg.models ?? {})[0] ?? '',
  }),
};

export function readCcSwitchProviders(dbFile) {
  if (!fs.existsSync(dbFile)) return [];
  let rows;
  try {
    const out = execFileSync(
      'sqlite3',
      ['-json', dbFile, 'SELECT id, app_type, name, is_current, settings_config FROM providers'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    rows = JSON.parse(out || '[]');
  } catch {
    return [];
  }

  const providers = [];
  for (const row of rows) {
    const read = APP_TYPES[row.app_type];
    if (!read) continue;
    let cfg;
    try {
      cfg = JSON.parse(row.settings_config);
    } catch {
      continue;
    }
    const parsed = read(cfg);
    const base = parsed.base?.replace(/\/+$/, '');
    if (!base) continue;
    providers.push({
      id: row.id,
      appType: row.app_type,
      name: row.name,
      hint: parsed.hint ?? '',
      current: !!row.is_current,
      base,
      key: parsed.key ?? '',
    });
  }
  return providers;
}

let cache = new Map();

/**
 * The route's upstream, and only that one: the provider cc-switch has selected for the app.
 * A single provider counts as selected (there is nothing to choose between); with several and
 * none current there is no upstream, and the request fails instead of guessing.
 */
export function resolveUpstreams(cfg, route) {
  const appType = route.ccswitchAppType;
  const ttl = cfg.ccswitch.cacheMs ?? 15000;
  const hit = cache.get(appType);
  if (hit && Date.now() - hit.at < ttl) return hit.list;

  const ofType = readCcSwitchProviders(cfg.ccswitch.db).filter((p) => p.appType === appType);
  const selected = ofType.find((p) => p.current) ?? (ofType.length === 1 ? ofType[0] : null);
  const list = selected ? [selected] : [];
  cache.set(appType, { at: Date.now(), list });
  return list;
}

export function invalidateUpstreamCache() {
  cache = new Map();
}
