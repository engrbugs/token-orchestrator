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
const RETRIEVE_QUOTA_URLS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'
];

const CLIENT_ID = '[REDACTED_GOOGLE_OAUTH_CLIENT_ID]';
const CLIENT_SECRET = '[REDACTED_GOOGLE_OAUTH_CLIENT_SECRET]';

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

function managedQuotaGroup(modelId) {
  const value = String(modelId || '').toLowerCase();
  return value.includes('claude') || value.includes('gpt') ? 'Claude/GPT' : 'Gemini';
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
  const headers = {
    authorization: `Bearer ${tokens.access_token}`,
    'content-type': 'application/json'
  };
  const userInfo = await jsonRequest(GOOGLE_USERINFO_URL, { headers }, deps).catch(() => ({}));
  let load;
  let lastError;
  for (const url of LOAD_CODE_ASSIST_URLS) {
    try {
      load = await jsonRequest(url, {
        method: 'POST', headers,
        body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } })
      }, deps);
      break;
    } catch (error) { lastError = error; }
  }
  if (!load) throw lastError || new Error('Antigravity account information unavailable');
  const project = load.cloudaicompanionProject || 'cloudaicompanion-enterprise';
  let quota;
  for (const url of RETRIEVE_QUOTA_URLS) {
    try {
      quota = await jsonRequest(url, {
        method: 'POST', headers,
        body: JSON.stringify({ project })
      }, deps);
      break;
    } catch (error) { lastError = error; }
  }
  if (!quota) throw lastError || new Error('Antigravity quota unavailable');
  const buckets = Array.isArray(quota.buckets) ? quota.buckets : [];
  const groups = new Map();
  for (const bucket of buckets) {
    const remaining = Number(bucket.remainingFraction ?? bucket.remaining_fraction);
    if (!Number.isFinite(remaining)) continue;
    const model = cleanText(bucket.modelId || bucket.model_id, 160);
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
  const email = cleanText(userInfo.email || account.accountEmail, 254);
  return normalizeLimitProvider({
    provider: 'antigravity',
    accountKey: accountKey(email, account.refreshToken),
    accountLabel: email || account.accountLabel || 'Antigravity',
    accountEmail: email,
    source: 'api',
    sourceDetail: 'managed',
    status: 'ok',
    updatedAt: new Date((deps.now || Date.now)()).toISOString(),
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
  refreshAccessToken
};
