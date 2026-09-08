import {
  backButton,
  destructiveButton,
  mainMenuButton,
  type TelegramButton,
  type TelegramPayload,
} from './telegram-bot-ui.js';

export type ProposalUiSession = {
  step: string;
  source_kind: string | null;
  ranobelib_book_ref: string | null;
  title: string;
  original_title: string;
  source_url: string;
  raw_file_id: string | null;
  raw_file_name: string | null;
  raw_file_size: number | string | null;
  comment: string;
  return_to_review: number | string | null;
};

export type ProposalCandidateUi = { index: number; title: string };

export type RanobeLibConfirmationUi = {
  title: string;
  url: string;
  status: string;
  teamNames: string[];
  uploaded: number;
  latestNumber: string;
  latestName: string | null;
};

export function proposalPhase(step: string): 1 | 2 | 3 | 4 | 5 {
  if (step === 'choose_source') return 1;
  if (step === 'raw') return 3;
  if (step === 'comment') return 4;
  if (step === 'review') return 5;
  return 2;
}

function header(title: string, phase: number): string[] {
  return [`📚 <b>${escapeHtml(title)}</b>`, `Шаг ${phase} из 5`, ''];
}

function proposalNav(options: { back?: boolean; cancel?: boolean; home?: boolean } = {}): TelegramButton[][] {
  const rows: TelegramButton[][] = [];
  if (options.back) rows.push([backButton('prop:back')]);
  if (options.cancel) rows.push([destructiveButton('🗑 Отменить заявку', 'prop:cancel')]);
  if (options.home !== false) rows.push([mainMenuButton()]);
  return rows;
}

export function buildProposalSourceChoice(): TelegramPayload {
  return {
    text: [...header('Предложить новеллу', 1), 'Есть ли новелла на RanobeLib?'].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Да, есть', callback_data: 'prop:source:ranobelib' }],
        [{ text: '❌ Нет', callback_data: 'prop:source:external' }],
        [mainMenuButton()],
      ],
    },
  };
}

export function buildProposalResume(session: ProposalUiSession): TelegramPayload {
  const context = session.title.trim() ? `\n\nТайтл: <b>${escapeHtml(session.title)}</b>` : '';
  return {
    text: `<b>У вас есть незавершённая заявка.</b>${context}\n\nПродолжить с сохранённого места?`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📝 Продолжить', callback_data: 'prop:resume' }],
        [destructiveButton('🗑 Удалить черновик', 'prop:cancel')],
        [mainMenuButton()],
      ],
    },
  };
}

export function buildProposalDeleteConfirmation(): TelegramPayload {
  return {
    text: '<b>Удалить черновик заявки?</b>\n\nВведённые данные будут потеряны.',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [destructiveButton('🗑 Да, удалить', 'prop:cancel:confirm')],
        [{ text: '↩️ Нет, вернуться', callback_data: 'prop:cancel:keep' }],
      ],
    },
  };
}

export function buildProposalInputPrompt(step: string, session: ProposalUiSession): TelegramPayload {
  let body = 'Продолжите заполнение заявки.';
  if (step === 'ranobelib_query') {
    body = 'Пришлите ссылку на карточку RanobeLib или напишите название новеллы.';
  } else if (step === 'external_title') {
    body = 'Напишите название новеллы.';
  } else if (step === 'external_url') {
    body = `Тайтл: <b>${escapeHtml(session.title || '—')}</b>\n\nПришлите HTTP(S)-ссылку на оригинальный источник.`;
  }
  return {
    text: [...header('Предложить новеллу', proposalPhase(step)), body].join('\n'),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: proposalNav({ back: true, cancel: true }) },
  };
}

export function buildProposalRawPrompt(_session: ProposalUiSession): TelegramPayload {
  return {
    text: [
      ...header('Предложить новеллу', 3),
      '<b>RAW</b>',
      '',
      'Если у вас есть оригинал новеллы — отправьте файл сюда.',
      'Поддерживается документ до 20 МБ. Ссылку вместо файла бот не принимает.',
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '⏭ Пропустить', callback_data: 'prop:raw:skip' }],
        ...proposalNav({ back: true, cancel: true }),
      ],
    },
  };
}

export function buildProposalRawAdded(session: ProposalUiSession): TelegramPayload {
  return {
    text: [
      '✅ <b>RAW добавлен</b>',
      '',
      `📎 ${escapeHtml(session.raw_file_name || 'файл')}`,
      `Размер: ${formatFileSize(session.raw_file_size)}`,
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Продолжить', callback_data: 'prop:raw:continue' }],
        [{ text: '🔄 Заменить файл', callback_data: 'prop:raw:replace' }],
        [backButton('prop:back')],
        [mainMenuButton()],
      ],
    },
  };
}

export function buildProposalCommentPrompt(_session: ProposalUiSession): TelegramPayload {
  return {
    text: [
      ...header('Предложить новеллу', 4),
      '<b>Комментарий</b>',
      '',
      'Хотите что-нибудь добавить для команды?',
      '',
      'Например: «Есть полный RAW» или «Очень хочется этот тайтл».',
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '⏭ Без комментария', callback_data: 'prop:comment:skip' }],
        ...proposalNav({ back: true, cancel: true }),
      ],
    },
  };
}

export function buildProposalReview(session: ProposalUiSession): TelegramPayload {
  const hasRanobeLib = session.source_kind === 'ranobelib';
  return {
    text: [
      '📚 <b>Проверка заявки</b>',
      'Шаг 5 из 5',
      '',
      `Тайтл: <b>${escapeHtml(session.title || '—')}</b>`,
      `RanobeLib: ${hasRanobeLib ? '✅ Есть' : '❌ Нет'}`,
      `${hasRanobeLib ? 'Карточка' : 'Источник'}: ${escapeHtml(session.source_url || '—')}`,
      `RAW: ${session.raw_file_id ? `📎 ${escapeHtml(session.raw_file_name || 'файл')}` : 'нет'}`,
      `Комментарий: ${escapeHtml(session.comment || 'без комментария')}`,
      '',
      'Всё верно?',
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📨 Отправить', callback_data: 'prop:submit' }],
        [{ text: '✏️ Изменить', callback_data: 'prop:edit' }],
        ...proposalNav({ back: true, cancel: true }),
      ],
    },
  };
}

export function buildProposalRanobeLibCandidates(
  candidates: ProposalCandidateUi[],
  page = 0,
  totalPages = 1,
): TelegramPayload {
  const rows: TelegramButton[][] = candidates.slice(0, 6).map((candidate) => [{
    text: candidate.title.slice(0, 60),
    callback_data: `prop:pick:${candidate.index}`,
  }]);
  if (totalPages > 1) {
    const nav: TelegramButton[] = [];
    if (page > 0) nav.push({ text: '◀️', callback_data: `prop:results:${page - 1}` });
    nav.push({ text: `${page + 1} / ${totalPages}`, callback_data: 'prop:noop' });
    if (page + 1 < totalPages) nav.push({ text: '▶️', callback_data: `prop:results:${page + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: '🔎 Другой запрос', callback_data: 'prop:query:again' }]);
  rows.push([backButton('prop:back')]);
  rows.push([mainMenuButton()]);
  return {
    text: '<b>🔎 Найдено несколько вариантов</b>\n\nВыберите нужный тайтл:',
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  };
}

export function buildProposalRanobeLibConfirmation(detail: RanobeLibConfirmationUi): TelegramPayload {
  const latest = detail.latestName
    ? `${detail.latestNumber} — ${detail.latestName}`
    : detail.latestNumber;
  return {
    text: [
      `📚 <b>${escapeHtml(detail.title)}</b>`,
      '',
      `Статус: ${escapeHtml(detail.status || 'неизвестно')}`,
      `Глав загружено: ${escapeHtml(detail.uploaded)}`,
      `Последняя глава: ${escapeHtml(latest || '—')}`,
      `Переводчик: ${escapeHtml(detail.teamNames.length ? detail.teamNames.join(', ') : 'не указан')}`,
      `RanobeLib: ${escapeHtml(detail.url)}`,
      '',
      'Это нужный тайтл?',
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Да, продолжить', callback_data: 'prop:confirm' }],
        [{ text: '🔎 Искать другой', callback_data: 'prop:query:again' }],
        [backButton('prop:back')],
        [mainMenuButton()],
      ],
    },
  };
}

export function formatFileSize(value: number | string | null): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'неизвестно';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] ?? char));
}
