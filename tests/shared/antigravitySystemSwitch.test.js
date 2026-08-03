'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  OAUTH_TOKEN_KEY,
  decodeOAuthTokenStorage,
  encodeOAuthTokenStorage,
  switchAntigravitySystemAccount,
  writeOAuthTokenToStateDb,
  readOAuthTokenFromStateDb
} = require('../../src/shared/antigravitySystemSwitch');

function makeTempStateDb(rootDir) {
  const dir = rootDir || fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-agy-switch-'));
  const dbPath = path.join(dir, 'state.vscdb');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  db.close();
  return { dir, dbPath };
}

test('encode/decode OAuth token storage preserves tokens and expiry', () => {
  const encoded = encodeOAuthTokenStorage({
    accessToken: 'ya29.test-access',
    refreshToken: '1//test-refresh',
    expirySeconds: 1_800_000_000,
    tokenType: 'Bearer'
  });
  const decoded = decodeOAuthTokenStorage(encoded);
  assert.equal(decoded.accessToken, 'ya29.test-access');
  assert.equal(decoded.refreshToken, '1//test-refresh');
  assert.equal(decoded.tokenType, 'Bearer');
  assert.equal(decoded.expirySeconds, 1_800_000_000);
  assert.match(decoded.authStateJson, /signedIn/);
});

test('writeOAuthTokenToStateDb upserts antigravityUnifiedStateSync.oauthToken', () => {
  const { dir, dbPath } = makeTempStateDb();
  try {
    writeOAuthTokenToStateDb(dbPath, {
      accessToken: 'ya29.first',
      refreshToken: '1//first',
      expirySeconds: 1_700_000_000
    });
    let decoded = readOAuthTokenFromStateDb(dbPath);
    assert.equal(decoded.accessToken, 'ya29.first');
    assert.equal(decoded.refreshToken, '1//first');

    writeOAuthTokenToStateDb(dbPath, {
      accessToken: 'ya29.second',
      refreshToken: '1//second',
      expirySeconds: 1_700_000_100
    });
    decoded = readOAuthTokenFromStateDb(dbPath);
    assert.equal(decoded.accessToken, 'ya29.second');
    assert.equal(decoded.refreshToken, '1//second');
    assert.equal(decoded.expirySeconds, 1_700_000_100);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(OAUTH_TOKEN_KEY);
    db.close();
    assert.ok(row?.value);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('switchAntigravitySystemAccount writes tokens without relaunch when AG is closed', async () => {
  const { dir, dbPath } = makeTempStateDb();
  try {
    const result = await switchAntigravitySystemAccount({
      refreshToken: '1//managed-refresh',
      email: 'closed@example.com'
    }, {
      refreshAccessToken: async () => ({
        access_token: 'ya29.closed',
        refresh_token: '1//managed-refresh',
        expires_in: 1800
      }),
      listRunningAntigravityMainPids: async () => [],
      launchAntigravityApp: () => {
        throw new Error('should not launch when AG was closed');
      },
      existingAntigravityStateDbPaths: () => [dbPath],
      sleep: async () => {}
    });
    assert.equal(result.ok, true);
    assert.equal(result.restarted, false);
    assert.deepEqual(result.writtenPaths, [dbPath]);
    const decoded = readOAuthTokenFromStateDb(dbPath);
    assert.equal(decoded.accessToken, 'ya29.closed');
    assert.equal(decoded.refreshToken, '1//managed-refresh');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('switchAntigravitySystemAccount restarts a running AG session', async () => {
  const { dir, dbPath } = makeTempStateDb();
  let running = [42];
  const launches = [];
  try {
    const result = await switchAntigravitySystemAccount({
      refreshToken: '1//live-refresh',
      email: 'live@example.com'
    }, {
      refreshAccessToken: async () => ({
        access_token: 'ya29.live',
        expires_in: 3600
      }),
      listRunningAntigravityMainPids: async () => running.slice(),
      killProcess: (pid) => {
        assert.equal(pid, 42);
        running = [];
      },
      launchAntigravityApp: () => {
        launches.push(true);
        return 'Antigravity IDE.exe';
      },
      existingAntigravityStateDbPaths: () => [dbPath],
      sleep: async () => {}
    });
    assert.equal(result.ok, true);
    assert.equal(result.restarted, true);
    assert.deepEqual(launches, [true]);
    const decoded = readOAuthTokenFromStateDb(dbPath);
    assert.equal(decoded.accessToken, 'ya29.live');
    assert.equal(decoded.refreshToken, '1//live-refresh');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('switchAntigravitySystemAccount fails when AG cannot be quit', async () => {
  const { dir, dbPath } = makeTempStateDb();
  try {
    await assert.rejects(
      () => switchAntigravitySystemAccount({
        refreshToken: '1//stuck'
      }, {
        refreshAccessToken: async () => ({ access_token: 'ya29.x', expires_in: 60 }),
        listRunningAntigravityMainPids: async () => [7],
        killProcess: () => {},
        existingAntigravityStateDbPaths: () => [dbPath],
        quitWaitMs: 50,
        sleep: async () => {}
      }),
      /Could not close Antigravity/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
