import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { marple, loadConfig } from '../dist/index.js';

describe('Marple Configuration & CLI Usability', () => {
  test('generated configuration imports and validates successfully', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marple-config-test-'));
    const configPath = path.join(tempDir, 'marple.config.js');
    const customDbPath = path.join(tempDir, 'data', 'analytics.sqlite');

    try {
      fs.writeFileSync(
        configPath,
        `export default {
          storage: 'sqlite',
          sqlitePath: '${customDbPath}',
          retention: {
            keepRawEventsDays: 45,
            keepRollupsDays: 180,
            autoRollup: false
          }
        };\n`
      );

      const loaded = await loadConfig(tempDir);
      assert.ok(loaded, 'Config should be loaded');
      assert.strictEqual(loaded.storage, 'sqlite');
      assert.strictEqual(loaded.sqlitePath, customDbPath);
      assert.strictEqual(loaded.retention?.keepRawEventsDays, 45);
      assert.strictEqual(loaded.retention?.keepRollupsDays, 180);
      assert.strictEqual(loaded.retention?.autoRollup, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('a changed sqlitePath changes the actual database location and initializes storage', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marple-sqlite-path-'));
    const customDbPath = path.join(tempDir, 'custom-location.sqlite');

    try {
      const { storage, config } = await marple.init({
        storage: 'sqlite',
        sqlitePath: customDbPath
      });

      assert.strictEqual(config.sqlitePath, customDbPath);
      await storage.writeEvent({ event_type: 'init_test', timestamp: new Date().toISOString() });

      assert.strictEqual(fs.existsSync(customDbPath), true, 'Database file should exist at custom path');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('invalid configuration fails clearly before opening storage', async () => {
    await assert.rejects(
      async () => {
        await marple.init({ storage: 'invalid-storage-type' });
      },
      /Unsupported storage type/
    );

    await assert.rejects(
      async () => {
        await marple.init({ sqlitePath: 12345 });
      },
      /Invalid sqlitePath/
    );

    await assert.rejects(
      async () => {
        await marple.init({ retention: { keepRawEventsDays: -10 } });
      },
      /Invalid retention\.keepRawEventsDays/
    );
  });

  test('automatic loading from working directory sets retention and storage settings', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marple-cwd-config-'));
    const configPath = path.join(tempDir, 'marple.config.js');
    const customDbPath = path.join(tempDir, 'cwd-custom.sqlite');

    try {
      fs.writeFileSync(
        configPath,
        `export default {
          storage: 'sqlite',
          sqlitePath: '${customDbPath}',
          retention: { keepRawEventsDays: 99, keepRollupsDays: 999, autoRollup: false }
        };\n`
      );

      const origCwd = process.cwd();
      process.chdir(tempDir);
      try {
        const { config } = await marple.init();
        assert.strictEqual(config.retention?.keepRawEventsDays, 99);
        assert.strictEqual(config.retention?.keepRollupsDays, 999);
        assert.strictEqual(config.retention?.autoRollup, false);
        assert.strictEqual(config.sqlitePath, customDbPath);
      } finally {
        process.chdir(origCwd);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
