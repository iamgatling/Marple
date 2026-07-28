import { openStorage } from './storage.js';
import { createDashboardMiddleware } from './dashboard.js';
import { Driver, MarpleConfig, TrackEvent } from './types.js';

export * from './types.js';

let _storage: Driver | null = null;
let _config: MarpleConfig | null = null;

export async function init(options: MarpleConfig = {}): Promise<{ config: MarpleConfig; storage: Driver }> {
  const defaults: MarpleConfig = {
    storage: 'sqlite',
    sqlitePath: './marple.sqlite',
    retention: { keepRawEventsDays: 30, keepRollupsDays: 365, autoRollup: true }
  };
  _config = {
    ...defaults,
    ...options,
    retention: { ...defaults.retention, ...(options.retention || {}) }
  };

  if (typeof _config.storage === 'object' && typeof (_config.storage as any).writeEvent === 'function') {
    _storage = _config.storage as Driver;
  } else {
    _storage = await openStorage(_config);
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

export const marple = { init, dashboard, track };
export default marple;
