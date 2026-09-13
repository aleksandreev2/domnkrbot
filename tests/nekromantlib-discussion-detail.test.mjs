import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('discussion API exposes a native thread detail with real replies', async () => {
  const source = await read('../src/web-title-discussions.ts');

  assert.match(source, /kind:\s*'detail'/);
  assert.match(source, /SELECT[\s\S]*FROM web_title_discussions d[\s\S]*WHERE d\.id = \?/i);
  assert.match(source, /FROM web_title_discussion_replies r/i);
  assert.match(source, /LEFT JOIN users u ON u\.telegram_id = r\.author_telegram_id/i);
  assert.match(source, /ORDER BY r\.created_at DESC/i);
  assert.match(source, /replies:/);
  assert.match(source, /request\.method === 'GET'/);
});

test('discussion list cards link to a native detail permalink', async () => {
  const source = await read('../public/title-discussions.js');

  assert.match(source, /discussionUrl/);
  assert.match(source, /\/discussion\/\?id=/);
  assert.match(source, /title-discussion-card-link/);
});

test('discussion detail page renders thread relation, comments controls and reply composer', async () => {
  const html = await read('../public/discussion/index.html');
  const js = await read('../public/discussion.js');
  const css = await read('../public/discussion.css');

  assert.match(html, /id="discussionTitle"/);
  assert.match(html, /id="discussionBody"/);
  assert.match(html, /id="discussionTitleLink"/);
  assert.match(html, />Комментарии</);
  assert.match(html, />Новые</);
  assert.match(html, />Настройки</);
  assert.match(html, />Правила</);
  assert.match(html, /id="discussionReplyForm"/);
  assert.match(html, /id="discussionReplyText"/);
  assert.match(html, /id="discussionReplies"/);
  assert.match(html, /discussion\.js/);
  assert.match(html, /discussion\.css/);

  assert.match(js, /\/api\/title\/discussions\//);
  assert.match(js, /\/replies/);
  assert.match(js, /credentials:\s*['"]same-origin['"]/);
  assert.match(js, /renderReplies/);
  assert.match(js, /discussion\.bookRef/);
  assert.match(js, /\/title\/\?ref=/);

  assert.match(css, /\.discussion-thread-card\s*\{/);
  assert.match(css, /\.discussion-comments-toolbar\s*\{/);
  assert.match(css, /\.discussion-reply-card\s*\{/);
  assert.match(css, /@media\s*\(max-width:/);
});
