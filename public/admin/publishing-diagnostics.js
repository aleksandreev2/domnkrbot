(() => {
  const content = document.getElementById('adminContent');
  if (!content) return;

  function line(label, value, ok = true) {
    const row = document.createElement('div');
    row.className = `diagnostics-row ${ok ? 'ok' : 'error'}`;
    const name = document.createElement('strong');
    name.textContent = label;
    const text = document.createElement('span');
    text.textContent = value;
    row.append(name, text);
    return row;
  }

  function renderResult(result) {
    const host = document.getElementById('publishingDiagnosticsResult');
    if (!host) return;
    host.replaceChildren();

    const storage = result?.checks?.storage || {};
    const target = result?.checks?.telegramTarget || {};
    const upload = result?.checks?.telegramUpload || {};
    host.append(
      line('R2 FILES', storage.ok ? `OK · ${Number(storage.bytes || 0)} байт round-trip` : 'Ошибка', Boolean(storage.ok)),
      line(
        'Telegram channel',
        target.ok
          ? `${target.channelTitle || target.channelUsername || 'канал'} · bot ${target.botStatus || 'verified'}`
          : 'Ошибка проверки канала',
        Boolean(target.ok),
      ),
      line(
        'Discussion group',
        target.discussionReady ? (target.discussionTitle || 'linked group подключена') : 'Не обнаружена / не требуется для текста',
        target.ok && (target.discussionReady || !target.discussionTitle),
      ),
      line(
        'Private Telegram upload',
        upload.ok ? `OK · message #${upload.messageId || '—'}` : 'Ошибка multipart upload',
        Boolean(upload.ok),
      ),
      line('Публикация в канал', result?.channelPublished ? 'Была выполнена' : 'Не выполнялась', result?.channelPublished === false),
    );

    const meta = document.createElement('small');
    meta.className = 'diagnostics-meta';
    meta.textContent = `Self-test: ${result?.ok ? 'PASS' : 'FAIL'} · ${Number(result?.durationMs || 0)} мс`;
    host.append(meta);
  }

  async function runDiagnostics(button) {
    button.disabled = true;
    const previous = button.textContent;
    button.textContent = 'Проверяем…';
    const resultHost = document.getElementById('publishingDiagnosticsResult');
    if (resultHost) resultHost.textContent = 'R2 → Telegram target → private upload…';
    try {
      const response = await fetch('/api/admin/publishing/diagnostics', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw Object.assign(new Error(body?.error || `HTTP ${response.status}`), { result: body });
      renderResult(body);
    } catch (error) {
      if (error?.result) renderResult(error.result);
      const host = document.getElementById('publishingDiagnosticsResult');
      const notice = document.createElement('div');
      notice.className = 'notice error';
      notice.textContent = `Self-test не пройден: ${error instanceof Error ? error.message : String(error)}`;
      host?.prepend(notice);
    } finally {
      button.disabled = false;
      button.textContent = previous;
    }
  }

  function mount() {
    const grid = content.querySelector('.settings-admin-grid');
    if (!grid || document.getElementById('publishingDiagnosticsPanel')) return;

    const panel = document.createElement('section');
    panel.className = 'admin-panel diagnostics-panel';
    panel.id = 'publishingDiagnosticsPanel';
    panel.innerHTML = `
      <div class="admin-panel-head">
        <div>
          <h2>Publishing Self-Test</h2>
          <p>R2, права Telegram и реальный upload — без публикации в канал.</p>
        </div>
      </div>
      <button id="runPublishingDiagnostics" class="admin-save-settings" type="button">Запустить self-test</button>
      <div id="publishingDiagnosticsResult" class="diagnostics-result">Тест ещё не запускался.</div>
    `;
    grid.append(panel);
    panel.querySelector('#runPublishingDiagnostics')?.addEventListener('click', (event) => {
      void runDiagnostics(event.currentTarget);
    });
  }

  const observer = new MutationObserver(mount);
  observer.observe(content, { childList: true, subtree: true });
  mount();
})();
