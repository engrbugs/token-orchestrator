'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(rootDir, file), 'utf8');

test('README points at .env.example for configuration', () => {
  const readme = read('README.md');
  assert.match(readme, /\.env\.example/);
  assert.doesNotMatch(readme, /docs\/configuration\.md/);
  assert.doesNotMatch(readme, /docs\/API\.md/);
});

test('README describes the current desktop surface', () => {
  const readme = read('README.md');
  assert.match(readme, /AI Tool Limits/);
  assert.match(readme, /Codex and Antigravity accounts/);
  assert.match(readme, /no system-tray icon/);
  assert.match(readme, /minimize and close|local-only/i);
});

test('README keeps provider accounts inside AI Tool Limits and has no tray mode', () => {
  const readme = read('README.md');
  assert.match(readme, /AI Tool Limits/);
  assert.match(readme, /no system-tray icon/i);
  assert.doesNotMatch(readme, /tray-only mode/i);
});

test('kept product docs still exist', () => {
  for (const file of [
    'docs/privacy.md',
    'docs/code-signing.md',
    'docs/export.md',
    'docs/github-copilot-otel.md'
  ]) {
    assert.ok(fs.existsSync(path.join(rootDir, file)), file);
  }
  assert.ok(!fs.existsSync(path.join(rootDir, 'docs/API.md')), 'docs/API.md should be removed');
  assert.ok(!fs.existsSync(path.join(rootDir, 'docs/configuration.md')), 'docs/configuration.md should be removed');
});
