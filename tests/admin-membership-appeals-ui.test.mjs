import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const adminIndex=fs.readFileSync(new URL('../public/admin/index.html',import.meta.url),'utf8');
const appealsHtml=fs.readFileSync(new URL('../public/admin/membership-appeals.html',import.meta.url),'utf8');
const appealsJs=fs.readFileSync(new URL('../public/admin/membership-appeals.js',import.meta.url),'utf8');

test('admin navigation exposes membership appeals',()=>{
  assert.match(adminIndex,/\/admin\/membership-appeals\.html/);
});

test('membership appeal admin page loads, shows comments and supports both decisions',()=>{
  assert.match(appealsHtml,/membershipAppealsList/);
  assert.match(appealsHtml,/membership-appeals\.js/);
  assert.match(appealsJs,/\/api\/admin\/membership-appeals/);
  assert.match(appealsJs,/adminComment/);
  assert.match(appealsJs,/decision:'approve'/);
  assert.match(appealsJs,/decision:'reject'/);
  assert.match(appealsJs,/Комментарий пользователя/);
});
