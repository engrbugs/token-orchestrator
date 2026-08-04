'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { normalizeLimitProvider } = require('./limits');
const { hashKey } = require('./hashKey');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
// These are the scopes used by Antigravity itself. The basic profile scopes
// are not enough for loadCodeAssist/retrieveUserQuota and cause a successful
// browser login to fail during the first quota validation.
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
];
const OAUTH_CALLBACK_TIMEOUT_MS = 180000;
const LOAD_CODE_ASSIST_URLS = [
  'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
];
// Prefer the daily host first — same order as Antigravity's own client /
// ag-multi-account-switchboard. With the Antigravity User-Agent below, this is
// what returns the real agent model pools instead of the consumer stub.
const RETRIEVE_QUOTA_URLS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'
];

const CLIENT_ID = '[REDACTED_GOOGLE_OAUTH_CLIENT_ID]';
const CLIENT_SECRET = '[REDACTED_GOOGLE_OAUTH_CLIENT_SECRET]';
// Google's cloudcode-pa endpoints gate Antigravity agent quota behind this UA.
// A generic Node fetch UA gets the post-migration consumer stub (4 Gemini models
// all remainingFraction:1, no enrollment). Discovered via ag-multi-account-switchboard.
const ANTIGRAVITY_USER_AGENT = 'Antigravity/4.1.29 Chrome/132.0.6834.160 Electron/39.2.3';

function cleanText(value, max = 512) {
  return String(value || '').trim().slice(0, max);
}

function accountKey(email, refreshToken) {
  return hashKey('antigravity', cleanText(email) || cleanText(refreshToken));
}

function normalizeAntigravityManagedAccounts(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const accounts = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const id = cleanText(item.id, 128);
    const refreshToken = cleanText(item.refreshToken, 4096);
    if (!id) continue;
    const key = cleanText(item.accountKey, 256) || accountKey(item.accountEmail, refreshToken || id);
    if (seen.has(key)) continue;
    seen.add(key);
    accounts.push({
      ...item,
      id,
      accountKey: key,
      refreshToken,
      accountEmail: cleanText(item.accountEmail, 254),
      accountLabel: cleanText(item.accountLabel, 128),
      enabled: item.enabled !== false
    });
  }
  return accounts;
}

function createAntigravityManagedAccount(refreshToken, existing = []) {
  const token = cleanText(refreshToken, 4096);
  if (!token) return { ok: false, errorCode: 'emptyRefreshToken' };
  const duplicate = existing.find((entry) => entry.refreshToken === token);
  return {
    ok: true,
    account: {
      id: duplicate?.id || `antigravity-${crypto.randomUUID()}`,
      accountKey: duplicate?.accountKey || accountKey('', token),
      accountEmail: cleanText(duplicate?.accountEmail, 254),
      accountLabel: cleanText(duplicate?.accountLabel, 128),
      refreshToken: token,
      addedAt: duplicate?.addedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      enabled: true
    }
  };
}

async function jsonRequest(url, init, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const response = await fetchFn(url, init);
  let body = null;
  try { body = await response.json(); } catch (_) {}
  if (!response.ok) {
    const error = new Error(`${url} returned HTTP ${response.status}`);
    error.status = response.status === 401 || response.status === 403 ? 'unauthorized' : 'unavailable';
    throw error;
  }
  return body;
}

async function refreshAccessToken(refreshToken, deps = {}) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  }).toString();
  const result = await jsonRequest(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  }, deps);
  if (!result?.access_token) {
    const error = new Error('Google token response did not contain an access token');
    error.status = 'unauthorized';
    throw error;
  }
  return result;
}

function oauthSuccessHtml(email) {
  const safeEmail = String(email || 'account').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  return `<!doctype html><meta charset="utf-8"><title>Account added</title><p>Google account <strong>${safeEmail}</strong> was added. You can close this window.</p>`;
}

function managedModelSlug(modelId) {
  return String(modelId || '').toLowerCase().split('/').pop() || '';
}

// Chat/tab/autocomplete rows ride alongside agent models in retrieveUserQuota and
// often stay at remainingFraction:1 even when every agent pool is exhausted. They
// must not drive the Gemini / Claude-GPT summary bars.
function isManagedAgentModel(modelId) {
  const slug = managedModelSlug(modelId);
  if (!slug) return false;
  if (slug.startsWith('chat_') || slug.startsWith('tab_')) return false;
  if (slug.includes('placeholder')) return false;
  return true;
}

function managedQuotaGroup(modelId) {
  const value = managedModelSlug(modelId);
  return value.includes('claude') || value.includes('gpt') ? 'Claude/GPT' : 'Gemini';
}

function cloudCodeHeaders(accessToken) {
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': ANTIGRAVITY_USER_AGENT
  };
}

function extractProjectId(load) {
  const raw = load?.cloudaicompanionProject ?? load?.cloudAiCompanionProject ?? load?.project;
  if (typeof raw === 'string') {
    const project = raw.trim();
    return project || null;
  }
  if (raw && typeof raw === 'object') {
    const project = cleanText(raw.id || raw.projectId || raw.name, 256);
    return project || null;
  }
  return null;
}

function loadCodeAssistEnrolled(load) {
  if (!load || typeof load !== 'object') return false;
  if (cleanText(load.currentTier?.id || load.current_tier?.id || load.currentTier?.name || load.current_tier?.name, 128)) {
    return true;
  }
  // Hard-coded enterprise fallback is not enrollment — only a real project id counts.
  return Boolean(extractProjectId(load));
}

function bucketRemainingFraction(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const direct = bucket.remainingFraction ?? bucket.remaining_fraction;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  if (typeof direct === 'string' && direct.trim() !== '') {
    const parsed = Number(direct);
    if (Number.isFinite(parsed)) return parsed;
  }
  const remaining = bucket.remaining;
  if (typeof remaining?.remainingFraction === 'number' && Number.isFinite(remaining.remainingFraction)) {
    return remaining.remainingFraction;
  }
  if (remaining?.case === 'remainingFraction' && typeof remaining.value === 'number' && Number.isFinite(remaining.value)) {
    return remaining.value;
  }
  if (typeof remaining === 'number' && Number.isFinite(remaining)) return remaining;
  return null;
}

// Without the Antigravity User-Agent, unenrolled OAuth tokens still receive a
// consumer stub: a handful of Gemini models all remainingFraction:1 and no
// currentTier/project. Treat "all full agent rows, no enrollment, no partial
// usage" as non-authoritative so a missing UA can't resurrect the false 100%.
function isNonAuthoritativeQuota({ load, buckets }) {
  const fractions = (Array.isArray(buckets) ? buckets : [])
    .filter((bucket) => isManagedAgentModel(bucket?.modelId || bucket?.model_id))
    .map((bucket) => bucketRemainingFraction(bucket))
    .filter((value) => value !== null);
  if (fractions.length === 0) return true;
  if (fractions.some((value) => value < 1)) return false;
  if (loadCodeAssistEnrolled(load)) return false;
  return true;
}

async function startAntigravityOAuthFlow(options = {}, deps = {}) {
  const openExternal = deps.openExternal;
  if (typeof openExternal !== 'function') throw new Error('Browser opener unavailable');
  const fetchFn = deps.fetch || fetch;
  const httpApi = deps.http || http;
  const signal = options.signal;
  const port = Number(options.port) || 19876 + crypto.randomInt(0, 100);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = `${GOOGLE_AUTH_URL}?${new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state
  }).toString()}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    let server;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', onAbort);
      try { server?.close(); } catch (_) {}
      if (error) reject(error); else resolve(result);
    };
    const onAbort = () => {
      const error = new Error('Antigravity sign-in cancelled');
      error.code = 'cancelled';
      finish(error);
    };
    const timeout = setTimeout(() => {
      const error = new Error('Antigravity sign-in timed out');
      error.code = 'timeout';
      finish(error);
    }, OAUTH_CALLBACK_TIMEOUT_MS);
    server = httpApi.createServer(async (req, res) => {
      const parsed = new URL(req.url || '/', redirectUri);
      if (parsed.pathname !== '/callback') {
        res.writeHead(404); res.end(); return;
      }
      const code = parsed.searchParams.get('code') || '';
      const returnedState = parsed.searchParams.get('state') || '';
      const callbackError = parsed.searchParams.get('error') || '';
      if (callbackError) {
        res.writeHead(400); res.end('Google sign-in was cancelled or rejected.');
        const error = new Error(`Google sign-in failed: ${callbackError}`);
        error.code = callbackError === 'access_denied' ? 'cancelled' : 'oauthError';
        finish(error);
        return;
      }
      if (!code || returnedState !== state) {
        res.writeHead(400); res.end('Invalid sign-in callback.');
        const error = new Error('Invalid Google sign-in callback');
        error.code = 'invalidCallback';
        finish(error);
        return;
      }
      try {
        const tokenResponse = await jsonRequest(GOOGLE_TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri
          }).toString()
        }, { fetch: fetchFn });
        if (!tokenResponse.refresh_token) {
          const error = new Error('Google did not return a refresh token. Try signing in again.');
          error.code = 'missingRefreshToken';
          throw error;
        }
        const userInfo = await jsonRequest(GOOGLE_USERINFO_URL, {
          headers: { authorization: `Bearer ${tokenResponse.access_token}` }
        }, { fetch: fetchFn });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(oauthSuccessHtml(userInfo.email));
        finish(null, { refreshToken: tokenResponse.refresh_token, userInfo });
      } catch (error) {
        res.writeHead(500); res.end('Google sign-in failed. You can close this window.');
        finish(error);
      }
    });
    server.on('error', finish);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    server.listen(port, '127.0.0.1', () => {
      Promise.resolve(openExternal(authUrl)).catch(finish);
    });
  });
}

async function fetchAccountQuota(account, deps = {}) {
  const tokens = await (deps.refreshAccessToken || refreshAccessToken)(account.refreshToken, deps);
  const accessToken = tokens.access_token;
  const userInfoHeaders = { authorization: `Bearer ${accessToken}` };
  const cloudHeaders = cloudCodeHeaders(accessToken);
  const userInfo = await jsonRequest(GOOGLE_USERINFO_URL, { headers: userInfoHeaders }, deps).catch(() => ({}));
  const email = cleanText(userInfo.email || account.accountEmail, 254);
  const providerBase = {
    provider: 'antigravity',
    accountKey: accountKey(email, account.refreshToken),
    accountLabel: email || account.accountLabel || 'Antigravity',
    accountEmail: email,
    source: 'api',
    sourceDetail: 'managed',
    updatedAt: new Date((deps.now || Date.now)()).toISOString()
  };
  let load;
  let lastError;
  for (const url of LOAD_CODE_ASSIST_URLS) {
    try {
      load = await jsonRequest(url, {
        method: 'POST',
        headers: cloudHeaders,
        body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } })
      }, deps);
      break;
    } catch (error) { lastError = error; }
  }
  if (!load) throw lastError || new Error('Antigravity account information unavailable');
  // Never invent a project id. Missing project + missing UA was how we used to
  // land on the consumer all-1.0 stub. With the Antigravity UA, loadCodeAssist
  // returns the real project; if it doesn't, still try {} rather than a fake id.
  const project = extractProjectId(load);
  let quota;
  for (const url of RETRIEVE_QUOTA_URLS) {
    try {
      quota = await jsonRequest(url, {
        method: 'POST',
        headers: cloudHeaders,
        body: JSON.stringify(project ? { project } : {})
      }, deps);
      break;
    } catch (error) { lastError = error; }
  }
  if (!quota) throw lastError || new Error('Antigravity quota unavailable');
  const buckets = Array.isArray(quota.buckets) ? quota.buckets : [];
  if (isNonAuthoritativeQuota({ load, buckets })) {
    return normalizeLimitProvider({
      ...providerBase,
      status: 'unavailable',
      windows: []
    });
  }
  const groups = new Map();
  for (const bucket of buckets) {
    const model = cleanText(bucket.modelId || bucket.model_id, 160);
    if (!isManagedAgentModel(model)) continue;
    const remaining = bucketRemainingFraction(bucket);
    if (remaining === null) continue;
    const label = managedQuotaGroup(model);
    const reset = bucket.resetTime || bucket.reset_time || null;
    const existing = groups.get(label);
    if (!existing || remaining < existing.remaining || (remaining === existing.remaining && reset && existing.reset && String(reset) < String(existing.reset))) {
      groups.set(label, { remaining, reset });
    }
  }
  const windows = ['Gemini', 'Claude/GPT'].flatMap((label) => {
    const group = groups.get(label);
    return group ? [{
      kind: 'weekly',
      label,
      usedPercent: Math.max(0, Math.min(100, (1 - group.remaining) * 100)),
      resetsAt: group.reset,
      windowMinutes: null,
      showMeter: true
    }] : [];
  });
  if (windows.length === 0) {
    return normalizeLimitProvider({
      ...providerBase,
      status: 'unavailable',
      windows: []
    });
  }
  return normalizeLimitProvider({
    ...providerBase,
    status: 'ok',
    windows
  });
}

async function fetchAntigravityManagedLimits(accounts, deps = {}) {
  const normalized = normalizeAntigravityManagedAccounts(accounts)
    .filter((account) => account.enabled !== false && account.refreshToken);
  if (!normalized.length) return [];
  return Promise.all(normalized.map(async (account) => {
    try {
      return await fetchAccountQuota(account, deps);
    } catch (error) {
      return normalizeLimitProvider({
        provider: 'antigravity',
        accountKey: account.accountKey,
        accountLabel: account.accountEmail || account.accountLabel || 'Antigravity',
        accountEmail: account.accountEmail,
        source: 'api',
        sourceDetail: 'managed',
        status: error.status || 'unavailable',
        updatedAt: new Date((deps.now || Date.now)()).toISOString(),
        windows: []
      });
    }
  }));
}

module.exports = {
  createAntigravityManagedAccount,
  fetchAntigravityManagedLimits,
  fetchAccountQuota,
  startAntigravityOAuthFlow,
  normalizeAntigravityManagedAccounts,
  refreshAccessToken,
  // Test hooks
  ANTIGRAVITY_USER_AGENT,
  _bucketRemainingFraction: bucketRemainingFraction,
  _extractProjectId: extractProjectId,
  _isManagedAgentModel: isManagedAgentModel,
  _isNonAuthoritativeQuota: isNonAuthoritativeQuota,
  _loadCodeAssistEnrolled: loadCodeAssistEnrolled
};
