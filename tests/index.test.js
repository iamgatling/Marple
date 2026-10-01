import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { createDashboardMiddleware } from '../dist/dashboard.js';
import { marple } from '../dist/index.js';
import { createTestServer } from './helpers/server.js';
import { makeRequest } from './helpers/request.js';
import { createTempDbPath, cleanupDb } from './helpers/db.js';

// Import companion test suites so node --test tests/index.test.js runs everything
import './contracts.test.js';
import './collect-body.test.js';
import './validation.test.js';
import './proxy.test.js';
import './retention.test.js';
import './funnel.test.js';
import './config.test.js';
import './package-cjs.test.js';
import './regressions.test.js';

describe('Marple Core & Middleware Test Suite', () => {
  const mockStorage = () => {
    const events = [];
    return {
      writeEvent: async (ev) => { events.push(ev); },
      getOverview: async () => ({ activeNow: 1, totalEvents: events.length, uniqueSessions: 1, uniqueUsers: 1 }),
      getUsers: async () => [{ user_id: 'user_1', eventCount: 1 }],
      getEvents: async () => ({ events, trend: [] }),
      getFunnel: async (steps) => ({ steps: steps || [], conversionRate: 0.75 }),
      getCohorts: async () => [],
      getConversions: async () => null,
      getPublicConfig: async () => ({ storage: 'memory' }),
      events
    };
  };

  describe('Global Body Parser Compatibility (express.json)', () => {
    let mockStore;
    let serverHelper;

    before(async () => {
      mockStore = mockStorage();
      const mw = createDashboardMiddleware({
        authenticate: () => true,
        storage: mockStore,
        config: {}
      });

      const app = express();
      app.use(express.json()); // Body parser
      app.use(mw);

      serverHelper = await createTestServer(app);
    });

    after(async () => {
      if (serverHelper) await serverHelper.close();
    });

    test('/collect handles single event with express.json active', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
        method: 'POST',
        body: { event_type: 'pageview', url: 'http://localhost/' }
      });
      assert.strictEqual(res.status, 204);
      assert.strictEqual(mockStore.events.length, 1);
      assert.strictEqual(mockStore.events[0].event_type, 'pageview');
    });

    test('/collect handles batch events with express.json active', async () => {
      mockStore.events.length = 0;
      const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
        method: 'POST',
        body: [
          { event_type: 'click_1' },
          { event_type: 'click_2' }
        ]
      });
      assert.strictEqual(res.status, 204);
      assert.strictEqual(mockStore.events.length, 2);
    });

    test('/api/funnel handles POST with express.json active', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/api/funnel`, {
        method: 'POST',
        body: { steps: [{ name: 'signup' }] }
      });
      assert.strictEqual(res.status, 200);
      const parsed = res.json();
      assert.strictEqual(parsed.conversionRate, 0.75);
    });

    test('batch size > 50 returns 400 Bad Request', async () => {
      const hugeBatch = Array.from({ length: 51 }, (_, i) => ({ event_type: `ev_${i}` }));
      const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
        method: 'POST',
        body: hugeBatch
      });
      assert.strictEqual(res.status, 400);
    });
  });

  describe('Raw Stream Processing (No Upstream Body Parser)', () => {
    let mockStore;
    let serverHelper;

    before(async () => {
      mockStore = mockStorage();
      const mw = createDashboardMiddleware({
        authenticate: () => true,
        storage: mockStore,
        config: {}
      });

      const app = express();
      app.use(mw);

      serverHelper = await createTestServer(app);
    });

    after(async () => {
      if (serverHelper) await serverHelper.close();
    });

    test('/collect handles raw stream event', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
        method: 'POST',
        body: { event_type: 'raw_event' }
      });
      assert.strictEqual(res.status, 204);
      assert.strictEqual(mockStore.events.length, 1);
      assert.strictEqual(mockStore.events[0].event_type, 'raw_event');
    });

    test('/api/funnel handles raw stream POST', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/api/funnel`, {
        method: 'POST',
        body: { steps: [{ name: 'step1' }] }
      });
      assert.strictEqual(res.status, 200);
    });
  });

  describe('Authentication & Dashboard Endpoints', () => {
    let mockStore;
    let serverHelper;

    before(async () => {
      mockStore = mockStorage();
      const mw = createDashboardMiddleware({
        authenticate: (req) => req.headers['x-auth'] === 'secret',
        storage: mockStore,
        config: {}
      });

      const app = express();
      app.use(mw);

      serverHelper = await createTestServer(app);
    });

    after(async () => {
      if (serverHelper) await serverHelper.close();
    });

    test('/client.js is accessible without authentication', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/client.js`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['content-type'], 'application/javascript');
    });

    test('/collect is accessible without authentication', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
        method: 'POST',
        body: { event_type: 'pub_event' }
      });
      assert.strictEqual(res.status, 204);
    });

    test('/api/overview returns 401 without auth header', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/api/overview`);
      assert.strictEqual(res.status, 401);
    });

    test('/api/overview returns 200 with valid auth header', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/api/overview`, {
        headers: { 'x-auth': 'secret' }
      });
      assert.strictEqual(res.status, 200);
      const parsed = res.json();
      assert.strictEqual(typeof parsed.totalEvents, 'number');
    });
  });

  describe('Full Package Integration (Matching test-marple-user)', () => {
    let serverHelper;
    let testDbPath;

    before(async () => {
      testDbPath = createTempDbPath('pkg-integration');
      await marple.init({
        storage: 'sqlite',
        sqlitePath: testDbPath,
        retention: { keepRawEventsDays: 1, keepRollupsDays: 1, autoRollup: false }
      });

      const app = express();
      app.use(express.json());
      app.use('/marple', marple.dashboard({ authenticate: () => true }));

      serverHelper = await createTestServer(app);
    });

    after(async () => {
      if (serverHelper) await serverHelper.close();
      cleanupDb(testDbPath);
    });

    test('Test A: GET /marple/client.js returned 200 with SDK code', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/marple/client.js`);
      assert.strictEqual(res.status, 200);
      assert(res.body.includes('Marple'), 'SDK content missing');
    });

    test('Test B: POST /marple/collect returned 204 with express.json() active', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/marple/collect`, {
        method: 'POST',
        body: { event_type: 'pkg_test_event', url: 'http://localhost/test' }
      });
      assert.strictEqual(res.status, 204);
    });

    test('Test C: POST /marple/collect batch returned 204', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/marple/collect`, {
        method: 'POST',
        body: [
          { event_type: 'batch_event_1' },
          { event_type: 'batch_event_2' }
        ]
      });
      assert.strictEqual(res.status, 204);
    });

    test('Test D: POST /marple/api/funnel returned 200 with express.json() active', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/marple/api/funnel`, {
        method: 'POST',
        body: { steps: [] }
      });
      assert.strictEqual(res.status, 200);
    });

    test('Test E: GET /marple/api/overview returned 200 (totalEvents >= 3)', async () => {
      const res = await makeRequest(`${serverHelper.baseUrl}/marple/api/overview`);
      assert.strictEqual(res.status, 200);
      const overview = res.json();
      assert(overview.totalEvents >= 3, `Expected at least 3 events in overview, got ${overview.totalEvents}`);
    });
  });
});
