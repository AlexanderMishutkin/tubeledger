// The content script carries its own version so a tab can tell when it has gone
// stale. Nothing enforces that by itself, so this does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

// The unit tests import the modules but never the content script, which is a
// plain browser IIFE — a syntax error in it would ship silently (one did: a CSS
// comment inside a template literal used backticks and cut the string in half).
test('every shipped script parses', () => {
  for (const file of ['../src/content.js', '../src/background.js', '../src/popup.js', '../src/dashboard.js']) {
    const path = fileURLToPath(new URL(file, import.meta.url));
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file} does not parse:\n${result.stderr}`);
  }
});
