import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRanobeLibBranchIdentity } from '../dist/branch-identity.js';
import { RanobeLibClient } from '../dist/index.js';

test('native branch_id wins and does not depend on team ordering', () => {
  const identity = buildRanobeLibBranchIdentity({
    bookRef: '10--x',
    chapterId: 500,
    nativeBranchId: 2251,
    teamIds: [11969, 77],
    releasedAt: '2026-09-10T10:00:00Z',
    stableBranchRef: null,
  });
  assert.deepEqual(identity, {
    key: 'native:2251',
    nativeBranchId: 2251,
    confidence: 'native',
  });
});

test('fallback identity is stable when upstream team array order changes', () => {
  const input = {
    bookRef: '10--x',
    chapterId: 500,
    nativeBranchId: null,
    releasedAt: '2026-09-10T10:00:00Z',
    stableBranchRef: null,
  };
  const a = buildRanobeLibBranchIdentity({ ...input, teamIds: [11969, 77] });
  const b = buildRanobeLibBranchIdentity({ ...input, teamIds: [77, 11969] });
  assert.equal(a.key, b.key);
  assert.equal(a.confidence, 'fallback');
});

test('identity-less branches are not silently merged', () => {
  const base = {
    bookRef: '10--x',
    chapterId: 500,
    nativeBranchId: null,
    teamIds: [],
    releasedAt: null,
    stableBranchRef: null,
  };
  const a = buildRanobeLibBranchIdentity({ ...base, branchOrdinal: 0 });
  const b = buildRanobeLibBranchIdentity({ ...base, branchOrdinal: 1 });
  assert.equal(a.confidence, 'ambiguous');
  assert.equal(b.confidence, 'ambiguous');
  assert.notEqual(a.key, b.key);
});

test('getChapterBranches preserves native IDs, joint teams and separate independent branches', async () => {
  const past = '2026-09-10T10:00:00Z';
  const future = '2999-01-01T00:00:00Z';
  const response = new Response(JSON.stringify({ data: [
    {
      id: 500,
      volume: '1',
      number: '10',
      name: 'Joint and independent',
      branches: [
        {
          id: 9001,
          branch_id: 2251,
          created_at: past,
          teams: [
            { id: 11969, slug_url: '11969--dom-nekromanta' },
            { id: 77, slug_url: '77--team-x' },
          ],
        },
        {
          id: 9002,
          branch_id: 2252,
          created_at: past,
          teams: [{ id: 88, slug_url: '88--team-y' }],
        },
        {
          id: 9003,
          branch_id: 2253,
          created_at: future,
          teams: [{ id: 11969, slug_url: '11969--dom-nekromanta' }],
        },
      ],
    },
  ] }), { headers: { 'content-type': 'application/json' } });

  const client = new RanobeLibClient({ fetchImpl: async () => response.clone() });
  const branches = await client.getChapterBranches('10--x');

  assert.equal(branches.length, 2, 'scheduled branch must not enter the released snapshot');
  assert.deepEqual(branches.map((branch) => branch.branchKey), ['native:2251', 'native:2252']);
  assert.deepEqual(branches[0].teamIds, [77, 11969]);
  assert.equal(branches[0].identityConfidence, 'native');
  assert.equal(branches[1].identityConfidence, 'native');
});

test('getChapterBranches falls back safely when branch_id is missing', async () => {
  const response = new Response(JSON.stringify({ data: [
    {
      id: 501,
      volume: '1',
      number: '11',
      name: 'Fallback',
      branches: [
        { created_at: '2026-09-10T10:00:00Z', teams: [{ id: 77 }] },
        { teams: [] },
        { teams: [] },
      ],
    },
  ] }), { headers: { 'content-type': 'application/json' } });

  const client = new RanobeLibClient({ fetchImpl: async () => response.clone() });
  const branches = await client.getChapterBranches('10--x');

  assert.equal(branches.length, 3);
  assert.equal(branches[0].identityConfidence, 'fallback');
  const ambiguous = branches.filter((branch) => branch.identityConfidence === 'ambiguous');
  assert.equal(ambiguous.length, 2);
  assert.notEqual(ambiguous[0].branchKey, ambiguous[1].branchKey);
});
