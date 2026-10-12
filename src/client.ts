/**
 * Marple Browser SDK
 * Batched, non-blocking client-side event collection.
 * Loaded from /marple/client.js
 */
interface TrackEvent {
  event_type: string;
  session_id?: string | null;
  user_id?: string | null;
  url?: string | null;
  referrer?: string | null;
  properties?: Record<string, unknown>;
  ip?: string | null;
  ua?: string | null;
  country?: string | null;
  timestamp?: string;
  [key: string]: unknown;
}

(function (window: Window | typeof globalThis) {
  'use strict';

  const FLUSH_INTERVAL_MS = 10000;
  const MAX_QUEUE = 50;
  const DOWNLOAD_EXT_REGEX = /\.(pdf|zip|csv|gz|tar|tgz|rar|7z|doc|docx|xls|xlsx|ppt|pptx|txt|mp3|mp4|avi|mov|dmg|iso|exe|apk|deb|rpm)($|\?|#)/i;

  interface ClientConfig {
    endpoint: string;
    sessionId: string | null;
    userId: string | null;
  }

  let _config: ClientConfig = { endpoint: '/marple/collect', sessionId: null, userId: null };
  const eventQueue: TrackEvent[] = [];
  let _timer: ReturnType<typeof setInterval> | null = null;
  let _flushing = false;

  function isDNTEnabled(): boolean {
    const win = typeof window !== 'undefined' ? window : null;
    const nav = (win ? win.navigator : null) || (typeof navigator !== 'undefined' ? navigator : null);
    if (nav) {
      const navRec = nav as unknown as Record<string, unknown>;
      const winRec = win as unknown as Record<string, unknown> | null;
      const dnt = nav.doNotTrack || (winRec ? winRec.doNotTrack : null) || navRec.msDoNotTrack;
      if (dnt === '1' || dnt === 'yes' || dnt === 1 || dnt === true) {
        return true;
      }
      if (navRec.globalPrivacyControl === true || navRec.globalPrivacyControl === '1' || navRec.globalPrivacyControl === 1) {
        return true;
      }
    }
    return false;
  }

  function getOrCreateSession(): string {
    let sid = sessionStorage.getItem('_marple_sid');
    if (!sid) {
      sid = 'sid_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('_marple_sid', sid);
    }
    return sid;
  }

  const MAX_STR_LEN = 4096;
  const MAX_URL_LEN = 8192;
  const MAX_KEY_LEN = 64;
  const MAX_PROP_DEPTH = 5;

  function truncateStr(str: string, maxLen: number): string;
  function truncateStr(str: unknown, maxLen: number): string | null;
  function truncateStr(str: unknown, maxLen: number): string | null {
    if (typeof str !== 'string') return null;
    return str.length > maxLen ? str.slice(0, maxLen) : str;
  }

  function sanitizeProps(obj: unknown, depth = 0): Record<string, unknown> {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth >= MAX_PROP_DEPTH) {
      return {};
    }
    const result: Record<string, unknown> = {};
    for (const [rawKey, v] of Object.entries(obj)) {
      const k = rawKey.length > MAX_KEY_LEN ? rawKey.slice(0, MAX_KEY_LEN) : rawKey;
      if (typeof v === 'string') {
        result[k] = v.length > MAX_STR_LEN ? v.slice(0, MAX_STR_LEN) : v;
      } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
        result[k] = v;
      } else if (Array.isArray(v)) {
        if (depth + 1 < MAX_PROP_DEPTH) {
          result[k] = v.slice(0, 50).map(item => {
            if (typeof item === 'string') return item.length > MAX_STR_LEN ? item.slice(0, MAX_STR_LEN) : item;
            if (item && typeof item === 'object') return sanitizeProps(item, depth + 1);
            return item;
          });
        }
      } else if (typeof v === 'object') {
        if (depth + 1 < MAX_PROP_DEPTH) {
          result[k] = sanitizeProps(v, depth + 1);
        }
      }
    }
    return result;
  }

  function flush(useBeacon?: boolean): void {
    if (isDNTEnabled() || _flushing || !eventQueue.length) return;
    _flushing = true;
    const events = eventQueue.splice(0);
    const body = JSON.stringify(events);
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(_config.endpoint, new Blob([body], { type: 'application/json' }));
    } else {
      fetch(_config.endpoint, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true })
        .then((res) => {
          if (!res.ok && typeof console !== 'undefined' && console.warn) {
            console.warn(`[Marple] Failed to send events (${res.status})`);
          }
        })
        .catch((err) => {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[Marple] Network error sending events', err);
          }
        });
    }
    setTimeout(() => { _flushing = false; }, 200);
  }

  function track(eventType: string, properties?: Record<string, unknown>): void {
    if (isDNTEnabled()) return;
    const url = typeof window !== 'undefined' && window.location ? truncateStr(window.location.href, MAX_URL_LEN) : null;
    const referrer = typeof document !== 'undefined' ? truncateStr(document.referrer, MAX_URL_LEN) : null;
    eventQueue.push({
      event_type: eventType.slice(0, 128),
      session_id: _config.sessionId,
      user_id: _config.userId,
      url,
      referrer,
      properties: sanitizeProps(properties),
      timestamp: new Date().toISOString()
    });
    if (eventQueue.length >= MAX_QUEUE) flush(false);
  }

  function trackPageview(): void {
    const title = typeof document !== 'undefined' && document.title
      ? truncateStr(document.title, MAX_STR_LEN)
      : '';
    track('pageview', { title });
  }

  function patchHistory(): void {
    const hist = history as unknown as Record<string, unknown>;
    if (hist.__marple_patched__) return;
    hist.__marple_patched__ = true;
    const origPushState = history.pushState;
    history.pushState = function (this: History, ...args: Parameters<typeof origPushState>) {
      const result = origPushState.apply(this, args);
      trackPageview();
      return result;
    };
    window.addEventListener('popstate', trackPageview);
  }

  function findAnchor(element: HTMLElement | null): HTMLAnchorElement | null {
    let curr: HTMLElement | null = element;
    while (curr) {
      if (curr.tagName && curr.tagName.toLowerCase() === 'a') {
        return curr as HTMLAnchorElement;
      }
      curr = curr.parentElement;
    }
    return null;
  }

  function setupAutotracking(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const win = window as unknown as Record<string, unknown>;
    if (win.__marple_autotrack_setup__) return;
    win.__marple_autotrack_setup__ = true;

    document.addEventListener('click', (event: MouseEvent) => {
      try {
        let target = event.target as HTMLElement | null;
        if (!target) return;
        while (target && target.nodeType === 3) {
          target = target.parentElement;
        }
        const anchor = target ? (target.closest ? (target.closest('a') as HTMLAnchorElement | null) : findAnchor(target)) : null;
        if (!anchor || !anchor.href) return;

        const href = anchor.href;
        if (href.indexOf('javascript:') === 0) return;

        const isDownload = anchor.hasAttribute('download') || DOWNLOAD_EXT_REGEX.test(href);

        let isExternal = false;
        if (anchor.hostname && window.location && window.location.hostname) {
          isExternal = anchor.hostname !== window.location.hostname;
        }

        if (isDownload) {
          const cleanUrl = href.split('?')[0].split('#')[0];
          const extMatch = cleanUrl.match(/\.([a-z0-9]+)$/i);
          const extension = extMatch ? extMatch[1].toLowerCase() : undefined;
          track('download', {
            url: truncateStr(href, MAX_STR_LEN),
            href: truncateStr(href, MAX_STR_LEN),
            extension: extension,
            target: anchor.target || undefined
          });
        }

        if (isExternal) {
          track('outbound_click', {
            url: truncateStr(href, MAX_STR_LEN),
            href: truncateStr(href, MAX_STR_LEN),
            target: anchor.target || undefined
          });
        }
      } catch (e) {
      }
    }, true);
  }

  function init(options?: Partial<ClientConfig>): void {
    _config = { ..._config, ...options };
    _config.sessionId = _config.sessionId || getOrCreateSession();
    _config.userId = _config.userId || localStorage.getItem('_marple_uid') || null;

    trackPageview();
    patchHistory();
    setupAutotracking();

    _timer = setInterval(() => flush(false), FLUSH_INTERVAL_MS);

    window.addEventListener('pagehide', () => flush(true));
    window.addEventListener('beforeunload', () => flush(true));
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush(true);
    });
  }

  function identify(userId: string, traits?: Record<string, unknown>): void {
    _config.userId = userId;
    try {
      localStorage.setItem('_marple_uid', userId);
    } catch {}
    track('identify', traits || {});
  }

  (window as unknown as Record<string, unknown>).Marple = { init, track, identify };
})(typeof window !== 'undefined' ? window : globalThis);

