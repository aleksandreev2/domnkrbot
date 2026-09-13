import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('title shell owns section routing for native social tabs', async () => {
  const source = await read('../public/title.js');
  assert.match(source, /comments\s*:\s*['"]comments['"]/);
  assert.match(source, /discussions\s*:\s*['"]discussions['"]/);
  assert.match(source, /reviews\s*:\s*['"]review['"]/);
  assert.match(source, /history\.pushState\(/);
  assert.match(source, /addEventListener\(['"]popstate['"]/);
});

test('title shell applies one active panel and broadcasts tab changes', async () => {
  const source = await read('../public/title.js');
  assert.match(source, /\[data-title-tab\]/);
  assert.match(source, /\.title-tab-panel/);
  assert.match(source, /CustomEvent\(['"]title-tab-change['"]/);
  assert.match(source, /dispatchEvent\(/);
});

test('deep links and browser history replay existing social lazy loaders through the bridge', async () => {
  const html = await read('../public/title/index.html');
  const bridge = await read('../public/title-routing-bridge.js');

  assert.match(html, /\/title-routing-bridge\.js\?/);
  assert.match(bridge, /DOMContentLoaded/);
  assert.match(bridge, /addEventListener\(['"]popstate['"]/);
  assert.match(bridge, /comments/);
  assert.match(bridge, /discussions/);
  assert.match(bridge, /review/);
  assert.match(bridge, /\[data-title-tab=/);
  assert.match(bridge, /\.click\(\)/);
});
