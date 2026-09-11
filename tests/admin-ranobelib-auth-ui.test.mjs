import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('RanobeLib admin screen imports secrets transiently and confirms credential removal', async () => {
  const source = await readFile(new URL('../public/admin/admin.js', import.meta.url), 'utf8');
  assert.match(source, /\/api\/admin\/ranobelib\/auth/);
  assert.match(source, /id="ranobelibAccessToken"[^>]*type="password"/);
  assert.match(source, /id="ranobelibRefreshToken"[^>]*type="password"/);
  assert.match(source, /id="ranobelibExpiresAt"[^>]*type="datetime-local"/);
  assert.match(source, /method:'PUT'/);
  assert.match(source, /method:'DELETE'/);
  assert.match(source, /confirm\('Удалить авторизацию RanobeLib\?'\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});
