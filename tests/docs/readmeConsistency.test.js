'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(rootDir, file), 'utf8');

test('configuration reference env keys all exist in .env.example', () => {
  const envKeys = (text) => {
    const block = text.match(/```env\n([\s\S]*?)```/)?.[1] || '';
    return [...block.matchAll(/^(TOKEN_MONITOR_[A-Z0-9_]+)=/gm)].map((match) => match[1]);
  };
  const docKeys = envKeys(read('docs/configuration.md'));
  assert.ok(docKeys.length > 0, 'docs/configuration.md should list env keys');
  const exampleKeys = new Set(
    [...read('.env.example').matchAll(/^(TOKEN_MONITOR_[A-Z0-9_]+)=/gm)].map((match) => match[1])
  );
  for (const key of docKeys) assert.ok(exampleKeys.has(key), `${key} missing from .env.example`);
});

test('README describes the current desktop surface', () => {
  const readme = read('README.md');
  assert.match(readme, /AI Tool Limits/);
  assert.match(readme, /Codex and Antigravity accounts/);
  assert.match(readme, /no system-tray icon/);
  assert.match(readme, /minimize and close/);
  assert.match(readme, /docs\/configuration\.md/);
});

test('configuration keeps provider accounts inside AI Tool Limits', () => {
  const configuration = read('docs/configuration.md');
  assert.match(configuration, /\| \*\*AI Tool Limits\*\* \|[^|]*(?:credentials|multiple accounts)[^|]*\|/);
  assert.doesNotMatch(configuration, /\| \*\*Accounts\*\* \|/);
  assert.match(configuration, /no system-tray icon/i);
});
