const tg = window.Telegram?.WebApp ?? null;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor?.('#10100f');
  tg.setBackgroundColor?.('#10100f');
}

const state = {
  user: null,
  isAdmin: false,
  proposals: [],
  filter: 'all',
};

const statusLabels = {
  pending: 'Новая',
  approved: 'Одобрено',
  planned: 'Запланировано',
  in_progress: 'В работе',
  done: 'Готово',
  rejected: 'Отклонено',
};

const typeLabels = {
  title: 'Новый тайтл',
  chapters: 'Конкретные главы',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function initData() {
  return tg?.initData ?? '';
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (initData()) headers.set('x-telegram-init-data', initData());
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
  return data;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

function authorLabel(proposal) {
  return proposal.username ? `@${proposal.username}` : proposal.first_name || 'Участник';
}

function chaptersLabel(proposal) {
  if (proposal.proposal_type !== 'chapters') return '';
  const from = proposal.chapter_from ?? '?';
  const to = proposal.chapter_to ?? from;
  return from === to ? `Глава ${from}` : `Главы ${from}–${to}`;
}

function proposalCard(proposal, { admin = false, mine = false } = {}) {
  const source = proposal.source_url
    ? `<a class="proposal-link" href="${escapeHtml(proposal.source_url)}" target="_blank" rel="noopener noreferrer">Источник ↗</a>`
    : '';
  const author = mine ? 'Вы' : authorLabel(proposal);
  const adminActions = admin ? `
    <div class="admin-actions" data-admin-id="${escapeHtml(proposal.id)}">
      <button data-status="approved">Одобрить</button>
      <button data-status="planned">В план</button>
      <button data-status="in_progress">В работу</button>
      <button data-status="done">Готово</button>
      <button data-status="rejected">Отклонить</button>
    </div>` : '';
  const adminNote = mine && proposal.admin_note ? `<p><b>Комментарий команды:</b> ${escapeHtml(proposal.admin_note)}</p>` : '';

  return `
    <article class="proposal-card">
      <div class="proposal-card__top">
        <div>
          <h3>${escapeHtml(proposal.title)}</h3>
          <div class="proposal-meta"><span class="proposal-author">${escapeHtml(author)}</span> · ${escapeHtml(formatDate(proposal.created_at))}</div>
        </div>
        ${source}
      </div>
      <div class="proposal-badges">
        <span class="badge">${escapeHtml(typeLabels[proposal.proposal_type] || proposal.proposal_type)}</span>
        ${proposal.proposal_type === 'chapters' ? `<span class="badge">${escapeHtml(chaptersLabel(proposal))}</span>` : ''}
        <span class="badge badge--${escapeHtml(proposal.status)}">${escapeHtml(statusLabels[proposal.status] || proposal.status)}</span>
      </div>
      ${proposal.comment ? `<p>${escapeHtml(proposal.comment)}</p>` : ''}
      ${adminNote}
      ${adminActions}
    </article>`;
}

function renderPublicProposals() {
  const filtered = state.filter === 'all'
    ? state.proposals
    : state.proposals.filter((proposal) => proposal.status === state.filter);
  const full = document.getElementById('proposalList');
  const home = document.getElementById('homeProposalList');

  const empty = `<section class="empty-card compact"><div class="empty-icon">＋</div><div><strong>Пока пусто</strong><p>Станьте первым, кто предложит перевод.</p></div></section>`;
  full.innerHTML = filtered.length ? filtered.map((proposal) => proposalCard(proposal)).join('') : empty;
  home.innerHTML = state.proposals.length ? state.proposals.slice(0, 4).map((proposal) => proposalCard(proposal)).join('') : empty;
}

function updateProfile() {
  const name = state.user ? `${state.user.firstName}${state.user.lastName ? ` ${state.user.lastName}` : ''}` : 'Гость';
  const username = state.user?.username ? `@${state.user.username}` : (state.user ? 'Telegram' : 'Откройте приложение через @domnekromanta_bot');
  const initial = name.trim()[0]?.toUpperCase() || '?';
  document.getElementById('profileName').textContent = name;
  document.getElementById('profileUsername').textContent = username;
  document.getElementById('profileAvatar').textContent = initial;
  document.getElementById('profileButton').textContent = initial;
  document.getElementById('adminPanel').classList.toggle('is-hidden', !state.isAdmin);
}

async function loadMyProposals() {
  const container = document.getElementById('myProposalList');
  if (!state.user) {
    container.innerHTML = `<section class="empty-card compact"><div class="empty-icon">↗</div><div><strong>Нужен Telegram</strong><p>Откройте Mini App через бота, чтобы отправлять и отслеживать свои заявки.</p></div></section>`;
    return;
  }
  container.innerHTML = '<div class="proposal-meta">Загрузка…</div>';
  try {
    const data = await api('/api/me/proposals');
    container.innerHTML = data.proposals?.length
      ? data.proposals.map((proposal) => proposalCard({ ...proposal, first_name: state.user.firstName, username: state.user.username }, { mine: true })).join('')
      : `<section class="empty-card compact"><div class="empty-icon">＋</div><div><strong>У вас ещё нет заявок</strong><p>Предложите первый перевод.</p></div></section>`;
  } catch (error) {
    container.innerHTML = `<div class="form-message is-error">${escapeHtml(error.message)}</div>`;
  }
}

async function loadAdminProposals() {
  if (!state.isAdmin) return;
  const container = document.getElementById('adminProposalList');
  container.innerHTML = '<div class="proposal-meta">Загрузка…</div>';
  try {
    const data = await api('/api/admin/proposals');
    container.innerHTML = data.proposals?.length
      ? data.proposals.map((proposal) => proposalCard(proposal, { admin: true })).join('')
      : `<section class="empty-card compact"><div class="empty-icon">✓</div><div><strong>Очередь пуста</strong><p>Новых заявок нет.</p></div></section>`;
    bindAdminActions();
  } catch (error) {
    container.innerHTML = `<div class="form-message is-error">${escapeHtml(error.message)}</div>`;
  }
}

function bindAdminActions() {
  document.querySelectorAll('[data-admin-id] button[data-status]').forEach((button) => {
    button.addEventListener('click', async () => {
      const wrapper = button.closest('[data-admin-id]');
      const id = wrapper?.dataset.adminId;
      const status = button.dataset.status;
      if (!id || !status) return;
      button.disabled = true;
      try {
        await api(`/api/admin/proposals/${encodeURIComponent(id)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status }),
        });
        await refreshProposals();
        await loadAdminProposals();
      } catch (error) {
        alert(error.message);
      } finally {
        button.disabled = false;
      }
    });
  });
}

function showView(name) {
  document.querySelectorAll('.view').forEach((view) => view.classList.remove('is-active'));
  document.getElementById(`${name}View`)?.classList.add('is-active');
  document.querySelectorAll('.nav-item[data-nav]').forEach((button) => button.classList.toggle('is-active', button.dataset.nav === name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'profile') {
    void loadMyProposals();
    void loadAdminProposals();
  }
}

function openProposalModal() {
  const modal = document.getElementById('proposalModal');
  modal.classList.remove('is-hidden');
  document.body.style.overflow = 'hidden';
}

function closeProposalModal() {
  document.getElementById('proposalModal').classList.add('is-hidden');
  document.body.style.overflow = '';
}

function setProposalType(type) {
  document.getElementById('proposalType').value = type;
  document.getElementById('chapterRange').classList.toggle('is-hidden', type !== 'chapters');
  document.querySelectorAll('.segmented button[data-type]').forEach((button) => button.classList.toggle('is-active', button.dataset.type === type));
}

async function refreshProposals() {
  const data = await api('/api/proposals');
  state.proposals = data.proposals || [];
  renderPublicProposals();
}

async function submitProposal(event) {
  event.preventDefault();
  const button = document.getElementById('submitProposal');
  const message = document.getElementById('formMessage');
  message.className = 'form-message';

  if (!state.user) {
    message.textContent = 'Откройте приложение через @domnekromanta_bot, чтобы отправить заявку.';
    message.classList.add('is-error');
    tg?.showAlert?.('Откройте Mini App через @domnekromanta_bot.');
    return;
  }

  const proposalType = document.getElementById('proposalType').value;
  const payload = {
    proposalType,
    title: document.getElementById('titleInput').value,
    sourceUrl: document.getElementById('sourceUrlInput').value,
    chapterFrom: document.getElementById('chapterFromInput').value,
    chapterTo: document.getElementById('chapterToInput').value,
    comment: document.getElementById('commentInput').value,
  };

  button.disabled = true;
  button.textContent = 'Отправляем…';
  try {
    await api('/api/proposals', { method: 'POST', body: JSON.stringify(payload) });
    message.textContent = 'Заявка отправлена.';
    message.classList.add('is-success');
    tg?.HapticFeedback?.notificationOccurred?.('success');
    event.currentTarget.reset();
    setProposalType('title');
    await refreshProposals();
    window.setTimeout(() => {
      closeProposalModal();
      showView('proposals');
    }, 450);
  } catch (error) {
    message.textContent = error.message;
    message.classList.add('is-error');
    tg?.HapticFeedback?.notificationOccurred?.('error');
  } finally {
    button.disabled = false;
    button.textContent = 'Отправить предложение';
  }
}

function bindUi() {
  document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.nav)));
  document.getElementById('profileButton').addEventListener('click', () => showView('profile'));
  ['openProposalHero', 'openProposalTop', 'openProposalNav'].forEach((id) => document.getElementById(id)?.addEventListener('click', openProposalModal));
  document.getElementById('closeProposal').addEventListener('click', closeProposalModal);
  document.getElementById('proposalModal').addEventListener('click', (event) => {
    if (event.target.id === 'proposalModal') closeProposalModal();
  });
  document.querySelectorAll('.segmented button[data-type]').forEach((button) => button.addEventListener('click', () => setProposalType(button.dataset.type)));
  document.getElementById('proposalForm').addEventListener('submit', submitProposal);
  document.querySelectorAll('.filter-chip[data-filter]').forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('is-active', chip === button));
    renderPublicProposals();
  }));
}

async function bootstrap() {
  bindUi();
  try {
    const data = await api('/api/bootstrap');
    state.user = data.user || null;
    state.isAdmin = Boolean(data.isAdmin);
    state.proposals = data.proposals || [];
    updateProfile();
    renderPublicProposals();
  } catch (error) {
    console.error('Bootstrap failed', error);
    updateProfile();
    renderPublicProposals();
  }
}

void bootstrap();
