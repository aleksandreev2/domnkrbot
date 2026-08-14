(() => {
  const tg = window.Telegram?.WebApp;

  const emptyIconMap = new Map([
    ['◇', 'sparkles'],
    ['＋', 'plus'],
    ['↗', 'external-link'],
    ['↻', 'refresh-cw'],
    ['⌁', 'library'],
    ['!', 'triangle-alert'],
    ['✓', 'check'],
    ['○', 'user-round'],
  ]);

  const adminStatusIcons = {
    approved: 'circle-check',
    planned: 'calendar-clock',
    in_progress: 'play',
    done: 'circle-check-big',
    rejected: 'circle-x',
  };

  function applyTelegramTheme() {
    if (!tg) return;
    try { tg.setHeaderColor('#fcfbf8'); } catch {}
    try { tg.setBackgroundColor('#fcfbf8'); } catch {}
  }

  function icon(name, className = '') {
    const node = document.createElement('i');
    node.setAttribute('data-lucide', name);
    node.setAttribute('aria-hidden', 'true');
    if (className) node.className = className;
    return node;
  }

  function replaceExact(el, name) {
    if (!el || el.querySelector('svg,[data-lucide]')) return;
    el.textContent = '';
    el.append(icon(name));
  }

  function replaceTrailingArrow(el) {
    if (!el || el.querySelector('svg,[data-lucide]')) return;
    const text = (el.textContent || '').trim();
    if (!text.endsWith('↗')) return;
    el.textContent = `${text.slice(0, -1).trim()} `;
    el.append(icon('external-link', 'inline-icon'));
  }

  function upgradeGeneratedUi() {
    applyTelegramTheme();

    document.querySelectorAll('.empty-icon').forEach((el) => {
      const name = emptyIconMap.get((el.textContent || '').trim());
      if (name) replaceExact(el, name);
    });

    document.querySelectorAll('.vote-arrow').forEach((el) => replaceExact(el, 'heart'));
    document.querySelectorAll('.card-arrow').forEach((el) => replaceExact(el, 'external-link'));
    document.querySelectorAll('.community-source,.proposal-link').forEach(replaceTrailingArrow);

    document.querySelectorAll('.admin-status-button[data-admin-status]').forEach((button) => {
      if (button.querySelector('.admin-action-icon,svg,[data-lucide]')) return;
      const name = adminStatusIcons[button.dataset.adminStatus];
      if (!name) return;
      button.prepend(icon(name, 'admin-action-icon'));
    });

    document.querySelectorAll('.admin-metric').forEach((metric) => {
      if (metric.querySelector('.metric-icon')) return;
      const label = (metric.textContent || '').toLowerCase();
      let name = 'activity';
      if (label.includes('голос')) name = 'heart';
      else if (label.includes('польз')) name = 'users';
      else if (label.includes('нов')) name = 'inbox';
      else if (label.includes('работ')) name = 'play';
      else if (label.includes('готов')) name = 'circle-check';
      metric.prepend(icon(name, 'metric-icon'));
    });

    window.lucide?.createIcons?.({ attrs: { 'stroke-width': 1.8, 'aria-hidden': 'true' } });
  }

  let scheduled = false;
  function scheduleUpgrade() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      upgradeGeneratedUi();
    });
  }

  upgradeGeneratedUi();
  new MutationObserver(scheduleUpgrade).observe(document.body, { childList: true, subtree: true });
})();
