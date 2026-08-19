import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTitleProposalPolicy, titleProposalRawError } from '../dist-runtime/title-proposal-policy.js';

test('title proposal requires a RAW source URL', () => {
  assert.equal(titleProposalRawError({ proposalType: 'title', title: 'Example', sourceUrl: '' }), 'Для нового тайтла обязательна ссылка на RAW.');
  assert.equal(titleProposalRawError({ proposalType: 'title', title: 'Example' }), 'Для нового тайтла обязательна ссылка на RAW.');
  assert.equal(titleProposalRawError({ proposalType: 'title', title: 'Example', sourceUrl: 'https://example.com/raw' }), null);
});

test('chapter proposal is not affected by title RAW policy', () => {
  assert.equal(titleProposalRawError({ proposalType: 'chapters', title: 'Example', sourceUrl: '' }), null);
});

test('RAW policy rejects title POST before proposal handler', async () => {
  const request = new Request('https://example.com/api/proposals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proposalType: 'title', title: 'Example', sourceUrl: '' }),
  });
  const response = await handleTitleProposalPolicy(request);
  assert.ok(response);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Для нового тайтла обязательна ссылка на RAW.' });
});

test('RAW policy lets valid title proposal continue', async () => {
  const request = new Request('https://example.com/api/proposals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proposalType: 'title', title: 'Example', sourceUrl: 'https://example.com/raw' }),
  });
  assert.equal(await handleTitleProposalPolicy(request), null);
});
