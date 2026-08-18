import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import http from 'http';
import { existsSync } from 'fs';
import { openStorage } from '../dist/storage.js';
import { createDashboardMiddleware } from '../dist/dashboard.js';
import { marple } from '../dist/index.js';

describe('Marple Core & Middleware Test Suite', () => {
  let storage;
  let middleware;
  let server;
  let baseUrl;

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

  const makeReq = (urlPath, options = {}) => {
    return new Promise((resolve, reject) => {
      const { method = 'GET', body = null, headers = {} } = options;
      const postData = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

      const reqHeaders = { ...headers };
      if (postData && !reqHeaders['Content-Type']) {
        reqHeaders['Content-Type'] = 'application/json';
      }
      if (postData) {
        reqHeaders['Content-Length'] = Buffer.byteLength(postData);
      }

      const reqOptions = {
        method,
        headers: reqHeaders,
        timeout: 3000
      };

      const req = http.request(`${baseUrl}${urlPath}`, reqOptions, (res) => {
        let resBody = '';
        res.on('data', chunk => { resBody += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: resBody }));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request to ${urlPath} timed out`));
      });

      req.on('error', reject);
      if (postData) req.write(postData);
      req.end();
    });
  };

  describe('Global Body Parser Compatibility (express.json)', () => {
    let app, mockStore;

    before(async () => {
      mockStore = mockStorage();
      const mw = createDashboardMiddleware({
        authenticate: () => true,
        storage: mockStore,
        config: {}
      });

      app = express();
      app.use(express.json()); // Body parser
      app.use(mw);

      await new Promise(resolve => {
        server = app.listen(0, () => {
          const port = server.address().port;
          baseUrl = `http://localhost:${port}`;
          resolve();
        });
      });
    });

    after(() => {
      if (server) server.close();
    });

    test('/collect handles single event with express.json active', async () => {
      const res = await makeReq('/collect', {
        method: 'POST',
        body: { event_type: 'pageview', url: 'http://localhost/' }
      });
      assert.strictEqual(res.status, 204);
      assert.strictEqual(mockStore.events.length, 1);
      assert.strictEqual(mockStore.events[0].event_type, 'pageview');
    });

    test('/collect handles batch events with express.json active', async () => {
      mockStore.events.length = 0;
      const res = await makeReq('/collect', {
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
      const res = await makeReq('/api/funnel', {
        method: 'POST',
        body: { steps: [{ name: 'signup' }] }
      });
      assert.strictEqual(res.status, 200);
      const parsed = JSON.parse(res.body);
      assert.strictEqual(parsed.conversionRate, 0.75);
    });

    test('batch size > 50 returns 400 Bad Request', async () => {
      const hugeBatch = Array.from({ length: 51 }, (_, i) => ({ event_type: `ev_${i}` }));
      const res = await makeReq('/collect', {
        method: 'POST',
        body: hugeBatch
      });
      assert.strictEqual(res.status, 400);
    });
  });

  describe('Raw Stream Processing (No Upstream Body Parser)', () => {
    let app, mockStore;

    before(async () => {
      mockStore = mockStorage();
      const mw = createDashboardMiddleware({
        authenticate: () => true,
        storage: mockStore,
        config: {}
      });

      app = express();
      app.use(mw);

      await new Promise(resolve => {
        server = app.listen(0, () => {
          const port = server.address().port;
          baseUrl = `http://localhost:${port}`;
          resolve();
        });
      });
    });

    after(() => {
      if (server) server.close();
    });

    test('/collect handles raw stream event', async () => {
      const res = await makeReq('/collect', {
        method: 'POST',
        body: { event_type: 'raw_event' }
      });
      assert.strictEqual(res.status, 204);
      assert.strictEqual(mockStore.events.length, 1);
      assert.strictEqual(mockStore.events[0].event_type, 'raw_event');
    });

    test('/api/funnel handles raw stream POST', async () => {
      const res = await makeReq('/api/funnel', {
        method: 'POST',
        body: { steps: [{ name: 'step1' }] }
      });
      assert.strictEqual(res.status, 200);
    });
  });

  describe('Authentication & Dashboard Endpoints', () => {
    let app, mockStore;

    before(async () => {
      mockStore = mockStorage();
      const mw = createDashboardMiddleware({
        authenticate: (req) => req.headers['x-auth'] === 'secret',
        storage: mockStore,
        config: {}
      });

      app = express();
      app.use(mw);

      await new Promise(resolve => {
        server = app.listen(0, () => {
          const port = server.address().port;
          baseUrl = `http://localhost:${port}`;
          resolve();
        });
      });
    });

    after(() => {
      if (server) server.close();
    });

    test('/client.js is accessible without authentication', async () => {
      const res = await makeReq('/client.js');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['content-type'], 'application/javascript');
    });

    test('/collect is accessible without authentication', async () => {
      const res = await makeReq('/collect', {
        method: 'POST',
        body: { event_type: 'pub_event' }
      });
      assert.strictEqual(res.status, 204);
    });

    test('/api/overview returns 401 without auth header', async () => {
      const res = await makeReq('/api/overview');
      assert.strictEqual(res.status, 401);
    });

    test('/api/overview returns 200 with valid auth header', async () => {
      const res = await makeReq('/api/overview', {
        headers: { 'x-auth': 'secret' }
      });
      assert.strictEqual(res.status, 200);
      const parsed = JSON.parse(res.body);
      assert.strictEqual(typeof parsed.totalEvents, 'number');
    });
  });

  describe('Full Package Integration (Matching test-marple-user)', () => {
    let app, serverInstance, customBaseUrl;
    const testDbPath = './test-marple-suite.sqlite';

    before(async () => {
      await marple.init({
        storage: 'sqlite',
        sqlitePath: testDbPath,
        retention: { keepRawEventsDays: 1, keepRollupsDays: 1, autoRollup: false }
      });

      app = express();
      app.use(express.json());
      app.use('/marple', marple.dashboard({ authenticate: () => true }));

      await new Promise(resolve => {
        serverInstance = app.listen(0, () => {
          const port = serverInstance.address().port;
          customBaseUrl = `http://localhost:${port}`;
          resolve();
        });
      });
    });

    after(async () => {
      if (serverInstance) serverInstance.close();
      try {
        const { unlinkSync } = await import('fs');
        if (existsSync(testDbPath)) unlinkSync(testDbPath);
        if (existsSync(testDbPath + '-wal')) unlinkSync(testDbPath + '-wal');
        if (existsSync(testDbPath + '-shm')) unlinkSync(testDbPath + '-shm');
      } catch {}
    });

    const localReq = (urlPath, options = {}) => {
      return new Promise((resolve, reject) => {
        const { method = 'GET', body = null } = options;
        const postData = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

        const reqHeaders = {};
        if (postData) {
          reqHeaders['Content-Type'] = 'application/json';
          reqHeaders['Content-Length'] = Buffer.byteLength(postData);
        }

        const reqOptions = {
          method,
          headers: reqHeaders,
          timeout: 3000
        };

        const req = http.request(`${customBaseUrl}${urlPath}`, reqOptions, (res) => {
          let resBody = '';
          res.on('data', chunk => { resBody += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: resBody }));
        });

        req.on('timeout', () => {
          req.destroy();
          reject(new Error(`Request to ${urlPath} timed out`));
        });

        req.on('error', reject);
        if (postData) req.write(postData);
        req.end();
      });
    };

    test('Test A: GET /marple/client.js returned 200 with SDK code', async () => {
      const res = await localReq('/marple/client.js');
      assert.strictEqual(res.status, 200);
      assert(res.body.includes('Marple'), 'SDK content missing');
    });

    test('Test B: POST /marple/collect returned 204 with express.json() active', async () => {
      const res = await localReq('/marple/collect', {
        method: 'POST',
        body: { event_type: 'pkg_test_event', url: 'http://localhost/test' }
      });
      assert.strictEqual(res.status, 204);
    });

    test('Test C: POST /marple/collect batch returned 204', async () => {
      const res = await localReq('/marple/collect', {
        method: 'POST',
        body: [
          { event_type: 'batch_event_1' },
          { event_type: 'batch_event_2' }
        ]
      });
      assert.strictEqual(res.status, 204);
    });

    test('Test D: POST /marple/api/funnel returned 200 with express.json() active', async () => {
      const res = await localReq('/marple/api/funnel', {
        method: 'POST',
        body: { steps: [] }
      });
      assert.strictEqual(res.status, 200);
    });

    test('Test E: GET /marple/api/overview returned 200 (totalEvents >= 3)', async () => {
      const res = await localReq('/marple/api/overview');
      assert.strictEqual(res.status, 200);
      const overview = JSON.parse(res.body);
      assert(overview.totalEvents >= 3, `Expected at least 3 events in overview, got ${overview.totalEvents}`);
    });
  });
});

