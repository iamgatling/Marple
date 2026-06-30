import { openStorage } from './storage.js';
import { createDashboardMiddleware } from './dashboard.js';

let _storage = null;
let _config = null;

export async function init(options = {}) {
  const defaults = {
    storage: 'sqlite',
    sqlitePath: './marple.sqlite',
    retention: { keepRawEventsDays: 30, keepRollupsDays: 365, autoRollup: true }
  };
  _config = { ...defaults, ...options, retention: { ...defaults.retention, ...(options.retention || {}) } };

  if (typeof _config.storage === 'object' && typeof _config.storage.writeEvent === 'function') {
    _storage = _config.storage;
  } else {
    _storage = await openStorage(_config);
  }

  return { config: _config, storage: _storage };
}

export function dashboard(options = {}) {
  if (!options.authenticate) {
    throw new Error('[Marple] dashboard() requires a mandatory authenticate(req) option.');
  }
  if (!_storage) {
    throw new Error('[Marple] Call marple.init() before marple.dashboard().');
  }
  return createDashboardMiddleware({ authenticate: options.authenticate, storage: _storage, config: _config });
}

export async function track(eventName, properties = {}, context = {}) {
  if (typeof eventName !== 'string' || !eventName.trim()) {
    throw new Error('[Marple] track() requires a valid string eventName.');
  }
  if (!_storage) throw new Error('[Marple] Call marple.init() first.');
  return _storage.writeEvent({
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
  });
}

export const marple = { init, dashboard, track };
export default marple;
