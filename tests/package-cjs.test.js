import { test, describe } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

describe('Package Dual Module Output (CommonJS & ESM)', () => {
  test('CommonJS require(".") loads marple root with expected exports', () => {
    const script = `
      const m = require('.');
      const initFn = m.init || m.default?.init;
      const trackFn = m.track || m.default?.track;
      const dashFn = m.dashboard || m.default?.dashboard;
      if (typeof initFn !== 'function' || typeof trackFn !== 'function' || typeof dashFn !== 'function') {
        process.exit(2);
      }
    `;

    const res = spawnSync(process.execPath, ['--no-experimental-require-module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });

    assert.strictEqual(res.status, 0, `CJS require('.') failed: ${res.stderr || res.stdout}`);
  });

  test('CommonJS require("marple/client") loads client tracker', () => {
    const script = `
      const client = require('marple/client');
      if (!client) {
        process.exit(3);
      }
    `;

    const res = spawnSync(process.execPath, ['--no-experimental-require-module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });

    assert.strictEqual(res.status, 0, `CJS require('marple/client') failed: ${res.stderr || res.stdout}`);
  });

  test('ESM import(".") loads marple root with expected exports', async () => {
    const mod = await import('../dist/index.js');
    assert.strictEqual(typeof mod.init, 'function');
    assert.strictEqual(typeof mod.track, 'function');
    assert.strictEqual(typeof mod.dashboard, 'function');
    assert.strictEqual(typeof mod.marple.init, 'function');
  });

  test('ESM import("./client") loads client tracker', async () => {
    const mod = await import('../dist/client.js');
    assert(mod);
  });

  test('Type declaration files exist for root and client', () => {
    const rootDts = path.resolve('dist/index.d.ts');
    const clientDts = path.resolve('dist/client.d.ts');
    assert(fs.existsSync(rootDts), 'dist/index.d.ts must exist');
    assert(fs.existsSync(clientDts), 'dist/client.d.ts must exist');
  });
});
