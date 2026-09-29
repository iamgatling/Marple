import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { createDashboardMiddleware } from '../dist/dashboard.js';
import { createTestServer } from './helpers/server.js';
import { makeRequest } from './helpers/request.js';
import { LIMITS } from '../dist/validation.js';

describe('Public Event Ingestion Validation & Schema', () => {
  let serverHelper;
  let writtenEvents;

  const mockStorage = {
    writeEvent: async (ev) => { writtenEvents.push(ev); },
    config: {}
  };

  before(async () => {
    writtenEvents = [];
    const app = express();
    app.use(express.json());
    app.use(createDashboardMiddleware({
      authenticate: () => true,
      storage: mockStorage,
      config: {}
    }));
    serverHelper = await createTestServer(app);
  });

  after(async () => {
    if (serverHelper) await serverHelper.close();
  });

  test('rejects wrong field types with 400', async () => {
    writtenEvents.length = 0;
    const res1 = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      body: { event_type: 12345 }
    });
    assert.strictEqual(res1.status, 400);
    assert.strictEqual(res1.json().code, 'MISSING_EVENT_TYPE');

    const res2 = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      body: { event_type: 'click', session_id: { nested: 'object' } }
    });
    assert.strictEqual(res2.status, 400);
    assert.strictEqual(res2.json().code, 'INVALID_FIELD_TYPE');

    const res3 = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      body: { event_type: 'click', properties: 'not_an_object' }
    });
    assert.strictEqual(res3.status, 400);
    assert.strictEqual(res3.json().code, 'INVALID_PROPERTIES');
    assert.strictEqual(writtenEvents.length, 0);
  });

  test('rejects missing or empty event_type with 400', async () => {
    writtenEvents.length = 0;
    const res1 = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      body: { session_id: 'sid_1' }
    });
    assert.strictEqual(res1.status, 400);
    assert.strictEqual(res1.json().code, 'MISSING_EVENT_TYPE');

    const res2 = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      body: { event_type: '' }
    });
    assert.strictEqual(res2.status, 400);
    assert.strictEqual(res2.json().code, 'MISSING_EVENT_TYPE');

    const res3 = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      body: { event_type: '   ' }
    });
    assert.strictEqual(res3.status, 400);
    assert.strictEqual(res3.json().code, 'MISSING_EVENT_TYPE');
    assert.strictEqual(writtenEvents.length, 0);
  });

  test('rejects oversized strings with 400', async () => {
    writtenEvents.length = 0;
    const res1 = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      body: { event_type: 'a'.repeat(LIMITS.EVENT_TYPE_MAX + 1) }
    });
    assert.strictEqual(res1.status, 400);
    assert.strictEqual(res1.json().code, 'EVENT_TYPE_TOO_LONG');

    const res2 = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      body: { event_type: 'click', session_id: 's'.repeat(LIMITS.SESSION_ID_MAX + 1) }
    });
    assert.strictEqual(res2.status, 400);
    assert.strictEqual(res2.json().code, 'STRING_TOO_LONG');

    const res3 = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      body: { event_type: 'click', url: 'https://example.com/' + 'u'.repeat(LIMITS.URL_MAX) }
    });
    assert.strictEqual(res3.status, 400);
    assert.strictEqual(res3.json().code, 'STRING_TOO_LONG');

    const res4 = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      body: { event_type: 'click', properties: { ['k'.repeat(LIMITS.PROP_KEY_MAX + 1)]: 'val' } }
    });
    assert.strictEqual(res4.status, 400);
    assert.strictEqual(res4.json().code, 'PROP_KEY_TOO_LONG');

    const res5 = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      body: { event_type: 'click', properties: { key: 'v'.repeat(LIMITS.PROP_VAL_STRING_MAX + 1) } }
    });
    assert.strictEqual(res5.status, 400);
    assert.strictEqual(res5.json().code, 'PROP_VALUE_TOO_LONG');
    assert.strictEqual(writtenEvents.length, 0);
  });

  test('rejects deeply nested properties with 400', async () => {
    writtenEvents.length = 0;
    const deeplyNested = {
      l1: {
        l2: {
          l3: {
            l4: 'too_deep'
          }
        }
      }
    };
    const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      body: { event_type: 'nest_test', properties: deeplyNested }
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json().code, 'PROP_DEPTH_EXCEEDED');
    assert.strictEqual(writtenEvents.length, 0);
  });

  test('rejects excessive property key count with 400', async () => {
    writtenEvents.length = 0;
    const manyProps = {};
    for (let i = 0; i <= LIMITS.PROP_KEYS_MAX; i++) {
      manyProps[`prop_${i}`] = i;
    }
    const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      body: { event_type: 'many_keys', properties: manyProps }
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json().code, 'PROP_KEY_COUNT_EXCEEDED');
    assert.strictEqual(writtenEvents.length, 0);
  });

  test('rejects invalid arrays and objects with 400', async () => {
    writtenEvents.length = 0;
    const largeProps = {};
    for (let i = 0; i < 20; i++) {
      largeProps[`k_${i}`] = 'x'.repeat(900);
    }
    const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      body: { event_type: 'size_test', properties: largeProps }
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json().code, 'PROP_SIZE_EXCEEDED');
    assert.strictEqual(writtenEvents.length, 0);
  });

  test('ignores client-supplied IP, user agent, and timestamp', async () => {
    writtenEvents.length = 0;
    const clientTimestamp = '2000-01-01T00:00:00.000Z';
    const clientIp = '198.51.100.99';
    const clientUa = 'SpoofedBrowser/1.0';
    const actualBrowserUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      headers: {
        'User-Agent': actualBrowserUa
      },
      body: {
        event_type: 'security_test',
        ip: clientIp,
        ua: clientUa,
        timestamp: clientTimestamp
      }
    });

    assert.strictEqual(res.status, 204);
    assert.strictEqual(writtenEvents.length, 1);
    const stored = writtenEvents[0];
    assert.notStrictEqual(stored.timestamp, clientTimestamp);
    assert.notStrictEqual(stored.ip, clientIp);
    assert.strictEqual(stored.ua, actualBrowserUa);
    assert(Math.abs(Date.now() - new Date(stored.timestamp).getTime()) < 5000);
  });

  test('accepts valid anonymous browser event', async () => {
    writtenEvents.length = 0;
    const payload = {
      event_type: 'pageview',
      session_id: 'sid_anon_123',
      user_id: 'usr_anon_456',
      url: 'https://example.com/pricing',
      referrer: 'https://google.com/',
      country: 'US',
      properties: {
        theme: 'dark',
        path: '/pricing',
        step: 1
      },
      utm_source: 'newsletter',
      utm_medium: 'email'
    };

    const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      body: payload
    });

    assert.strictEqual(res.status, 204);
    assert.strictEqual(writtenEvents.length, 1);
    const stored = writtenEvents[0];
    assert.strictEqual(stored.event_type, 'pageview');
    assert.strictEqual(stored.session_id, 'sid_anon_123');
    assert.strictEqual(stored.user_id, 'usr_anon_456');
    assert.strictEqual(stored.url, 'https://example.com/pricing');
    assert.strictEqual(stored.referrer, 'https://google.com/');
    assert.strictEqual(stored.country, 'US');
    assert.strictEqual(stored.utm_source, 'newsletter');
    assert.deepStrictEqual(stored.properties, { theme: 'dark', path: '/pricing', step: 1 });
  });

  test('rejects entire batch when any entry is invalid', async () => {
    writtenEvents.length = 0;
    const batch = [
      { event_type: 'valid_1' },
      { event_type: '' }, // invalid item
      { event_type: 'valid_2' }
    ];

    const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      body: batch
    });

    assert.strictEqual(res.status, 400);
    const parsed = res.json();
    assert(parsed.error.includes('Batch item [1] invalid'));
    assert.strictEqual(parsed.code, 'MISSING_EVENT_TYPE');
    assert.strictEqual(writtenEvents.length, 0);
  });
});
