// The content script carries its own version so a tab can tell when it has gone
// stale. Nothing enforces that by itself, so this does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('content.js BUILD matches the manifest version', () => {
  const manifest = JSON.parse(read('../manifest.json'));
  const build = /const BUILD = '([^']+)'/.exec(read('../src/content.js'));
  assert.ok(build, 'content.js declares a BUILD constant');
  assert.equal(build[1], manifest.version);
});

test('package.json version matches the manifest too', () => {
  assert.equal(JSON.parse(read('../package.json')).version, JSON.parse(read('../manifest.json')).version);
});
