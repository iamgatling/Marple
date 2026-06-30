/**
 * Marple Browser SDK
 * Batched, non-blocking client-side event collection.
 * Loaded from /marple/client.js
 */
(function (window) {
  'use strict';

  const FLUSH_INTERVAL_MS = 10000;
  const MAX_QUEUE = 50;

  let _config = { endpoint: '/marple/collect', sessionId: null, userId: null };
  const eventQueue = [];
  let _timer = null;
  let _flushing = false;

  // Session ID
  function getOrCreateSession() {
    let sid = sessionStorage.getItem('_marple_sid');
    if (!sid) {
      sid = 'sid_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('_marple_sid', sid);
    }
    return sid;
  }

  // Flush
  function flush(useBeacon) {
    if (_flushing || !eventQueue.length) return;
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
  function track(eventType, properties) {
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
  function trackPageview() {
    track('pageview', { title: document.title });
  }

  // SPA history patching 
  function patchHistory() {
    if (history.__marple_patched__) return;
    history.__marple_patched__ = true;
    const wrap = (orig) => function (...args) {
      const result = orig.apply(this, args);
      trackPageview();
      return result;
    };
    history.pushState = wrap(history.pushState);
    window.addEventListener('popstate', trackPageview);
  }

  // Init 
  function init(options) {
    _config = { ..._config, ...options };
    _config.sessionId = _config.sessionId || getOrCreateSession();
    _config.userId = _config.userId || localStorage.getItem('_marple_uid') || null;

    // Auto page-view
    trackPageview();
    patchHistory();

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
  function identify(userId, traits) {
    _config.userId = userId;
    localStorage.setItem('_marple_uid', userId);
    track('identify', traits || {});
  }

  window.Marple = { init, track, identify };
})(window);
