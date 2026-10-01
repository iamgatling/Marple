import path from 'path';
import { existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { openStorage } from './storage.js';
import { createDashboardMiddleware } from './dashboard.js';
import { Driver, MarpleConfig, TrackEvent, RollupConfig } from './types.js';

export * from './types.js';

let _storage: Driver | null = null;
let _config: MarpleConfig | null = null;

function validateRetentionConfig(retention?: RollupConfig): void {
  if (!retention) return;
  const { keepRawEventsDays, keepRollupsDays } = retention;
  if (keepRawEventsDays !== undefined) {
    if (typeof keepRawEventsDays !== 'number' || !Number.isFinite(keepRawEventsDays) || keepRawEventsDays < 0) {
      throw new Error('[Marple] Invalid retention.keepRawEventsDays: must be a non-negative number.');
    }
  }
  if (keepRollupsDays !== undefined) {
    if (typeof keepRollupsDays !== 'number' || !Number.isFinite(keepRollupsDays) || keepRollupsDays < 0) {
      throw new Error('[Marple] Invalid retention.keepRollupsDays: must be a non-negative number.');
    }
  }
}

function validateConfig(config: MarpleConfig): void {
  if (config.storage !== undefined) {
    if (typeof config.storage !== 'string' && typeof config.storage !== 'object') {
      throw new Error('[Marple] Invalid storage configuration: must be "sqlite", "postgres", or a custom Driver object.');
    }
    if (typeof config.storage === 'string' && config.storage !== 'sqlite' && config.storage !== 'postgres') {
      throw new Error(`[Marple] Unsupported storage type: "${config.storage}". Must be "sqlite" or "postgres".`);
    }
  }
  if (config.sqlitePath !== undefined && typeof config.sqlitePath !== 'string') {
    throw new Error('[Marple] Invalid sqlitePath: must be a string file path.');
  }
  validateRetentionConfig(config.retention);
}

export async function loadConfig(cwd: string = process.cwd()): Promise<MarpleConfig | null> {
  const candidates = ['marple.config.js', 'marple.config.mjs', 'marple.config.cjs'];
  for (const name of candidates) {
    const fullPath = path.resolve(cwd, name);
    if (existsSync(fullPath)) {
      try {
        const fileUrl = pathToFileURL(fullPath).href;
        const mod = await import(fileUrl);
        return (mod.default || mod) as MarpleConfig;
      } catch (err: any) {
        throw new Error(`[Marple] Failed to load configuration from ${fullPath}: ${err.message}`);
      }
    }
  }
  return null;
}

export async function init(options: MarpleConfig = {}): Promise<{ config: MarpleConfig; storage: Driver }> {
  validateConfig(options);

  let fileConfig: MarpleConfig | null = null;
  try {
    fileConfig = await loadConfig();
  } catch (err) {
    throw err;
  }

  const defaults: MarpleConfig = {
    storage: 'sqlite',
    sqlitePath: './marple.sqlite',
    retention: { keepRawEventsDays: 30, keepRollupsDays: 365, autoRollup: true }
  };
  _config = {
    ...defaults,
    ...(fileConfig || {}),
    ...options,
    retention: {
      ...defaults.retention,
      ...(fileConfig?.retention || {}),
      ...(options.retention || {})
    }
  };

  validateConfig(_config);

  if (typeof _config.storage === 'object' && typeof (_config.storage as any).writeEvent === 'function') {
    _storage = _config.storage as Driver;
  } else {
    _storage = await openStorage(_config);
  }

  if (_config.retention?.autoRollup !== false && typeof _storage.runRollup === 'function') {
    try {
      await _storage.runRollup(_config.retention);
    } catch (err) {
      console.error('[Marple] Startup retention rollup error:', err);
    }
  }

  return { config: _config, storage: _storage };
}

export function dashboard(options: { authenticate: (req: any) => boolean | Promise<boolean> } = {} as any): any {
  if (!options || !options.authenticate) {
    throw new Error('[Marple] dashboard() requires a mandatory authenticate(req) option.');
  }
  if (!_storage || !_config) {
    throw new Error('[Marple] Call marple.init() before marple.dashboard().');
  }
  return createDashboardMiddleware({ authenticate: options.authenticate, storage: _storage, config: _config });
}

export async function track(eventName: string, properties: Record<string, any> = {}, context: any = {}): Promise<void> {
  if (typeof eventName !== 'string' || !eventName.trim()) {
    throw new Error('[Marple] track() requires a valid string eventName.');
  }
  if (!_storage) throw new Error('[Marple] Call marple.init() first.');
  const eventPayload: TrackEvent = {
    event_type: eventName,
    session_id: context.sessionId || null,
    user_id: context.userId || null,
    url: context.url || null,
    referrer: context.referrer || null,
    properties,
    ip: context.ip || null,
    ua: context.ua || null,
    country: context.country || null,
    timestamp: new Date().toISOString()
  };
  return _storage.writeEvent(eventPayload);
}

export const marple = { init, dashboard, track, loadConfig };
export default marple;
