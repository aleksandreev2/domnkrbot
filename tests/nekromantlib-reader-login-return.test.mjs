import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('home restores a safe reader route saved before Telegram login', async () => {
  const site = await read('../public/site.js');
  const reader = await read('../public/reader.js');

  assert.match(reader, /localStorage\.setItem\('domnkr:return-after-login',`\$\{location\.pathname\}\$\{location\.search\}`\)/);
  assert.match(site, /target\.startsWith\('\/'\)/);
  assert.match(site, /!target\.startsWith\('\/\/'\)/);
  assert.match(site, /location\.replace\(target\)/);
  assert.doesNotMatch(site, /if\(target==='\/propose\/'\)/);
});
