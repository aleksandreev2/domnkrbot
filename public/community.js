const communityTg = window.Telegram?.WebApp ?? null;

const communityState = {
  user: null,
  isAdmin: false,
  proposals: [],
  stats: null,
  filter: 'popular',
  admin: null,
  refreshTimer: null,
};

const COMMUNITY_STATUS_LABELS = {
  pending: 'Новая',
  approved: 'Одобрено',
  planned: 'Запланировано',
  in_progress: 'В работе',
  done: 'Готово',
  rejected: 'Отклонено',
};

const COMMUNITY_TYPE_LABELS = {
  title: 'Новый тайтл',
  chapters: 'Конкретные главы',
};

function cEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function cInitData() {
  return communityTg?.initData ?? '';
}

async function cApi(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (cInitData()) headers.set('x-telegram-init-data', cInitData());
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
  return data;
}

function cFormatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function cAuthor(proposal) {
  if (proposal.is_owner) return 'Вы';
  return proposal.username ? `@${proposal.username}` : proposal.first_name || 'Участник';
}

function cChapters(proposal) {
  if (proposal.proposal_type !== 'chapters') return '';
  const from = proposal.chapter_from ?? '?';
  const to = proposal.chapter_to ?? from;
  return String(from) === String(to) ? `Глава ${from}` : `Главы ${from}–${to}`;
}

function cCanVote(proposal) {
  return !proposal.is_owner && !['done', 'rejected'].includes(proposal.status);
}

function voteLabel(proposal) {
  if (proposal.is_owner) return 'Автор';
  if (proposal.status === 'done') return 'Закрыто';
  if (proposal.viewer_voted) return 'Поддержано';
  return 'Поддержать';
}

function communityProposalCard(proposal, { rank = null, admin = false } = {}) {
  const source = proposal.source_url
    ? `<a class="community-source" href="${cEscape(proposal.source_url)}" target="_blank" rel="noopener noreferrer">Источник ↗</a>`
    : '';
  const voteDisabled = cCanVote(proposal) ? '' : 'disabled';
  const voteClass = proposal.viewer_voted ? ' is-active' : '';
  const rankMarkup = rank ? `<div class="community-rank">#${rank}</div>` : '';
  const adminNote = admin ? `
    <label class="admin-note-label">Комментарий команды
      <textarea class="admin-note-input" data-admin-note="${cEscape(proposal.id)}" rows="2" maxlength="1500" placeholder="Необязательно">${cEscape(proposal.admin_note || '')}</textarea>
    </label>
    <div class="community-admin-actions" data-admin-actions="${cEscape(proposal.id)}">
      ${['approved', 'planned', 'in_progress', 'done', 'rejected'].map((status) => `
        <button class="admin-status-button${proposal.status === status ? ' is-current' : ''}" data-admin-status="${status}">
          ${cEscape(COMMUNITY_STATUS_LABELS[status])}
        </button>`).join('')}
    </div>` : '';

  return `
    <article class="community-card" data-community-proposal="${cEscape(proposal.id)}">
      <div class="community-vote-column">
        ${rankMarkup}
        <button class="vote-button${voteClass}" data-community-vote="${cEscape(proposal.id)}" ${voteDisabled}>
          <span class="vote-arrow">▲</span>
          <strong>${Number(proposal.vote_count || 0)}</strong>
          <small>${cEscape(voteLabel(proposal))}</small>
        </button>
      </div>
      <div class="community-card__body">
        <div class="community-card__top">
          <div>
            <h3>${cEscape(proposal.title)}</h3>
            <div class="proposal-meta">${cEscape(cAuthor(proposal))} · ${cEscape(cFormatDate(proposal.created_at))}</div>
          </div>
          ${source}
        </div>
        <div class="proposal-badges">
          <span class="badge">${cEscape(COMMUNITY_TYPE_LABELS[proposal.proposal_type] || proposal.proposal_type)}</span>
          ${proposal.proposal_type === 'chapters' ? `<span class="badge">${cEscape(cChapters(proposal))}</span>` : ''}
          <span class="badge badge--${cEscape(proposal.status)}">${cEscape(COMMUNITY_STATUS_LABELS[proposal.status] || proposal.status)}</span>
        </div>
        ${proposal.comment ? `<p>${cEscape(proposal.comment)}</p>` : ''}
        ${adminNote}
      </div>
    </article>`;
}

function sortedPopular(proposals) {
  return [...proposals].sort((a, b) => {
    const voteDiff = Number(b.vote_count || 0) - Number(a.vote_count || 0);
    if (voteDiff) return voteDiff;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

function filteredCommunityProposals() {
  const proposals = [...communityState.proposals];
  if (communityState.filter === 'popular') return sortedPopular(proposals);
  if (communityState.filter === 'all') return proposals;
  return proposals.filter((proposal) => proposal.status === communityState.filter);
}

function communityEmpty(title, text) {
  return `<section class="empty-card compact"><div class="empty-icon">◇</div><div><strong>${cEscape(title)}</strong><p>${cEscape(text)}</p></div></section>`;
}

function renderCommunity() {
  const home = document.getElementById('communityHomeProposalList');
  const full = document.getElementById('communityProposalList');
  if (!home || !full) return;

  const active = communityState.proposals.filter((proposal) => !['done', 'rejected'].includes(proposal.status));
  const homeItems = sortedPopular(active).slice(0, 4);
  home.innerHTML = homeItems.length
    ? homeItems.map((proposal, index) => communityProposalCard(proposal, { rank: index + 1 })).join('')
    : communityEmpty('Голосование пока пусто', 'Предложите первый тайтл — он сразу появится в рейтинге.');

  const filtered = filteredCommunityProposals();
  full.innerHTML = filtered.length
    ? filtered.map((proposal, index) => communityProposalCard(
        proposal,
        communityState.filter === 'popular' ? { rank: index + 1 } : {},
      )).join('')
    : communityEmpty('Ничего не найдено', 'Для этого фильтра пока нет заявок.');

  const stats = communityState.stats || {};
  const statsNode = document.getElementById('communityStats');
  if (statsNode) {
    statsNode.innerHTML = `
      <span><strong>${Number(stats.proposals || 0)}</strong> заявок</span>
      <span><strong>${Number(stats.votes || 0)}</strong> голосов</span>
      <span><strong>${Number(stats.voters || 0)}</strong> участников</span>`;
  }

  bindVoteButtons();
  document.getElementById('communityAdminShortcut')?.classList.toggle('is-hidden', !communityState.isAdmin);
}

function bindVoteButtons() {
  document.querySelectorAll('[data-community-vote]').forEach((button) => {
    if (button.dataset.bound === '1') return;
    button.dataset.bound = '1';
    button.addEventListener('click', async () => {
      const id = button.dataset.communityVote;
      if (!id) return;
      if (!communityState.user) {
        communityTg?.showAlert?.('Откройте Mini App через @domnekromanta_bot, чтобы голосовать.');
        return;
      }
      button.disabled = true;
      try {
        await cApi(`/api/community/proposals/${encodeURIComponent(id)}/vote`, { method: 'POST' });
        communityTg?.HapticFeedback?.impactOccurred?.('light');
        await refreshCommunity();
      } catch (error) {
        communityTg?.showAlert?.(error.message);
        if (!communityTg) alert(error.message);
      } finally {
        button.disabled = false;
      }
    });
  });
}

async function refreshCommunity() {
  try {
    const data = await cApi('/api/community');
    communityState.user = data.user || null;
    communityState.isAdmin = Boolean(data.isAdmin);
    communityState.proposals = Array.isArray(data.proposals) ? data.proposals : [];
    communityState.stats = data.stats || null;
    renderCommunity();
  } catch (error) {
    console.error('Community feed failed', error);
    const message = communityEmpty('Не удалось загрузить рейтинг', error.message);
    const home = document.getElementById('communityHomeProposalList');
    const full = document.getElementById('communityProposalList');
    if (home) home.innerHTML = message;
    if (full) full.innerHTML = message;
  }
}

function showCommunityView(name) {
  document.querySelectorAll('.view').forEach((view) => view.classList.remove('is-active'));
  document.getElementById(`${name}View`)?.classList.add('is-active');
  document.querySelectorAll('.nav-item[data-nav]').forEach((button) => button.classList.remove('is-active'));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderAdminMetrics(data) {
  const node = document.getElementById('adminMetrics');
  if (!node) return;
  const summary = data.summary || {};
  const proposals = summary.proposals || {};
  node.innerHTML = `
    <article><span>Новые заявки</span><strong>${Number(proposals.pending || 0)}</strong><small>ждут решения</small></article>
    <article><span>В работе</span><strong>${Number(proposals.inProgress || 0)}</strong><small>переводятся сейчас</small></article>
    <article><span>Голосов</span><strong>${Number(summary.votes || 0)}</strong><small>${Number(summary.voters || 0)} участников</small></article>
    <article><span>Пользователей</span><strong>${Number(summary.users || 0)}</strong><small>открывали Mini App</small></article>`;
}

function renderAdminSync(data) {
  const node = document.getElementById('adminSyncStatus');
  if (!node) return;
  const ranobe = data.summary?.ranobelib || {};
  const syncTime = ranobe.lastSyncAt ? cFormatDate(ranobe.lastSyncAt) : 'ещё не было';
  node.innerHTML = `
    <div class="admin-sync-numbers">
      <span><strong>${Number(ranobe.syncedTitles || 0)}</strong> / ${Number(ranobe.activeTitles || 0)} тайтлов</span>
      <span><strong>${Number(ranobe.releases || 0)}</strong> релизов</span>
    </div>
    <p>Последний sync: ${cEscape(syncTime)}</p>
    ${ranobe.lastError ? `<p class="admin-warning">${cEscape(ranobe.lastError)}</p>` : '<p class="admin-ok">Ошибок синхронизации нет.</p>'}`;
}

function renderAdminTop(data) {
  const node = document.getElementById('adminTopProposals');
  if (!node) return;
  const top = sortedPopular((data.proposals || []).filter((proposal) => !['rejected'].includes(proposal.status))).slice(0, 5);
  node.innerHTML = top.length
    ? top.map((proposal, index) => communityProposalCard(proposal, { rank: index + 1 })).join('')
    : communityEmpty('Пока нет рейтинга', 'Голоса сообщества появятся здесь.');
}

function renderAdminModeration(data) {
  const node = document.getElementById('adminModerationList');
  if (!node) return;
  const priority = [...(data.proposals || [])].sort((a, b) => {
    const order = { pending: 0, approved: 1, planned: 2, in_progress: 3, done: 4, rejected: 5 };
    const statusDiff = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (statusDiff) return statusDiff;
    const votes = Number(b.vote_count || 0) - Number(a.vote_count || 0);
    if (votes) return votes;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  node.innerHTML = priority.length
    ? priority.map((proposal) => communityProposalCard(proposal, { admin: true })).join('')
    : communityEmpty('Очередь пуста', 'Новых заявок нет.');
  bindAdminButtons();
}

function bindAdminButtons() {
  document.querySelectorAll('[data-admin-actions] [data-admin-status]').forEach((button) => {
    if (button.dataset.bound === '1') return;
    button.dataset.bound = '1';
    button.addEventListener('click', async () => {
      const wrapper = button.closest('[data-admin-actions]');
      const id = wrapper?.dataset.adminActions;
      const status = button.dataset.adminStatus;
      if (!id || !status) return;
      const note = document.querySelector(`[data-admin-note="${CSS.escape(id)}"]`)?.value || '';
      button.disabled = true;
      try {
        await cApi(`/api/admin/proposals/${encodeURIComponent(id)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status, adminNote: note }),
        });
        communityTg?.HapticFeedback?.notificationOccurred?.('success');
        await Promise.all([refreshCommunity(), loadAdminDashboard()]);
      } catch (error) {
        communityTg?.showAlert?.(error.message);
        if (!communityTg) alert(error.message);
      } finally {
        button.disabled = false;
      }
    });
  });
}

async function loadAdminDashboard() {
  if (!communityState.isAdmin) return;
  const moderation = document.getElementById('adminModerationList');
  if (moderation) moderation.innerHTML = '<div class="proposal-meta">Загрузка админ-центра…</div>';
  try {
    const data = await cApi('/api/community/admin');
    communityState.admin = data;
    renderAdminMetrics(data);
    renderAdminSync(data);
    renderAdminTop(data);
    renderAdminModeration(data);
  } catch (error) {
    if (moderation) moderation.innerHTML = `<div class="form-message is-error">${cEscape(error.message)}</div>`;
  }
}

async function runManualSync() {
  const button = document.getElementById('adminRunSync');
  const resultNode = document.getElementById('adminSyncResult');
  if (!button || !resultNode) return;
  button.disabled = true;
  button.textContent = 'Синхронизируем…';
  resultNode.textContent = 'Запущена очередная безопасная пачка RanobeLib.';
  try {
    const data = await cApi('/api/community/admin/ranobelib/sync', { method: 'POST' });
    const result = data.result || {};
    resultNode.textContent = `Готово: ${Number(result.succeeded || 0)} успешно, ${Number(result.failed || 0)} с ошибкой, новых релизов — ${Number(result.newReleases || 0)}.`;
    communityTg?.HapticFeedback?.notificationOccurred?.('success');
    await loadAdminDashboard();
  } catch (error) {
    resultNode.textContent = error.message;
    resultNode.classList.add('is-error');
  } finally {
    button.disabled = false;
    button.textContent = 'Синхронизировать сейчас';
  }
}

function scheduleCommunityRefresh() {
  window.clearTimeout(communityState.refreshTimer);
  communityState.refreshTimer = window.setTimeout(() => void refreshCommunity(), 350);
}

function bindCommunityUi() {
  document.querySelectorAll('[data-community-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      communityState.filter = button.dataset.communityFilter || 'popular';
      document.querySelectorAll('[data-community-filter]').forEach((chip) => chip.classList.toggle('is-active', chip === button));
      renderCommunity();
    });
  });

  document.getElementById('openAdminCenter')?.addEventListener('click', () => {
    showCommunityView('admin');
    void loadAdminDashboard();
  });
  document.getElementById('adminBack')?.addEventListener('click', () => {
    document.querySelector('[data-nav="profile"]')?.click();
  });
  document.getElementById('adminRefresh')?.addEventListener('click', () => void loadAdminDashboard());
  document.getElementById('adminRunSync')?.addEventListener('click', () => void runManualSync());

  const legacyProposalList = document.getElementById('proposalList');
  if (legacyProposalList) {
    new MutationObserver(scheduleCommunityRefresh).observe(legacyProposalList, { childList: true, subtree: true });
  }
}

bindCommunityUi();
void refreshCommunity();
