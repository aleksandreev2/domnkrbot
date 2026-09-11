import assert from 'node:assert/strict';
import test from 'node:test';

import { supplementPartnerHistory } from '../dist-runtime/ranobelib-multi-team-discovery.js';

const team = {
  id: 1,
  ranobelibTeamId: 11969,
  ranobelibTeamRef: '11969--dom-nekromanta',
  displayName: 'Дом Некроманта',
  isPrimary: true,
  lifecycleState: 'published',
  recommendationChatId: null,
  recommendationChatTitle: null,
  recommendationChatUsername: null,
  recommendationMembershipCapable: false,
  lastSyncAt: null,
  lastSyncError: null,
};

function book(id, ref) {
  return {
    id,
    ref,
    slug: ref.split('--').slice(1).join('--'),
    url: `https://ranobelib.me/ru/book/${ref}`,
    title: ref,
  };
}

function branch(chapterId, teamIds) {
  return {
    chapterId,
    volume: '1',
    number: String(chapterId),
    name: null,
    branchKey: `native:${chapterId}`,
    nativeBranchId: chapterId,
    identityConfidence: 'native',
    teamIds,
    releasedAt: '2026-09-11T12:00:00Z',
    stableBranchRef: null,
    branchOrdinal: 0,
  };
}

test('primary history-only relation stays active when current released branches still attribute the registered team', async () => {
  const catalogRef = '100--catalog';
  const hiddenRef = '68760--cultivation-online';
  const result = await supplementPartnerHistory(
    team,
    {
      discoverTeamBooks: async () => [book(100, catalogRef)],
      discoverTeamHistoryBooks: async () => [book(68760, hiddenRef)],
      getChapterBranches: async (ref) => ref === hiddenRef ? [branch(10, [11969])] : [],
    },
    [book(100, catalogRef)],
    [{ book_ref: hiddenRef, presence_state: 'active' }],
  );

  assert.ok(result.books.some((value) => value.ref === hiddenRef));
  assert.deepEqual(result.preservedRefs, []);
});

test('primary history-only relation is not kept active when current branches belong only to other teams', async () => {
  const catalogRef = '100--catalog';
  const staleRef = '202991--i-became-the-academys-kibitz-villain';
  const result = await supplementPartnerHistory(
    team,
    {
      discoverTeamBooks: async () => [book(100, catalogRef)],
      discoverTeamHistoryBooks: async () => [book(202991, staleRef)],
      getChapterBranches: async (ref) => ref === staleRef
        ? [branch(3759446, [54537, 6636])]
        : [],
    },
    [book(100, catalogRef)],
    [{ book_ref: staleRef, presence_state: 'active' }],
  );

  assert.ok(!result.books.some((value) => value.ref === staleRef));
  assert.ok(!result.preservedRefs.includes(staleRef));
});

test('primary history verification failure preserves an existing active relation instead of removing it', async () => {
  const catalogRef = '100--catalog';
  const hiddenRef = '68760--cultivation-online';
  const result = await supplementPartnerHistory(
    team,
    {
      discoverTeamBooks: async () => [book(100, catalogRef)],
      discoverTeamHistoryBooks: async () => [book(68760, hiddenRef)],
      getChapterBranches: async () => { throw new Error('RanobeLib 500'); },
    },
    [book(100, catalogRef)],
    [{ book_ref: hiddenRef, presence_state: 'active' }],
  );

  assert.ok(!result.books.some((value) => value.ref === hiddenRef));
  assert.deepEqual(result.preservedRefs, [hiddenRef]);
});
