import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import express from 'express';
import { createDashboardMiddleware } from '../dist/dashboard.js';
import { createTestServer } from './helpers/server.js';
import { makeRequest, sendChunkedRequest } from './helpers/request.js';

describe('/collect Body Handling Safety & Boundaries', () => {
  let serverHelper;
  let serverWithJsonHelper;
  let writtenEvents;
  let writtenEventsWithJson;

  const mockStorage = (eventsRef) => ({
    writeEvent: async (ev) => { eventsRef.push(ev); },
    config: {}
  });

  function buildExactJsonPayload(targetByteLength) {
    const prefix = '{"event_type":"exact_event","padding":"';
    const suffix = '"}';
    const neededPadding = targetByteLength - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    if (neededPadding < 0) throw new Error('Target byte length too small');
    return prefix + 'a'.repeat(neededPadding) + suffix;
  }

  before(async () => {
    // Server 1: Raw stream (no body parser)
    writtenEvents = [];
    const appRaw = express();
    appRaw.use(createDashboardMiddleware({
      authenticate: () => true,
      storage: mockStorage(writtenEvents),
      config: {}
    }));
    serverHelper = await createTestServer(appRaw);

    // Server 2: With express.json()
    writtenEventsWithJson = [];
    const appJson = express();
    appJson.use(express.json({ limit: '200kb' }));
    appJson.use(createDashboardMiddleware({
      authenticate: () => true,
      storage: mockStorage(writtenEventsWithJson),
      config: {}
    }));
    serverWithJsonHelper = await createTestServer(appJson);
  });

  after(async () => {
    if (serverHelper) await serverHelper.close();
    if (serverWithJsonHelper) await serverWithJsonHelper.close();
  });

  test('1. One oversized chunk returns 413 Payload Too Large', async () => {
    writtenEvents.length = 0;
    const oversizedChunk = Buffer.alloc(70 * 1024, 'x');

    const res = await sendChunkedRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      chunks: [oversizedChunk]
    });

    assert.strictEqual(res.status, 413);
    assert(res.body.includes('Payload Too Large'));
    assert.strictEqual(writtenEvents.length, 0);
  });

  test('2. Two oversized chunks return 413 Payload Too Large', async () => {
    writtenEvents.length = 0;
    const chunk1 = Buffer.alloc(40 * 1024, 'a');
    const chunk2 = Buffer.alloc(40 * 1024, 'b');

    const res = await sendChunkedRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      chunks: [chunk1, chunk2],
      delayMs: 10
    });

    assert.strictEqual(res.status, 413);
    assert(res.body.includes('Payload Too Large'));
    assert.strictEqual(writtenEvents.length, 0);
  });

  test('3. Many small chunks crossing the limit return 413', async () => {
    writtenEvents.length = 0;
    // 70 chunks of 1024 bytes each (total 70KB > 64KB)
    const chunks = Array.from({ length: 70 }, (_, i) => Buffer.alloc(1024, String.fromCharCode(65 + (i % 26))));

    const res = await sendChunkedRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      chunks,
      delayMs: 2
    });

    assert.strictEqual(res.status, 413);
    assert(res.body.includes('Payload Too Large'));
    assert.strictEqual(writtenEvents.length, 0);
  });

  test('4. Chunked transfer encoding without Content-Length returns 413 when oversized', async () => {
    writtenEvents.length = 0;
    const chunk1 = Buffer.alloc(35 * 1024, 'm');
    const chunk2 = Buffer.alloc(35 * 1024, 'n');

    const res = await sendChunkedRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked'
      },
      chunks: [chunk1, chunk2]
    });

    assert.strictEqual(res.status, 413);
    assert(res.body.includes('Payload Too Large'));
    assert.strictEqual(writtenEvents.length, 0);
  });

  test('5. Client disconnect during upload does not crash process and handles cleanly', async () => {
    await new Promise((resolve, reject) => {
      const parsedUrl = new URL(`${serverHelper.baseUrl}/collect`);
      const req = http.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked'
        }
      });

      req.on('error', () => {
        // Expected client-side error when destroying request socket
      });

      // Write partial chunk and abruptly destroy
      req.write('{"event_type": "aborted_test", "data": "');
      setTimeout(() => {
        req.destroy();
        // Allow event loop to process abort/close on server
        setTimeout(resolve, 50);
      }, 20);
    });

    // Verify server remains healthy and responds to subsequent requests
    const healthRes = await makeRequest(`${serverHelper.baseUrl}/client.js`);
    assert.strictEqual(healthRes.status, 200);
  });

  test('6. Malformed JSON returns 400 Bad Request safely', async () => {
    writtenEvents.length = 0;
    const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"event_type": "broken_syntax", invalid_json:'
    });

    assert.strictEqual(res.status, 400);
    const parsed = res.json();
    assert(parsed.error);
    assert.strictEqual(writtenEvents.length, 0);
  });

  test('7. Body already consumed by express.json() is rejected with 413 if oversized', async () => {
    writtenEventsWithJson.length = 0;
    const largePayload = {
      event_type: 'oversized_with_express_json',
      properties: { data: 'z'.repeat(70 * 1024) }
    };

    const res = await makeRequest(`${serverWithJsonHelper.baseUrl}/collect`, {
      method: 'POST',
      body: largePayload
    });

    assert.strictEqual(res.status, 413);
    assert(res.body.includes('Payload Too Large'));
    assert.strictEqual(writtenEventsWithJson.length, 0);
  });

  test('8. Payload exactly at the limit (64KB) succeeds with 204', async () => {
    writtenEvents.length = 0;
    const exactPayload = buildExactJsonPayload(64 * 1024);
    assert.strictEqual(Buffer.byteLength(exactPayload), 64 * 1024);

    const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: exactPayload
    });

    assert.strictEqual(res.status, 204);
    assert.strictEqual(writtenEvents.length, 1);
    assert.strictEqual(writtenEvents[0].event_type, 'exact_event');
  });

  test('9. Payload one byte over the limit (64KB + 1 byte) returns 413', async () => {
    writtenEvents.length = 0;
    const overPayload = buildExactJsonPayload(64 * 1024 + 1);
    assert.strictEqual(Buffer.byteLength(overPayload), 64 * 1024 + 1);

    const res = await makeRequest(`${serverHelper.baseUrl}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: overPayload
    });

    assert.strictEqual(res.status, 413);
    assert(res.body.includes('Payload Too Large'));
    assert.strictEqual(writtenEvents.length, 0);
  });

  test('10. Concurrent oversized requests are all rejected with 413 safely', async () => {
    writtenEvents.length = 0;
    const oversizedBody = Buffer.alloc(70 * 1024, 'q');

    const promises = Array.from({ length: 10 }, () =>
      sendChunkedRequest(`${serverHelper.baseUrl}/collect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        chunks: [oversizedBody]
      })
    );

    const results = await Promise.all(promises);
    for (const res of results) {
      assert.strictEqual(res.status, 413);
      assert(res.body.includes('Payload Too Large'));
    }
    assert.strictEqual(writtenEvents.length, 0);
  });

  test('11. Separate child process server does not crash on oversized multi-chunk requests', async () => {
    const childScript = `
      import express from 'express';
      import { createDashboardMiddleware } from './dist/dashboard.js';

      const app = express();
      const mockStorage = {
        writeEvent: async () => {},
        config: {}
      };
      app.use(createDashboardMiddleware({
        authenticate: () => true,
        storage: mockStorage,
        config: {}
      }));
      const server = app.listen(0, '127.0.0.1', () => {
        console.log('PORT:' + server.address().port);
      });
    `;

    const child = spawn('node', ['--input-type=module', '-e', childScript], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let childExited = false;
    let stderrBuf = '';
    child.stderr.on('data', (d) => {
      stderrBuf += d.toString();
    });
    child.on('exit', () => {
      childExited = true;
    });

    const port = await new Promise((resolve, reject) => {
      let buf = '';
      const onData = (d) => {
        buf += d.toString();
        const match = buf.match(/PORT:(\d+)/);
        if (match) {
          cleanup();
          resolve(parseInt(match[1], 10));
        }
      };
      const onExit = (code) => {
        cleanup();
        reject(new Error(`Child exited early with code ${code}: ${stderrBuf}`));
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Child process server timeout'));
      }, 5000);

      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.removeListener('data', onData);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
      };

      child.stdout.on('data', onData);
      child.on('exit', onExit);
      child.on('error', onError);
    });

    try {
      const oversizedBody = Buffer.alloc(80 * 1024, 'x');
      const res = await sendChunkedRequest(`http://127.0.0.1:${port}/collect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        chunks: [oversizedBody]
      });

      assert.strictEqual(res.status, 413);
      assert(res.body.includes('Payload Too Large'));
      assert.strictEqual(childExited, false);

      const healthRes = await makeRequest(`http://127.0.0.1:${port}/client.js`);
      assert.strictEqual(healthRes.status, 200);
      assert.strictEqual(childExited, false);
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  });
});
