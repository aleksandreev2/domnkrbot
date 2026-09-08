# Text Bot UX v2 Design

## Goal

Improve the Telegram text bot UX so users always understand where they are, what an action will do, and how to go back without losing work. The redesign keeps the existing bot architecture and feature set, but gives proposal flows, notification management, and proposal browsing one consistent navigation model.

The UI must not use the skull emoji as a navigation or branding element. The main menu and system navigation buttons must use neutral labels/icons instead.

## Core UX principles

1. `↩️ Назад` returns to the previous logical screen and does not destroy user data.
2. `🏠 Главное меню` returns to the root menu. It does not delete an unfinished proposal draft.
3. `🗑 Отменить заявку` or `🗑 Удалить черновик` is destructive and must be clearly separated from navigation.
4. Destructive bulk actions, especially `Отключить все`, require confirmation.
5. Inline-button flows should edit the current Telegram message whenever possible instead of creating message spam.
6. New messages are appropriate when Telegram requires user input, such as text search, a custom stack size, a comment, or a RAW file.
7. Errors must provide a recovery action rather than leave the user at a dead end.
8. The same concept must use the same wording throughout the bot.

## Information architecture

```text
/start
│
├── 🔔 Уведомления
│   ├── 📚 Мои подписки
│   │   └── Карточка тайтла
│   │       ├── Включить / отключить
│   │       ├── Режим доставки
│   │       ├── Накоплено X / N
│   │       ├── Читать
│   │       └── Назад
│   ├── 🔎 Найти тайтл
│   │   └── Результаты
│   │       └── Карточка тайтла
│   ├── 📖 Все переводы
│   │   └── Карточка тайтла
│   ├── ⚙️ Режим доставки
│   └── 🏠 Главное меню
│
├── 📚 Предложить новеллу
│   ├── Шаг 1 — Есть на RanobeLib?
│   ├── Шаг 2 — Найти/указать тайтл и источник
│   ├── Шаг 3 — RAW
│   ├── Шаг 4 — Комментарий
│   ├── Шаг 5 — Проверка
│   └── Результат
│
├── 🗂 Мои заявки
│   ├── 🟢 Активные
│   ├── ✅ Завершённые
│   ├── 📋 Все
│   └── Карточка заявки
│
└── 🌐 Сайт
```

## Main menu

The main menu stays intentionally small.

```text
Дом Некроманта

Переводы, уведомления и предложения новых новелл.

[ 🔔 Уведомления ]
[ 📚 Предложить новеллу ]
[ 🗂 Мои заявки ]
[ 🌐 Сайт ]
```

Do not add subscription/proposal counters to `/start` in v2. The root menu should remain fast to scan.

## Navigation model

### Back

`↩️ Назад` returns to the previous logical screen and preserves the current draft or settings.

Examples:
- proposal RAW step -> proposal title confirmation;
- title delivery mode -> title card;
- proposal card -> proposal list;
- notification search results -> notification home/search context.

### Main menu

`🏠 Главное меню` exits the current UI branch and displays the root menu.

If a proposal draft exists, it stays stored. Starting the proposal flow later should offer to continue or delete it.

### Destructive cancellation

`🗑 Отменить заявку` is only used for deleting an unfinished proposal. It must not be used as a generic back-to-menu action.

When the user has already entered meaningful proposal data, destructive cancellation requires a confirmation screen:

```text
Удалить черновик заявки?

Введённые данные будут потеряны.

[ 🗑 Да, удалить ]
[ ↩️ Нет, вернуться ]
```

## Message behavior

### Single-message navigation

Inline navigation should normally use `editMessageText` so one screen evolves in place.

This applies to:
- main menu navigation;
- notification dashboard;
- subscription lists;
- title cards;
- proposal choice/confirmation/review screens;
- proposal lists/cards;
- error/retry screens.

### Input steps

A new bot message is allowed when the user must send text or a file. The prompt must clearly state what input is expected and include navigation controls where Telegram allows it.

After valid input is received, the bot should return the user to the relevant screen instead of leaving a long chain of prompts.

## Notifications UX

### Notification home

```text
🔔 Уведомления

Подписки: 12 тайтлов
Режим по умолчанию: 📦 По 10 глав
Индивидуальные настройки: 2

[ 📚 Мои подписки ]
[ 🔎 Найти тайтл ]
[ 📖 Все переводы ]
[ ⚙️ Режим доставки ]

[ 🏠 Главное меню ]
```

The existing large title catalog must no longer be the notification landing screen.

### My subscriptions

```text
📚 Мои подписки

У вас 12 активных подписок.

[ ✅ Тайтл 1 ]
[ ✅ Тайтл 2 ]
[ ✅ Тайтл 3 ]

[ ◀️ ] [ 1 / 2 ] [ ▶️ ]

[ 🔎 Поиск ]
[ 🔕 Отключить все ]
[ ↩️ Назад ]
```

`Отключить все` opens a confirmation screen before applying the action.

### All translations

The all-titles screen remains paginated. Selecting a title opens its title card; it must not toggle subscription immediately.

### Search

Search is a text-input flow:

```text
🔎 Поиск тайтла

Напишите часть названия.

Например:
Культивация Онлайн

[ ↩️ Назад ]
```

Results should show up to 5–8 relevant titles per page and provide:
- title buttons;
- pagination when needed;
- `🔎 Искать снова`;
- `↩️ Назад`.

### Title card

```text
📚 Культивация Онлайн

Уведомления: ✅ включены
Режим: 📦 По 10
Накоплено: 4 / 10
Общий режим: 📦 По 10

[ 🔕 Отключить ]
[ ⚙️ Изменить режим ]
[ 📖 Читать ]

[ ↩️ Назад ]
[ 🏠 Главное меню ]
```

If the title inherits the global delivery setting:

```text
Режим: ↩️ Как для всех
Общий режим: 📦 По 10
```

If it has an override, show both the effective title mode and the global mode and expose `↩️ Использовать общий режим`.

### Stack progress

For stack modes, show accumulated chapter progress when it can be computed from pending outbox rows:

```text
Накоплено: 4 / 10
```

For instant mode, do not show a stack counter.

### Delivery mode screen

```text
⚙️ Режим доставки

Текущий режим:
📦 По 10 глав

Если за 7 дней стак не заполнится,
бот всё равно отправит накопленные главы.

[ ⚡ Мгновенно ]
[ 📦 5 ] [ 📦 10 ] [ 📦 20 ]
[ ✏️ Свой размер ]

[ ↩️ Назад ]
```

Custom remains 2–100 chapters.

## Proposal flow

### Draft resume

If an unfinished proposal exists and the user opens `📚 Предложить новеллу`, show:

```text
У вас есть незавершённая заявка.

[ 📝 Продолжить ]
[ 🗑 Удалить черновик ]
[ 🏠 Главное меню ]
```

A draft must not be deleted just because the user returned to the main menu.

### Progress header

Every proposal phase shows progress and context.

The user-facing wizard always has five phases:
1. RanobeLib availability;
2. identify the title/source;
3. RAW;
4. comment;
5. review.

The external branch may use more than one text prompt inside phase 2 (title and source URL), but it must still display `Шаг 2 из 5` until title/source identification is complete. This keeps the progress indicator stable across both branches.

Example:

```text
📚 Предложить новеллу
Шаг 2 из 5

Пришлите ссылку на RanobeLib или название новеллы.
```

### Step 1 — RanobeLib availability

```text
📚 Предложить новеллу
Шаг 1 из 5

Есть ли новелла на RanobeLib?

[ ✅ Да, есть ]
[ ❌ Нет ]

[ 🏠 Главное меню ]
```

### RanobeLib search

Accept either a RanobeLib URL or title text.

Search results should show no more than 5–6 titles at once and support pagination/retry.

```text
🔎 Найдено несколько вариантов

Выберите нужный тайтл:

[ Тайтл 1 ]
[ Тайтл 2 ]
[ Тайтл 3 ]

[ 🔎 Другой запрос ]
[ ↩️ Назад ]
```

### RanobeLib confirmation

Only show information that helps identify the title:
- display title;
- translation/status label when available;
- uploaded chapter count;
- latest chapter;
- team/translator names when available;
- RanobeLib link.

Do not show the current `Иммунитет: не удалось определить автоматически` placeholder in v2.

```text
📚 Название тайтла

Статус: продолжается
Глав загружено: 214
Последняя глава: 214
Переводчик: Дом Некроманта

Это нужный тайтл?

[ ✅ Да, продолжить ]
[ 🔎 Искать другой ]
[ ↩️ Назад ]
```

### External title branch

For titles not on RanobeLib, phase 2 collects:
1. title;
2. source URL;
3. then proceeds to phase 3 (RAW).

Both text prompts remain part of `Шаг 2 из 5`.

Each input step must offer `↩️ Назад`, `🏠 Главное меню`, and destructive cancellation where appropriate.

### RAW

```text
📚 Предложить новеллу
Шаг 3 из 5

RAW

Если у вас есть оригинал новеллы — отправьте файл сюда.
Поддерживается до 20 МБ.

[ ⏭ Пропустить ]
[ ↩️ Назад ]
[ 🗑 Отменить заявку ]
```

After upload:

```text
✅ RAW добавлен

📎 novel_raw.zip
Размер: 14.3 МБ

[ Продолжить ]
[ 🔄 Заменить файл ]
[ ↩️ Назад ]
```

### Comment

```text
📚 Предложить новеллу
Шаг 4 из 5

Комментарий

Хотите что-нибудь добавить для команды?

Например:
«Есть полный RAW»
«Очень хочется этот тайтл»

[ ⏭ Без комментария ]
[ ↩️ Назад ]
```

### Review

The review screen must support field-level editing instead of a single generic `Изменить` action.

```text
📚 Проверка заявки
Шаг 5 из 5

Тайтл:
Название

RanobeLib:
✅ Есть

Источник:
https://...

RAW:
📎 novel.zip

Комментарий:
...

Всё верно?

[ 📨 Отправить ]

[ ✏️ Название ]
[ ✏️ Источник ]
[ ✏️ RAW ]
[ ✏️ Комментарий ]

[ ↩️ Назад ]
[ 🗑 Отменить заявку ]
```

Editing one field must return to the review screen when completed; it must not force the user through the entire wizard again.

### Duplicate proposal

If the title already has an active proposal, explain what supporting it does.

```text
ℹ️ Этот тайтл уже предлагали

Название

Статус:
🟡 На рассмотрении

Поддержали: 17 человек

Можно добавить свой голос — это показывает команде интерес к тайтлу.

[ 👍 Поддержать ]
[ 👁 Посмотреть заявку ]
[ 🏠 Главное меню ]
```

### Success

```text
✅ Заявка отправлена

Название

Статус:
🟡 На рассмотрении

Мы сообщим, если статус изменится.

[ 👁 Посмотреть заявку ]
[ ➕ Предложить ещё ]
[ 🏠 Главное меню ]
```

## My proposals UX

### Landing

```text
🗂 Мои заявки

[ 🟢 Активные — 3 ]
[ ✅ Завершённые — 12 ]
[ 📋 Все — 15 ]

[ 🏠 Главное меню ]
```

### Filtered list

Each row should include a short status marker plus a truncated title.

```text
🗂 Активные заявки

[ 🟡 Я стал мидбоссом ]
[ 🔵 Маг в академии ]
[ 🟢 Культиватор онлайн ]

[ ◀️ ] [ 1 / 2 ] [ ▶️ ]
[ ↩️ Назад ]
```

### Proposal card

Show:
- title;
- localized status;
- supporter count;
- source;
- own proposal comment;
- admin/team note when visible to the submitter;
- created/updated date where available.

Buttons:
- source link when available;
- support button for another user's active proposal;
- `↩️ К списку`;
- `🏠 Главное меню`.

## Error recovery

Errors should be represented as actionable screens when possible.

Example RanobeLib failure:

```text
⚠️ RanobeLib сейчас не отвечает

Ваш черновик сохранён.

[ 🔄 Повторить ]
[ ✏️ Изменить запрос ]
[ ↩️ Назад ]
[ 🏠 Главное меню ]
```

Expired proposal session:

```text
⌛ Черновик устарел

Прошло слишком много времени, поэтому заявку нужно начать заново.

[ 📚 Начать заново ]
[ 🏠 Главное меню ]
```

Unexpected internal errors should give the user a short generic message and a stable way back to a known screen. Internal details remain in logs, not in Telegram text.

## Callback/navigation structure

Use explicit semantic callback namespaces rather than overloading destructive callbacks for navigation.

Recommended shape:

```text
menu:home

notify:home
notify:mine:<page>
notify:all:<page>
notify:search
notify:title:<id>:<origin>
notify:title:mode:<id>
notify:global:mode
notify:disable-all:confirm

proposal:home
proposal:resume
proposal:source
proposal:search
proposal:pick:<index>
proposal:confirm
proposal:raw
proposal:comment
proposal:review
proposal:edit:<field>
proposal:cancel:confirm
proposal:submitted:<id>

proposals:home
proposals:list:<filter>:<page>
proposals:view:<id>:<filter>:<page>
```

All callback formats currently emitted by production must remain accepted throughout the UX v2 rollout. They may be routed to the nearest equivalent v2 screen. Removing legacy callback support is a separate cleanup task after the rollout and is not part of this implementation.

New screens must not continue to overload `prop:cancel` as both navigation and destructive cancellation.

## State model

### Proposal drafts

Continue using durable D1 proposal-session state. Extend it only where needed for:
- previous logical step/back navigation;
- field-specific review editing;
- safe resume after returning to the main menu.

Do not introduce an in-memory-only wizard state.

### Temporary text input

Text-input states such as notification search or field editing need explicit short-lived state so random user messages are not accidentally consumed.

Reuse an existing generic pending-action mechanism if the repository has one; otherwise introduce one small generic Telegram input-state table rather than a separate table per UX flow.

### Screen origin

Where `Назад` can return to more than one screen, preserve a small origin identifier in callback data or server-side state. Avoid reconstructing navigation by guessing from current data.

## Compatibility and migration

- Existing users keep all subscriptions, delivery modes, title overrides, proposals, votes, and notification outbox state.
- UX v2 is a presentation/navigation redesign; it must not reset user data.
- Existing notification delivery behavior remains unchanged except where UI explicitly changes configuration.
- Old callback buttons in already-sent Telegram messages remain supported during the entire v2 rollout.

## Analytics

Add lightweight event counters only for major funnel transitions, not full behavioral tracking.

Useful events:
- main menu -> proposal start;
- proposal source selected;
- proposal title identified;
- proposal reached review;
- proposal submitted;
- notifications opened;
- notification search used;
- title card opened;
- subscription enabled/disabled.

The purpose is to identify UX drop-off points. Analytics must not block user actions when logging fails.

## Implementation order

The implementation should be split into coherent stages while preserving working production behavior after each merge:

1. Navigation primitives and new root menu semantics.
2. Proposal wizard navigation/resume/field editing.
3. Notification dashboard, search, title cards, and stack progress.
4. My-proposals filters/cards and error recovery polish.
5. Lightweight UX analytics and compatibility cleanup.

Each stage must have tests for callbacks, state transitions, destructive-action confirmation, and legacy callback compatibility before merging.

## Testing requirements

At minimum, cover:

### Navigation
- Back preserves state.
- Main menu preserves proposal draft.
- Destructive cancel requires confirmation and deletes only after confirmation.
- Legacy navigation callbacks do not accidentally delete a draft.

### Proposal wizard
- Resume existing draft.
- Delete draft confirmation.
- Back from every step.
- RanobeLib direct URL path.
- RanobeLib search path and pagination.
- External title path.
- RAW upload/skip/replace.
- Comment input/skip.
- Edit individual review fields and return to review.
- Duplicate/support flow.
- Success actions.
- Session-expired recovery.

### Notifications
- Notification home dashboard.
- My subscriptions/all/search pagination.
- Search input state and invalid/no-match handling.
- Title card opens without toggling subscription.
- Enable/disable from card.
- Global and per-title delivery-mode navigation.
- Stack progress calculation.
- Disable-all confirmation.
- Old `subs:*` callbacks remain functional or are intentionally aliased.

### My proposals
- Active/completed/all filters.
- Proposal card -> list back navigation preserves filter/page.
- Visibility rules for admin note/support action.

### Error handling
- RanobeLib outage gives retry path.
- Telegram edit failure falls back safely where appropriate.
- Analytics failure does not break the user action.

## Out of scope for UX v2

- Replacing the Telegram bot with a Web App.
- Rebuilding the admin panel.
- Changing translation/proposal business rules unrelated to UX.
- Adding recommendation algorithms.
- Adding user profiles, achievements, or gamification.
- Changing notification delivery semantics already implemented in the stack/instant feature.
