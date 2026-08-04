'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
process.env.ANTIGRAVITY_GOOGLE_CLIENT_ID ||= 'test-antigravity-client-id';
process.env.ANTIGRAVITY_GOOGLE_CLIENT_SECRET ||= 'test-antigravity-client-secret';
const {
  ANTIGRAVITY_USER_AGENT,
  createAntigravityManagedAccount,
  fetchAntigravityManagedLimits,
  normalizeAntigravityManagedAccounts,
  startAntigravityOAuthFlow,
  _isManagedAgentModel,
  _isNonAuthoritativeQuota,
  _loadCodeAssistEnrolled
} = require('../../src/shared/antigravityAccounts');

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fakeFetch(overrides = {}) {
  return async (url, init = {}) => {
    if (typeof overrides.onRequest === 'function') overrides.onRequest(url, init);
    if (url.includes('oauth2.googleapis.com')) return response({ access_token: `access-${init.body}` });
    if (url.includes('userinfo')) {
      const email = typeof overrides.userInfoEmail === 'function'
        ? overrides.userInfoEmail(init)
        : (overrides.userInfoEmail || 'agy@example.com');
      return response({ email });
    }
    if (url.includes('loadCodeAssist')) {
      return response(overrides.load || { cloudaicompanionProject: 'project-1', currentTier: { id: 'free-tier', name: 'Antigravity' } });
    }
    if (url.includes('retrieveUserQuota')) {
      return response(overrides.quota || { buckets: [
        { modelId: 'models/gemini-3-pro', remainingFraction: 0.75, resetTime: '2027-01-01T00:00:00Z' },
        { modelId: 'models/gemini-3-flash', remainingFraction: 0.9, resetTime: '2027-01-01T00:00:00Z' },
        { modelId: 'models/claude-sonnet', remainingFraction: 0.8, resetTime: '2027-01-02T00:00:00Z' },
        { modelId: 'models/gpt-oss', remainingFraction: 0.7, resetTime: '2027-01-01T12:00:00Z' },
        // Always-full autocomplete rows must not drive the summary bars.
        { modelId: 'chat_20706', remainingFraction: 1, resetTime: '2027-01-01T00:00:00Z' },
        { modelId: 'tab_flash_lite_preview', remainingFraction: 1, resetTime: '2027-01-01T00:00:00Z' }
      ] });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

test('managed Antigravity accounts normalize metadata without exposing credentials', () => {
  const result = createAntigravityManagedAccount('refresh-token');
  assert.equal(result.ok, true);
  const metadata = normalizeAntigravityManagedAccounts([{ ...result.account, refreshToken: undefined }]);
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].refreshToken, '');
});

test('managed Antigravity account metadata keeps disabled accounts visible', () => {
  const account = createAntigravityManagedAccount('refresh-token').account;
  const metadata = normalizeAntigravityManagedAccounts([{ ...account, refreshToken: undefined, enabled: false }]);
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].enabled, false);
});

test('managed Antigravity limits fetch one provider per enabled account', async () => {
  const one = createAntigravityManagedAccount('one').account;
  const two = createAntigravityManagedAccount('two').account;
  const providers = await fetchAntigravityManagedLimits([one, two], {
    fetch: fakeFetch({
      userInfoEmail: (init) => String(init?.headers?.authorization || '').includes('refresh_token=one')
        ? 'one@example.com'
        : 'two@example.com'
    }),
    now: () => 0
  });
  assert.equal(providers.length, 2);
  assert.deepEqual(providers.map((provider) => provider.accountEmail), ['one@example.com', 'two@example.com']);
  assert.deepEqual(providers.map((provider) => provider.accountKey), [one.accountKey, two.accountKey]);
  assert.deepEqual(providers[0].windows.map((window) => window.label), ['Gemini', 'Claude/GPT']);
  assert.deepEqual(providers[0].windows.map((window) => Math.round(window.usedPercent)), [25, 30]);
  assert.equal(providers[0].sourceDetail, 'managed');
});

test('managed Antigravity limits collapse duplicate grants for one email', async () => {
  const one = createAntigravityManagedAccount('one-grant').account;
  const two = createAntigravityManagedAccount('two-grant').account;
  const providers = await fetchAntigravityManagedLimits([one, two], { fetch: fakeFetch(), now: () => 0 });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].accountEmail, 'agy@example.com');
});

test('managed Antigravity limits preserve per-account failure status', async () => {
  const account = createAntigravityManagedAccount('bad').account;
  const providers = await fetchAntigravityManagedLimits([account], {
    fetch: async (url) => url.includes('oauth2.googleapis.com') ? response({}, 401) : response({})
  });
  assert.equal(providers[0].status, 'unauthorized');
  assert.equal(providers[0].accountKey, account.accountKey);
});

test('managed Antigravity limits keep an account with no refresh token visible as unavailable', async () => {
  const account = createAntigravityManagedAccount('missing-token').account;
  const providers = await fetchAntigravityManagedLimits([{ ...account, refreshToken: '' }], { fetch: fakeFetch() });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].status, 'unavailable');
  assert.equal(providers[0].accountKey, account.accountKey);
  assert.equal(providers[0].accountLabel, account.accountLabel || 'Antigravity');
  assert.deepEqual(providers[0].windows, []);
});

test('managed Antigravity limits skip disabled accounts', async () => {
  const account = createAntigravityManagedAccount('disabled').account;
  const providers = await fetchAntigravityManagedLimits([{ ...account, enabled: false }], { fetch: fakeFetch() });
  assert.deepEqual(providers, []);
});

test('loadCodeAssistEnrolled requires a real tier or project id', () => {
  assert.equal(_loadCodeAssistEnrolled({ currentTier: { id: 'free-tier' } }), true);
  assert.equal(_loadCodeAssistEnrolled({ cloudaicompanionProject: 'project-1' }), true);
  assert.equal(_loadCodeAssistEnrolled({
    allowedTiers: [{ id: 'standard-tier' }],
    ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT' }]
  }), false);
  assert.equal(_loadCodeAssistEnrolled({}), false);
});

test('isNonAuthoritativeQuota rejects all-full stubs without enrollment', () => {
  const stubBuckets = [
    { modelId: 'gemini-2.5-flash', remainingFraction: 1, tokenType: 'REQUESTS' },
    { modelId: 'gemini-2.5-pro', remainingFraction: 1, tokenType: 'REQUESTS' }
  ];
  assert.equal(_isNonAuthoritativeQuota({ load: {}, buckets: stubBuckets }), true);
  assert.equal(_isNonAuthoritativeQuota({
    load: { currentTier: { id: 'free-tier' } },
    buckets: stubBuckets
  }), false);
  assert.equal(_isNonAuthoritativeQuota({
    load: {},
    buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.1, tokenType: 'REQUESTS' }]
  }), false);
});

test('managed agent model filter drops chat/tab autocomplete rows', () => {
  assert.equal(_isManagedAgentModel('gemini-3.1-pro-high'), true);
  assert.equal(_isManagedAgentModel('claude-sonnet-4-6'), true);
  assert.equal(_isManagedAgentModel('chat_20706'), false);
  assert.equal(_isManagedAgentModel('tab_flash_lite_preview'), false);
});

test('managed Antigravity limits send the Antigravity User-Agent to cloudcode-pa', async () => {
  const account = createAntigravityManagedAccount('ua').account;
  const seen = [];
  await fetchAntigravityManagedLimits([account], {
    fetch: fakeFetch({
      onRequest(url, init) {
        if (String(url).includes('cloudcode-pa') || String(url).includes('loadCodeAssist') || String(url).includes('retrieveUserQuota')) {
          seen.push({ url: String(url), ua: init?.headers?.['user-agent'] || init?.headers?.['User-Agent'] });
        }
      }
    }),
    now: () => 0
  });
  assert.ok(seen.length >= 2);
  assert.ok(seen.every((entry) => entry.ua === ANTIGRAVITY_USER_AGENT));
});

test('managed Antigravity limits treat post-migration all-100% OAuth stubs as unavailable', async () => {
  const account = createAntigravityManagedAccount('stub').account;
  const providers = await fetchAntigravityManagedLimits([account], {
    fetch: fakeFetch({
      load: {
        allowedTiers: [{ id: 'standard-tier', name: 'Gemini Code Assist' }],
        ineligibleTiers: [{
          reasonCode: 'UNSUPPORTED_CLIENT',
          reasonMessage: 'This client is no longer supported. Migrate to Antigravity.'
        }]
      },
      quota: {
        buckets: [
          { modelId: 'gemini-2.5-flash', remainingFraction: 1, tokenType: 'REQUESTS', resetTime: '2026-08-05T00:00:00Z' },
          { modelId: 'gemini-2.5-pro', remainingFraction: 1, tokenType: 'REQUESTS', resetTime: '2026-08-05T00:00:00Z' }
        ]
      }
    }),
    now: () => 0
  });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].status, 'unavailable');
  assert.deepEqual(providers[0].windows, []);
  assert.equal(providers[0].accountEmail, 'agy@example.com');
});

test('managed Antigravity limits still accept a real all-full enrolled quota', async () => {
  const account = createAntigravityManagedAccount('full').account;
  const providers = await fetchAntigravityManagedLimits([account], {
    fetch: fakeFetch({
      load: { cloudaicompanionProject: 'project-1', currentTier: { id: 'free-tier', name: 'Antigravity' } },
      quota: {
        buckets: [
          { modelId: 'models/gemini-3-pro', remainingFraction: 1, resetTime: '2027-01-01T00:00:00Z' },
          { modelId: 'models/claude-sonnet', remainingFraction: 1, resetTime: '2027-01-01T00:00:00Z' }
        ]
      }
    }),
    now: () => 0
  });
  assert.equal(providers[0].status, 'ok');
  assert.deepEqual(providers[0].windows.map((window) => Math.round(window.usedPercent)), [0, 0]);
});

test('managed Antigravity limits report depleted agent pools instead of chat-row 100%', async () => {
  const account = createAntigravityManagedAccount('depleted').account;
  const providers = await fetchAntigravityManagedLimits([account], {
    fetch: fakeFetch({
      load: { cloudaicompanionProject: 'charismatic-memento-h219w', currentTier: { id: 'free-tier', name: 'Antigravity' } },
      quota: {
        buckets: [
          { modelId: 'chat_20706', remainingFraction: 1, resetTime: '2026-08-05T00:00:00Z' },
          { modelId: 'gemini-3.1-pro-high', remainingFraction: 0, resetTime: '2026-08-11T00:00:00Z' },
          { modelId: 'claude-sonnet-4-6', remainingFraction: 0, resetTime: '2026-08-11T00:00:00Z' },
          { modelId: 'tab_flash_lite_preview', remainingFraction: 1, resetTime: '2026-08-05T00:00:00Z' }
        ]
      }
    }),
    now: () => 0
  });
  assert.equal(providers[0].status, 'ok');
  assert.deepEqual(providers[0].windows.map((window) => window.label), ['Gemini', 'Claude/GPT']);
  assert.deepEqual(providers[0].windows.map((window) => Math.round(window.usedPercent)), [100, 100]);
  assert.deepEqual(providers[0].windows.map((window) => Math.round(window.remainingPercent)), [0, 0]);
});

test('Antigravity OAuth flow validates state and returns the refresh token', async () => {
  let authorizationUrl;
  const resultPromise = startAntigravityOAuthFlow({ port: 19991 }, {
    fetch: async (url) => url.includes('oauth2.googleapis.com')
      ? response({ access_token: 'access-token', refresh_token: 'refresh-token' })
      : response({ email: 'oauth@example.com' }),
    openExternal: async (url) => {
      authorizationUrl = new URL(url);
      await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:19991/callback?code=auth-code&state=${authorizationUrl.searchParams.get('state')}`, (res) => {
          res.resume();
          res.on('end', resolve);
        }).on('error', reject);
      });
    }
  });
  const result = await resultPromise;
  assert.match(authorizationUrl.searchParams.get('scope'), /cloud-platform/);
  assert.match(authorizationUrl.searchParams.get('scope'), /cclog/);
  assert.equal(result.refreshToken, 'refresh-token');
  assert.equal(result.userInfo.email, 'oauth@example.com');
});
