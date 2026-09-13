import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('title discussions migration stores native threads and replies', async () => {
  const sql = await read('../migrations/0037_web_title_discussions.sql');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS web_title_discussions/i);
  assert.match(sql, /book_ref TEXT NOT NULL/i);
  assert.match(sql, /author_telegram_id TEXT NOT NULL/i);
  assert.match(sql, /title TEXT NOT NULL/i);
  assert.match(sql, /body TEXT NOT NULL/i);
  assert.match(sql, /category TEXT NOT NULL DEFAULT 'Обсуждение тайтла'/i);
  assert.match(sql, /updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS web_title_discussion_replies/i);
  assert.match(sql, /discussion_id TEXT NOT NULL/i);
  assert.match(sql, /FOREIGN KEY \(discussion_id\) REFERENCES web_title_discussions\(id\) ON DELETE CASCADE/i);
});

test('title discussions API lists by updates and creates native threads and replies', async () => {
  const source = await read('../src/web-title-discussions.ts');

  assert.match(source, /handleWebTitleDiscussionsApi/);
  assert.match(source, /\/api\/title\/discussions/);
  assert.match(source, /getSessionUser\(request, env\)/);
  assert.match(source, /isSameOriginMutation\(request\)/);
  assert.match(source, /ranobelib_titles/i);
  assert.match(source, /INSERT INTO web_title_discussions/i);
  assert.match(source, /INSERT INTO web_title_discussion_replies/i);
  assert.match(source, /UPDATE web_title_discussions[\s\S]*updated_at\s*=\s*CURRENT_TIMESTAMP/i);
  assert.match(source, /COUNT\(r\.id\)[\s\S]*reply_count/i);
  assert.match(source, /ORDER BY d\.updated_at DESC/i);
  assert.match(source, /THREAD_TITLE_MAX\s*=\s*140/);
  assert.match(source, /THREAD_BODY_MAX\s*=\s*6000/);
});

test('production entry routes title discussions before the v2 worker', async () => {
  const source = await read('../src/live-entry-v3.ts');

  assert.match(source, /import \{ handleWebTitleDiscussionsApi, type WebTitleDiscussionsEnv \} from '\.\/web-title-discussions\.js'/);
  assert.match(source, /& WebTitleDiscussionsEnv/);
  assert.match(source, /const titleDiscussionsResponse = await handleWebTitleDiscussionsApi\(request, env\)/);
  assert.match(source, /if \(titleDiscussionsResponse\) return titleDiscussionsResponse/);
  assert.ok(
    source.indexOf('handleWebTitleDiscussionsApi(request, env)') < source.indexOf('previous.fetch(request, env, ctx)'),
    'title discussions API should run before the v2 worker',
  );
});

test('title discussions tab is a native thread list owned by the central title router', async () => {
  const html = await read('../public/title/index.html');
  const js = await read('../public/title-discussions.js');
  const css = await read('../public/title-discussions.css');

  assert.match(html, /data-title-tab="discussions"(?![^>]*disabled)/i);
  assert.match(html, /id="titleDiscussionsPanel"/);
  assert.match(html, /id="titleDiscussionSort"/);
  assert.match(html, /id="titleDiscussionComposer"/);
  assert.match(html, /id="titleDiscussionTitle"/);
  assert.match(html, /id="titleDiscussionBody"/);
  assert.match(html, /id="titleDiscussionList"/);
  assert.match(html, /title-discussions\.js/);
  assert.match(html, /title-discussions\.css/);

  assert.match(js, /\/api\/title\/discussions\?ref=/);
  assert.match(js, /title-tab-change/);
  assert.doesNotMatch(js, /history\.(?:replaceState|pushState)/);
  assert.match(js, /renderTitleDiscussions/);
  assert.match(js, /createDiscussion/);
  assert.match(js, /replyCount/);
  assert.match(js, /updatedAt/);
  assert.match(js, /category/);

  assert.match(css, /\.title-discussion-toolbar\s*\{/);
  assert.match(css, /\.title-discussion-card\s*\{/);
  assert.match(css, /\.title-discussion-metrics\s*\{/);
  assert.match(css, /\.title-discussion-empty\s*\{/);
});
