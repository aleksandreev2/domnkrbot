import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const adminJs = await readFile(new URL('../public/admin/admin.js', import.meta.url), 'utf8');
const adminCss = await readFile(new URL('../public/admin/admin.css', import.meta.url), 'utf8');

test('proposal moderation UI uses enriched title proposal details and five workflow tabs', () => {
  assert.match(adminJs, /\/api\/admin\/title-proposal-details/);
  for (const label of ['Новые', 'Одобрено', 'В плане', 'В работе', 'Закрытые']) {
    assert.ok(adminJs.includes(label), `missing tab: ${label}`);
  }
  assert.ok(adminJs.includes('Есть RanobeLib'));
  assert.ok(adminJs.includes('Нет RanobeLib'));
  assert.match(adminJs, /data-request-detail/);
  assert.match(adminJs, /data-request-card/);
});

test('proposal detail includes RAW, admin note, status actions and RanobeLib linking workflow', () => {
  assert.match(adminJs, /raw_upload_id/);
  assert.match(adminJs, /admin_note/);
  assert.match(adminJs, /\/api\/admin\/title-proposals\/ranobelib-search/);
  assert.match(adminJs, /link-ranobelib/);
  assert.ok(adminJs.includes('Проверить RanobeLib'));
  assert.ok(adminJs.includes('Связать'));
  assert.ok(adminJs.includes('Скачать RAW'));
});

test('proposal moderation layout has dedicated responsive styling', () => {
  assert.match(adminCss, /\.request-moderation-layout/);
  assert.match(adminCss, /\.request-queue-tabs/);
  assert.match(adminCss, /\.request-detail-panel/);
  assert.match(adminCss, /\.request-ranobelib-results/);
});
