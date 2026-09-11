import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function subscriptions() {
  return import('../dist-runtime/multi-team-subscriptions.js');
}

async function scanner() {
  return import('../dist-runtime/ranobelib-multi-team-scanner.js');
}

async function discovery() {
  return import('../dist-runtime/ranobelib-multi-team-discovery.js');
}

async function teamCopy() {
  return import('../dist-runtime/telegram-notification-team-copy.js');
}

async function completion() {
  return import('../dist-runtime/telegram-translation-completion.js');
}

async function renderer() {
  return import('../dist-runtime/multi-team-notification-render.js');
}

async function catalog() {
  return import('../dist-runtime/telegram-team-catalog.js');
}

test('team-title subscription precedence is exclusion > team > explicit > none', async () => {
  const { resolveTeamTitleSubscription } = await subscriptions();

  assert.deepEqual(
    resolveTeamTitleSubscription({ teamFollowed: true, explicit: true, excluded: true }),
    { enabled: false, reason: 'excluded' },
  );
  assert.deepEqual(
    resolveTeamTitleSubscription({ teamFollowed: true, explicit: true, excluded: false }),
    { enabled: true, reason: 'team' },
  );
  assert.deepEqual(
    resolveTeamTitleSubscription({ teamFollowed: false, explicit: true, excluded: false }),
    { enabled: true, reason: 'explicit' },
  );
  assert.deepEqual(
    resolveTeamTitleSubscription({ teamFollowed: false, explicit: false, excluded: false }),
    { enabled: false, reason: 'none' },
  );
});

test('branch release identity is deterministic and branch-sensitive', async () => {
  const { multiTeamReleaseIdentity } = await scanner();

  const a = multiTeamReleaseIdentity('10--book', 'native:500', [12, 10, 12, 11]);
  const b = multiTeamReleaseIdentity('10--book', 'native:500', [10, 11, 12]);
  const otherBranch = multiTeamReleaseIdentity('10--book', 'native:501', [10, 11, 12]);

  assert.equal(a, b);
  assert.notEqual(a, otherBranch);
  assert.match(a, /^branch-release:v1:/);
});

test('new team baseline does not suppress a fresh release for an already-baselined team', async () => {
  const { computeTeamScopedScanPlan } = await scanner();
  assert.equal(typeof computeTeamScopedScanPlan, 'function');

  const plan = computeTeamScopedScanPlan({
    translations: [
      { teamId: 1, baselineReady: true },
      { teamId: 2, baselineReady: false },
    ],
    branches: [
      { chapterId: 542, branchKey: 'native:10', teamIds: [1] },
      { chapterId: 100, branchKey: 'native:20', teamIds: [2] },
      { chapterId: 543, branchKey: 'native:30', teamIds: [1, 2] },
    ],
    storedBranchKeys: [],
    fetchedBranchCount: 3,
  });

  assert.deepEqual(plan.teamIdsToBaseline, [2]);
  assert.deepEqual(plan.releasableBranches, [
    { chapterId: 542, branchKey: 'native:10', teamIds: [1] },
    { chapterId: 543, branchKey: 'native:30', teamIds: [1] },
  ]);
});

test('unattributed non-empty chapter payload cannot complete a team baseline', async () => {
  const { computeTeamScopedScanPlan } = await scanner();
  const plan = computeTeamScopedScanPlan({
    translations: [{ teamId: 2, baselineReady: false }],
    branches: [],
    storedBranchKeys: [],
    fetchedBranchCount: 12,
  });

  assert.deepEqual(plan.teamIdsToBaseline, []);
  assert.deepEqual(plan.releasableBranches, []);
});

test('genuinely empty title can complete an empty silent baseline', async () => {
  const { computeTeamScopedScanPlan } = await scanner();
  const plan = computeTeamScopedScanPlan({
    translations: [{ teamId: 2, baselineReady: false }],
    branches: [],
    storedBranchKeys: [],
    fetchedBranchCount: 0,
  });

  assert.deepEqual(plan.teamIdsToBaseline, [2]);
  assert.deepEqual(plan.releasableBranches, []);
});

test('team discovery reconciliation only changes relationships in the team being reconciled', async () => {
  const { computeTeamDiscoveryReconciliation } = await discovery();

  const result = computeTeamDiscoveryReconciliation(
    [
      { book_ref: '10--shared', presence_state: 'active' },
      { book_ref: '11--old', presence_state: 'active' },
      { book_ref: '12--returning', presence_state: 'dormant' },
    ],
    ['10--shared', '12--returning', '13--new'],
  );

  assert.deepEqual(result.unchangedActive, ['10--shared']);
  assert.deepEqual(result.makeDormant, ['11--old']);
  assert.deepEqual(result.activate, ['12--returning', '13--new']);
});

test('team discovery preserves a catalog-omitted relation confirmed by secondary RanobeLib evidence', async () => {
  const { computeTeamDiscoveryReconciliation } = await discovery();
  const ref = '247881--deuraegon-ttareul-kiul-su-isseul-ri-eobsjanha';

  const result = computeTeamDiscoveryReconciliation(
    [{ book_ref: ref, presence_state: 'active' }],
    [],
    [ref],
  );

  assert.deepEqual(result.unchangedActive, [ref]);
  assert.deepEqual(result.makeDormant, []);
  assert.deepEqual(result.activate, []);
});

test('partner discovery directly merges titles exactly attributed by team chapter history', async () => {
  const { supplementPartnerHistory } = await discovery();
  const catalogRef = '215088--i-kidnapped-the-heros-women';
  const hiddenRef = '247881--deuraegon-ttareul-kiul-su-isseul-ri-eobsjanha';
  const book = (id, ref, title) => ({
    id,
    ref,
    slug: ref.split('--').slice(1).join('--'),
    url: `https://ranobelib.me/ru/book/${ref}`,
    title,
  });

  const result = await supplementPartnerHistory(
    { isPrimary: false, ranobelibTeamRef: '64306--blinnaia-besa' },
    {
      discoverTeamBooks: async () => [book(215088, catalogRef, 'Я похитил девушек героя')],
      discoverTeamHistoryBooks: async () => [book(247881, hiddenRef, 'Я ни за что не стану воспитывать дочь дракона')],
    },
    [book(215088, catalogRef, 'Я похитил девушек героя')],
    [],
  );

  assert.deepEqual(result.books.map((value) => value.ref).sort(), [catalogRef, hiddenRef].sort());
  assert.deepEqual(result.preservedRefs, []);
});

test('primary-team discovery also merges auth-hidden titles from exact chapter history', async () => {
  const { supplementPartnerHistory } = await discovery();
  const catalogRef = '202991--i-became-the-academys-kibitz-villain';
  const hiddenRef = '68760--cultivation-online';
  const book = (id, ref, title) => ({
    id,
    ref,
    slug: ref.split('--').slice(1).join('--'),
    url: `https://ranobelib.me/ru/book/${ref}`,
    title,
  });

  const result = await supplementPartnerHistory(
    { isPrimary: true, ranobelibTeamRef: '11969--dom-nekromanta' },
    {
      discoverTeamBooks: async () => [book(202991, catalogRef, 'Я стал злодеем Академии')],
      discoverTeamHistoryBooks: async () => [book(68760, hiddenRef, 'Культивация Онлайн')],
    },
    [book(202991, catalogRef, 'Я стал злодеем Академии')],
    [],
  );

  assert.deepEqual(result.books.map((value) => value.ref).sort(), [catalogRef, hiddenRef].sort());
});

test('team discovery treats current catalog membership as active while preserving confirmed completion', async () => {
  const source = await readFile(new URL('../src/ranobelib-multi-team-discovery.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /SELECT \?, book_ref, 'active', 'unknown'/);
  assert.match(source, /SELECT \?, book_ref, 'active', 'active'/);
  assert.match(
    source,
    /WHEN excluded\.completion_pending = 1[\s\S]*AND ranobelib_team_translations\.semantic_status = 'completed'[\s\S]*AND ranobelib_team_translations\.completion_pending = 0[\s\S]*THEN 'completed'[\s\S]*WHEN excluded\.completion_pending = 1 THEN 'active'/,
  );
});

test('scanner keeps baseline and shadow non-delivering and uses branch-aware team mappings', async () => {
  const source = await readFile(new URL('../src/ranobelib-multi-team-scanner.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /const baselineNeeded = translations\.some/);
  assert.match(source, /computeTeamScopedScanPlan/);
  assert.match(source, /getChapterBranches\(work\.book_ref\)/);
  assert.match(source, /INSERT OR IGNORE INTO ranobelib_release_teams/);
  assert.match(source, /reconcileReleaseOutboxRecipients\(env, releaseId\)/);
  assert.match(source, /if \(mode === 'live'\)[\s\S]*persistBranchRelease\(env, work, candidate\)/);
  assert.match(
    source,
    /FROM incoming\s+WHERE 1 = 1\s+ON CONFLICT\(book_ref, chapter_id, branch_key\) DO UPDATE SET/i,
  );
});

test('all effective-demand mutation paths refresh authoritative work demand', async () => {
  const [onboarding, discoverySource, registry] = await Promise.all([
    readFile(new URL('../src/telegram-team-onboarding.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/ranobelib-multi-team-discovery.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/ranobelib-team-registry.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(onboarding, /refreshAllWorkNotificationDemand/);
  assert.match(discoverySource, /refreshAllWorkNotificationDemand/);
  assert.match(registry, /refreshAllWorkNotificationDemand/);
});

test('team-aware demand unions eligible users and preserves delivered history during reconciliation', async () => {
  const source = await readFile(new URL('../src/multi-team-notification-demand.ts', import.meta.url), 'utf8');

  assert.match(source, /COUNT\(DISTINCT user_telegram_id\)/i);
  assert.match(source, /ranobelib_release_teams/);
  assert.match(source, /INSERT OR IGNORE INTO ranobelib_notification_outbox/i);
  assert.match(source, /status IN \('pending',\s*'retry'\)/i);
  assert.doesNotMatch(source, /DELETE FROM ranobelib_notification_outbox[\s\S]*status\s*=\s*'sent'/i);
});

test('translator copy deduplicates teams, keeps primary first and escapes names through caller', async () => {
  const { normalizeNotificationTeamNames, notificationTranslatorLine } = await teamCopy();
  const names = normalizeNotificationTeamNames(['Team X', 'дом некроманта', 'Team X', '  <Y>  ']);
  assert.deepEqual(names, ['дом некроманта', '<Y>', 'Team X']);
  const line = notificationTranslatorLine(names, (value) => value.replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
  assert.match(line, /^Перевод команд:/);
  assert.match(line, /«дом некроманта»/);
  assert.match(line, /«&lt;Y&gt;»/);
  assert.equal((line.match(/Team X/g) ?? []).length, 1);
});

test('completion notification supports joint translators and legacy primary-team fallback', async () => {
  const { formatTranslationCompletionNotification } = await completion();
  const joint = formatTranslationCompletionNotification({
    title: 'Книга', url: 'https://example.com', chapterCount: 1,
    firstNumber: '10', lastNumber: '10', teamNames: ['Дом Некроманта', 'Team <X>'],
  });
  assert.match(joint.text, /Дом Некроманта/);
  assert.match(joint.text, /Team &lt;X&gt;/);

  const legacy = formatTranslationCompletionNotification({
    title: 'Книга', url: 'https://example.com', chapterCount: 0,
    firstNumber: null, lastNumber: null,
  });
  assert.match(legacy.text, /Перевод команды «Дом Некроманта»/);
});

test('team-aware chapter renderer emits translator line exactly once', async () => {
  const { formatTeamAwareReleaseNotification } = await renderer();
  const payload = formatTeamAwareReleaseNotification({
    title: 'Книга', url: 'https://example.com', chapterCount: 1,
    firstNumber: '7', lastNumber: '7', summary: 'Chapter 7',
    teamNames: ['Дом Некроманта', 'Team X'],
  });
  assert.equal((payload.text.match(/Перевод команд:/g) ?? []).length, 1);
  assert.equal((payload.text.match(/Дом Некроманта/g) ?? []).length, 1);
  assert.equal((payload.text.match(/Team X/g) ?? []).length, 1);
});

test('search grouping keeps one work with multiple independent team translations', async () => {
  const { groupTeamTranslationSearch } = await catalog();
  const base = {
    ranobelibId: 10, bookRef: '10--book', title: 'Книга', url: 'https://example.com',
    semanticStatus: 'active', enabled: true, enabledReason: 'explicit',
  };
  const groups = groupTeamTranslationSearch([
    { ...base, teamId: 1, teamName: 'Дом Некроманта', teamIsPrimary: true },
    { ...base, teamId: 2, teamName: 'Team X', teamIsPrimary: false },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].translations.map((row) => row.teamId), [1, 2]);
});
