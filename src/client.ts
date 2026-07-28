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
  properties?: Record<string, any>;
  ip?: string | null;
  ua?: string | null;
  country?: string | null;
  timestamp?: string;
  [key: string]: any;
}

(function (window: any) {
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
  let _timer: any = null;
  let _flushing = false;

  // DNT and GPC Privacy Check
  function isDNTEnabled(): boolean {
    const win = (typeof window !== 'undefined' ? window : {}) as any;
    const nav = win.navigator || (typeof navigator !== 'undefined' ? navigator : null);
    if (nav) {
      const dnt = nav.doNotTrack || win.doNotTrack || nav.msDoNotTrack;
      if (dnt === '1' || dnt === 'yes' || dnt === 1 || dnt === true) {
        return true;
      }
      if (nav.globalPrivacyControl === true || nav.globalPrivacyControl === '1' || nav.globalPrivacyControl === 1) {
        return true;
      }
    }
    return false;
  }

  // Session ID
  function getOrCreateSession(): string {
    let sid = sessionStorage.getItem('_marple_sid');
    if (!sid) {
      sid = 'sid_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('_marple_sid', sid);
    }
    return sid;
  }

  // Flush
  function flush(useBeacon?: boolean): void {
    if (isDNTEnabled() || _flushing || !eventQueue.length) return;
    _flushing = true;
    const events = eventQueue.splice(0);
    const body = JSON.stringify(events);
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(_config.endpoint, new Blob([body], { type: 'application/json' }));
    } else {
      fetch(_config.endpoint, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true })
        .catch(() => {});
    }
    setTimeout(() => { _flushing = false; }, 200);
  }

  // Track
  function track(eventType: string, properties?: Record<string, any>): void {
    if (isDNTEnabled()) return;
    eventQueue.push({
      event_type: eventType,
      session_id: _config.sessionId,
      user_id: _config.userId,
      url: window.location.href,
      referrer: document.referrer || null,
      properties: properties || {},
      timestamp: new Date().toISOString()
    });
    if (eventQueue.length >= MAX_QUEUE) flush(false);
  }

  // Auto page-view tracking
  function trackPageview(): void {
    track('pageview', { title: document.title });
  }

  // SPA history patching 
  function patchHistory(): void {
    if ((history as any).__marple_patched__) return;
    (history as any).__marple_patched__ = true;
    const wrap = (orig: any) => function (this: any, ...args: any[]) {
      const result = orig.apply(this, args);
      trackPageview();
      return result;
    };
    history.pushState = wrap(history.pushState);
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

  // Auto-tracking link clicks & file downloads
  function setupAutotracking(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if ((window as any).__marple_autotrack_setup__) return;
    (window as any).__marple_autotrack_setup__ = true;

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

        // Check if file download
        const isDownload = anchor.hasAttribute('download') || DOWNLOAD_EXT_REGEX.test(href);

        // Check if external link
        let isExternal = false;
        if (anchor.hostname && window.location && window.location.hostname) {
          isExternal = anchor.hostname !== window.location.hostname;
        }

        if (isDownload) {
          const cleanUrl = href.split('?')[0].split('#')[0];
          const extMatch = cleanUrl.match(/\.([a-z0-9]+)$/i);
          const extension = extMatch ? extMatch[1].toLowerCase() : undefined;
          track('download', {
            url: href,
            href: href,
            extension: extension,
            target: anchor.target || undefined
          });
        }

        if (isExternal) {
          track('outbound_click', {
            url: href,
            href: href,
            target: anchor.target || undefined
          });
        }
      } catch (e) {
        // Prevent breaking host app handlers
      }
    }, true);
  }

  // Init 
  function init(options?: Partial<ClientConfig>): void {
    _config = { ..._config, ...options };
    _config.sessionId = _config.sessionId || getOrCreateSession();
    _config.userId = _config.userId || localStorage.getItem('_marple_uid') || null;

    // Auto page-view & autotracking
    trackPageview();
    patchHistory();
    setupAutotracking();

    // Interval flush
    _timer = setInterval(() => flush(false), FLUSH_INTERVAL_MS);

    // Flush on tab close
    window.addEventListener('pagehide', () => flush(true));
    window.addEventListener('beforeunload', () => flush(true));
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush(true);
    });
  }

  // Identify
  function identify(userId: string, traits?: Record<string, any>): void {
    _config.userId = userId;
    localStorage.setItem('_marple_uid', userId);
    track('identify', traits || {});
  }

  window.Marple = { init, track, identify };
})(typeof window !== 'undefined' ? window : globalThis);

