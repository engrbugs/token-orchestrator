'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const OAUTH_TOKEN_KEY = 'antigravityUnifiedStateSync.oauthToken';
const OAUTH_SENTINEL = 'oauthTokenInfoSentinelKey';
const AUTH_STATE_SENTINEL = 'authStateWithContextSentinelKey';
const DEFAULT_AUTH_STATE = JSON.stringify({
  state: 'signedIn',
  context: {
    project: '',
    showProjectError: false,
    errorMessage: '',
    ineligibleMessage: '',
    verificationUrl: '',
    isGcpTos: false,
    browserOpenFailed: false,
    appealUrl: '',
    appealLinkText: ''
  }
});

function cleanText(value, max = 512) {
  return String(value || '').trim().slice(0, max);
}

function encodeVarint(value) {
  let n = Number(value);
  if (!Number.isFinite(n) || n < 0) n = 0;
  n = Math.floor(n);
  const bytes = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n & 0x7f);
  return Buffer.from(bytes.length ? bytes : [0]);
}

function encodeTag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeBytes(fieldNumber, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(buf.length), buf]);
}

function encodeString(fieldNumber, value) {
  return encodeBytes(fieldNumber, Buffer.from(String(value || ''), 'utf8'));
}

function encodeVarintField(fieldNumber, value) {
  return Buffer.concat([encodeTag(fieldNumber, 0), encodeVarint(value)]);
}

function encodeMessage(fieldNumber, payload) {
  return encodeBytes(fieldNumber, payload);
}

function encodeTimestampSeconds(seconds) {
  return encodeVarintField(1, Math.max(0, Math.floor(Number(seconds) || 0)));
}

/**
 * Build the OAuthTokenInfo protobuf used by Antigravity's USS persistence:
 *   1 access_token, 2 token_type, 3 refresh_token, 4 expiry (Timestamp), 6 is_gcp_tos
 */
function encodeOAuthTokenInfo({
  accessToken,
  refreshToken,
  expirySeconds,
  tokenType = 'Bearer',
  isGcpTos = false
} = {}) {
  const access = cleanText(accessToken, 8192);
  const refresh = cleanText(refreshToken, 4096);
  if (!access || !refresh) throw new Error('Antigravity OAuth tokens are required.');
  const expiry = Number.isFinite(Number(expirySeconds))
    ? Math.floor(Number(expirySeconds))
    : Math.floor(Date.now() / 1000) + 3600;
  const parts = [
    encodeString(1, access),
    encodeString(2, tokenType || 'Bearer'),
    encodeString(3, refresh),
    encodeMessage(4, encodeTimestampSeconds(expiry))
  ];
  if (isGcpTos) parts.push(encodeVarintField(6, 1));
  return Buffer.concat(parts);
}

function encodeSentinelRow(sentinelKey, valueText) {
  const valueRow = encodeString(1, valueText);
  return Buffer.concat([
    encodeString(1, sentinelKey),
    encodeMessage(2, valueRow)
  ]);
}

/**
 * Build the base64 blob stored under antigravityUnifiedStateSync.oauthToken.
 * Shape (repeated field 1 rows):
 *   oauthTokenInfoSentinelKey → base64(OAuthTokenInfo)
 *   authStateWithContextSentinelKey → signedIn JSON
 */
function encodeOAuthTokenStorage(tokens = {}) {
  const tokenInfo = encodeOAuthTokenInfo(tokens);
  const tokenInfoB64 = tokenInfo.toString('base64');
  const authState = cleanText(tokens.authStateJson, 4096) || DEFAULT_AUTH_STATE;
  const payload = Buffer.concat([
    encodeMessage(1, encodeSentinelRow(OAUTH_SENTINEL, tokenInfoB64)),
    encodeMessage(1, encodeSentinelRow(AUTH_STATE_SENTINEL, authState))
  ]);
  return payload.toString('base64');
}

function decodeVarint(buffer, offset = 0) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buffer.length) {
    const byte = buffer[pos++];
    result += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result, pos };
}

function readProtoFields(buffer) {
  const fields = [];
  let offset = 0;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  while (offset < buf.length) {
    const tag = decodeVarint(buf, offset);
    offset = tag.pos;
    const field = tag.value >> 3;
    const wireType = tag.value & 7;
    if (wireType === 0) {
      const value = decodeVarint(buf, offset);
      fields.push({ field, wireType, varint: value.value });
      offset = value.pos;
    } else if (wireType === 2) {
      const length = decodeVarint(buf, offset);
      offset = length.pos;
      fields.push({ field, wireType, bytes: buf.subarray(offset, offset + length.value) });
      offset += length.value;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      break;
    }
  }
  return fields;
}

function decodeOAuthTokenStorage(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let outer;
  try {
    outer = Buffer.from(text, 'base64');
  } catch (_) {
    return null;
  }
  const rows = readProtoFields(outer)
    .filter((entry) => entry.wireType === 2 && entry.bytes)
    .map((entry) => {
      const fields = readProtoFields(entry.bytes);
      const keyField = fields.find((item) => item.field === 1 && item.bytes);
      const valueMessage = fields.find((item) => item.field === 2 && item.bytes);
      const valueFields = valueMessage ? readProtoFields(valueMessage.bytes) : [];
      const valueField = valueFields.find((item) => item.field === 1 && item.bytes);
      return {
        key: keyField?.bytes?.toString('utf8') || '',
        value: valueField?.bytes?.toString('utf8') || ''
      };
    });
  const tokenRow = rows.find((row) => row.key === OAUTH_SENTINEL);
  if (!tokenRow?.value) return null;
  let tokenInfo;
  try {
    tokenInfo = Buffer.from(tokenRow.value, 'base64');
  } catch (_) {
    return null;
  }
  const tokenFields = readProtoFields(tokenInfo);
  const accessToken = tokenFields.find((item) => item.field === 1 && item.bytes)?.bytes?.toString('utf8') || '';
  const tokenType = tokenFields.find((item) => item.field === 2 && item.bytes)?.bytes?.toString('utf8') || '';
  const refreshToken = tokenFields.find((item) => item.field === 3 && item.bytes)?.bytes?.toString('utf8') || '';
  const expiryMessage = tokenFields.find((item) => item.field === 4 && item.bytes)?.bytes;
  let expirySeconds = null;
  if (expiryMessage) {
    const expiryFields = readProtoFields(expiryMessage);
    const seconds = expiryFields.find((item) => item.field === 1 && item.varint !== undefined)?.varint;
    if (Number.isFinite(seconds)) expirySeconds = seconds;
  }
  if (!accessToken || !refreshToken) return null;
  return {
    accessToken,
    tokenType,
    refreshToken,
    expirySeconds,
    authStateJson: rows.find((row) => row.key === AUTH_STATE_SENTINEL)?.value || ''
  };
}

function antigravityStateDbCandidates(env = process.env, homeDir = os.homedir(), platform = process.platform) {
  const home = homeDir || os.homedir();
  if (platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
      path.join(home, 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb')
    ];
  }
  if (platform === 'linux') {
    const configHome = cleanText(env.XDG_CONFIG_HOME) || path.join(home, '.config');
    return [
      path.join(configHome, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
      path.join(configHome, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb')
    ];
  }
  const appData = cleanText(env.APPDATA) || path.join(home, 'AppData', 'Roaming');
  return [
    path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
    path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb')
  ];
}

function existingAntigravityStateDbPaths(deps = {}) {
  const env = deps.env || process.env;
  const homeDir = deps.homeDir || os.homedir();
  const platform = deps.platform || process.platform;
  const existsSync = deps.existsSync || fs.existsSync;
  return antigravityStateDbCandidates(env, homeDir, platform).filter((dbPath) => {
    try { return existsSync(dbPath); } catch (_) { return false; }
  });
}

function openStateDatabase(dbPath, deps = {}) {
  const DatabaseSync = deps.DatabaseSync || require('node:sqlite').DatabaseSync;
  return new DatabaseSync(dbPath);
}

function readOAuthTokenFromStateDb(dbPath, deps = {}) {
  const db = openStateDatabase(dbPath, deps);
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(OAUTH_TOKEN_KEY);
    if (!row?.value) return null;
    const value = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value);
    return decodeOAuthTokenStorage(value);
  } finally {
    try { db.close(); } catch (_) {}
  }
}

function writeOAuthTokenToStateDb(dbPath, tokens, deps = {}) {
  const encoded = encodeOAuthTokenStorage(tokens);
  const db = openStateDatabase(dbPath, deps);
  try {
    const existing = db.prepare('SELECT key FROM ItemTable WHERE key = ?').get(OAUTH_TOKEN_KEY);
    if (existing) {
      db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(encoded, OAUTH_TOKEN_KEY);
    } else {
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(OAUTH_TOKEN_KEY, encoded);
    }
  } finally {
    try { db.close(); } catch (_) {}
  }
  return encoded;
}

function writeOAuthTokenToExistingStateDbs(tokens, deps = {}) {
  const discover = deps.existingAntigravityStateDbPaths || existingAntigravityStateDbPaths;
  const dbPaths = discover(deps);
  if (!dbPaths.length) {
    const error = new Error('Antigravity state database not found. Open Antigravity once, then try again.');
    error.code = 'stateDbMissing';
    throw error;
  }
  const written = [];
  for (const dbPath of dbPaths) {
    writeOAuthTokenToStateDb(dbPath, tokens, deps);
    written.push(dbPath);
  }
  return written;
}

function antigravityAppExecutableCandidates(env = process.env, homeDir = os.homedir(), platform = process.platform) {
  const home = homeDir || os.homedir();
  if (platform === 'darwin') {
    return [
      '/Applications/Antigravity IDE.app',
      '/Applications/Antigravity.app',
      path.join(home, 'Applications', 'Antigravity IDE.app'),
      path.join(home, 'Applications', 'Antigravity.app')
    ];
  }
  if (platform === 'linux') {
    return [
      '/opt/antigravity/antigravity',
      '/usr/bin/antigravity',
      path.join(home, '.local', 'share', 'antigravity', 'antigravity')
    ];
  }
  const localAppData = cleanText(env.LOCALAPPDATA) || path.join(home, 'AppData', 'Local');
  return [
    path.join(localAppData, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'),
    path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe')
  ];
}

function existingAntigravityAppExecutables(deps = {}) {
  const env = deps.env || process.env;
  const homeDir = deps.homeDir || os.homedir();
  const platform = deps.platform || process.platform;
  const existsSync = deps.existsSync || fs.existsSync;
  return antigravityAppExecutableCandidates(env, homeDir, platform).filter((exePath) => {
    try { return existsSync(exePath); } catch (_) { return false; }
  });
}

function sleep(ms, deps = {}) {
  const wait = deps.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  return wait(ms);
}

async function runProcessText(cmd, args, deps = {}) {
  const spawnFn = deps.spawn || spawn;
  const timeoutMs = Math.max(1000, Number(deps.timeoutMs) || 10000);
  return new Promise((resolve, reject) => {
    const child = spawnFn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      finish(reject, new Error(`${cmd} timed out`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (code !== 0) finish(reject, new Error(stderr.trim() || `${cmd} exited ${code}`));
      else finish(resolve, stdout);
    });
    child.stdin?.end();
  });
}

async function listRunningAntigravityMainPids(deps = {}) {
  if (typeof deps.listRunningAntigravityMainPids === 'function') {
    return deps.listRunningAntigravityMainPids(deps);
  }
  const platform = deps.platform || process.platform;
  if (platform === 'win32') {
    const script = [
      "Get-CimInstance Win32_Process |",
      "Where-Object {",
      "  $_.Name -match '^(Antigravity( IDE)?|Antigravity)\\.exe$' -and",
      "  ($_.CommandLine -notmatch '--type=')",
      "} |",
      "ForEach-Object { $_.ProcessId }"
    ].join(' ');
    try {
      const stdout = await runProcessText('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], deps);
      return [...new Set(String(stdout || '').split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isFinite(pid) && pid > 0))];
    } catch (_) {
      return [];
    }
  }
  try {
    const stdout = await runProcessText('ps', ['-ax', '-o', 'pid=,command='], deps);
    const pids = [];
    for (const line of String(stdout || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const split = trimmed.indexOf(' ');
      if (split <= 0) continue;
      const pid = Number(trimmed.slice(0, split));
      const command = trimmed.slice(split + 1);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      const lower = command.toLowerCase();
      if (!lower.includes('antigravity')) continue;
      if (lower.includes('language_server') || lower.includes('language-server')) continue;
      if (lower.includes('--type=')) continue;
      // Prefer the actual app binary over helper shells.
      if (lower.includes('antigravity ide') || lower.includes('antigravity.app') || /(^|\/)antigravity(\s|$)/.test(lower)) {
        pids.push(pid);
      }
    }
    return [...new Set(pids)];
  } catch (_) {
    return [];
  }
}

async function quitAntigravityApps(deps = {}) {
  const pids = await listRunningAntigravityMainPids(deps);
  if (!pids.length) return { quit: false, pids: [] };
  const platform = deps.platform || process.platform;
  if (typeof deps.killProcess === 'function') {
    for (const pid of pids) deps.killProcess(pid);
  } else if (platform === 'win32') {
    for (const pid of pids) {
      try {
        await runProcessText('taskkill', ['/PID', String(pid), '/T', '/F'], {
          ...deps,
          timeoutMs: Math.min(8000, Number(deps.timeoutMs) || 8000)
        });
      } catch (_) {}
    }
  } else {
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch (_) {}
    }
    await sleep(800, deps);
    for (const pid of pids) {
      try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch (_) {}
    }
  }
  // Wait for processes to exit and release the SQLite lock.
  const quitWaitMs = Number(deps.quitWaitMs);
  const deadline = Date.now() + (
    Number.isFinite(quitWaitMs) && quitWaitMs >= 0
      ? quitWaitMs
      : 8000
  );
  while (Date.now() < deadline) {
    const remaining = await listRunningAntigravityMainPids(deps);
    if (!remaining.length) break;
    await sleep(250, deps);
  }
  return { quit: true, pids };
}

function launchAntigravityApp(deps = {}) {
  if (typeof deps.launchAntigravityApp === 'function') return deps.launchAntigravityApp(deps);
  const executables = existingAntigravityAppExecutables(deps);
  if (!executables.length) {
    const error = new Error('Antigravity app executable not found.');
    error.code = 'appMissing';
    throw error;
  }
  const target = executables[0];
  const platform = deps.platform || process.platform;
  const spawnFn = deps.spawn || spawn;
  if (platform === 'darwin' && target.endsWith('.app')) {
    spawnFn('open', ['-a', target], { detached: true, stdio: 'ignore' }).unref?.();
    return target;
  }
  spawnFn(target, [], { detached: true, stdio: 'ignore' }).unref?.();
  return target;
}

/**
 * Switch the local Antigravity IDE/account to the provided OAuth refresh token.
 *
 * Antigravity keeps the live session in in-memory USS. External tools cannot
 * call setOAuthTokenInfo (that API only exists inside an Antigravity extension).
 * The durable source of truth is state.vscdb's oauthToken blob — the same place
 * USS persists to. Writing it while Antigravity is running is racy because the
 * IDE can flush the old in-memory token back over our write, so we quit first,
 * write, then relaunch when it was running.
 */
async function switchAntigravitySystemAccount(options = {}, deps = {}) {
  const refreshToken = cleanText(options.refreshToken, 4096);
  if (!refreshToken) {
    const error = new Error('Antigravity refresh token is required.');
    error.code = 'missingRefreshToken';
    throw error;
  }
  const refreshAccessToken = deps.refreshAccessToken;
  if (typeof refreshAccessToken !== 'function') {
    throw new Error('refreshAccessToken dependency is required.');
  }

  const refreshed = await refreshAccessToken(refreshToken, deps);
  const accessToken = cleanText(refreshed?.access_token || refreshed?.accessToken, 8192);
  const nextRefresh = cleanText(refreshed?.refresh_token || refreshed?.refreshToken || refreshToken, 4096);
  const expiresIn = Number(refreshed?.expires_in || refreshed?.expiresIn || 3600);
  const expirySeconds = Math.floor(Date.now() / 1000) + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600);
  if (!accessToken) {
    const error = new Error('Google did not return an access token for this Antigravity account.');
    error.code = 'missingAccessToken';
    throw error;
  }

  const tokens = {
    accessToken,
    refreshToken: nextRefresh,
    expirySeconds,
    tokenType: cleanText(refreshed?.token_type || refreshed?.tokenType || 'Bearer', 32) || 'Bearer',
    isGcpTos: false
  };

  const runningBefore = await listRunningAntigravityMainPids(deps);
  let quitResult = { quit: false, pids: [] };
  if (runningBefore.length) {
    quitResult = await quitAntigravityApps(deps);
    const stillRunning = await listRunningAntigravityMainPids(deps);
    if (stillRunning.length) {
      const error = new Error('Could not close Antigravity before switching accounts. Save your work, quit Antigravity, and try again.');
      error.code = 'quitFailed';
      throw error;
    }
  }

  let writtenPaths;
  try {
    writtenPaths = writeOAuthTokenToExistingStateDbs(tokens, deps);
  } catch (error) {
    // Best-effort relaunch if we closed the app but failed to write.
    if (quitResult.quit) {
      try { launchAntigravityApp(deps); } catch (_) {}
    }
    throw error;
  }

  let launchedPath = null;
  if (quitResult.quit && options.relaunch !== false) {
    try {
      launchedPath = launchAntigravityApp(deps);
    } catch (error) {
      return {
        ok: true,
        restarted: true,
        writtenPaths,
        refreshToken: nextRefresh,
        email: cleanText(options.email, 254),
        warning: `Account credentials were written, but Antigravity could not be relaunched: ${error?.message || error}`
      };
    }
  }

  return {
    ok: true,
    restarted: Boolean(quitResult.quit),
    writtenPaths,
    launchedPath,
    refreshToken: nextRefresh,
    email: cleanText(options.email, 254)
  };
}

module.exports = {
  OAUTH_TOKEN_KEY,
  AUTH_STATE_SENTINEL,
  OAUTH_SENTINEL,
  antigravityAppExecutableCandidates,
  antigravityStateDbCandidates,
  decodeOAuthTokenStorage,
  encodeOAuthTokenInfo,
  encodeOAuthTokenStorage,
  existingAntigravityAppExecutables,
  existingAntigravityStateDbPaths,
  launchAntigravityApp,
  listRunningAntigravityMainPids,
  quitAntigravityApps,
  readOAuthTokenFromStateDb,
  switchAntigravitySystemAccount,
  writeOAuthTokenToExistingStateDbs,
  writeOAuthTokenToStateDb
};
