# Дом Некроманта

Обычный web-сайт + Telegram-бот + web-админка для команды переводов «Дом Некроманта».

Telegram Mini App больше не является частью runtime: сайт открывается как обычный HTTPS URL, а Telegram используется для входа, webhook бота, уведомлений, доставки публикаций и предложений новелл на перевод.

## Архитектура

- Cloudflare Worker — API, Telegram webhook и серверная авторизация;
- Workers Static Assets — публичный сайт `/` и админка `/admin/`;
- D1 — пользователи, заявки, состояния Telegram-мастера, RanobeLib snapshot, публикации и metadata файлов;
- R2 binding `FILES` — изображения, файлы публикаций и RAW заявок;
- Cloudflare Queue — быстрый wake-up доставки уведомлений о новых главах;
- Telegram Login Widget — вход на обычном сайте;
- RanobeLib — demand-aware HOT scanner + медленный IDLE scanner + отдельный team discovery + ручной sync из админки.

## Telegram-бот

`/start` открывает главное меню бота. Основные команды:

- `/propose` — предложить новеллу на перевод;
- `/subscriptions` — выбрать уведомления по переводам;
- `/notifications` — настройки уведомлений;
- `/site` — открыть обычный web-сайт;
- `/help` — помощь.

Мастер предложения новеллы полностью работает в Telegram и предлагает два пути:

1. **Есть на RanobeLib** — пользователь отправляет название или ссылку, бот ищет произведение в глобальном каталоге RanobeLib и просит подтвердить найденную карточку.
2. **Нет на RanobeLib** — пользователь вводит название и ссылку на оригинальный источник.

После выбора источника можно приложить RAW именно как Telegram-документ. Поддерживаются `.zip`, `.rar`, `.7z`, `.tar`, `.gz`, `.tgz`, `.txt`, `.md`, `.rtf`, `.pdf`, `.epub`, `.doc`, `.docx`; лимит Telegram-мастера — 20 MiB. RAW не подменяется URL: файл можно приложить либо явно пропустить.

Незавершённый мастер хранится серверно и может быть продолжен после следующего сообщения. Активные дубликаты не создаются повторно: существующую заявку можно поддержать голосом. Через `🗂 Мои заявки` пользователь видит свои последние предложения и их статусы.

Сайт при этом остаётся доступен и существующий web-flow заявок продолжает работать.

### Text bot UX v2

Навигация в Telegram разделяет `↩️ Назад`, `🏠 Главное меню` и разрушительные действия. Черновик заявки хранится серверно: его можно возобновить, выйти в главное меню без удаления, вернуться назад по шагам, редактировать отдельные поля на экране проверки, а удаление требует отдельного подтверждения.

`/notifications` открывает компактный dashboard уведомлений. Из него доступны «Мои подписки», поиск по локальному готовому каталогу, все переводы и глобальный режим доставки. Поиск уведомлений работает только по D1, возвращает до 8 результатов на страницу и сохраняет страницу результатов при возврате из карточки тайтла.

Карточка тайтла показывает, включены ли уведомления, эффективный режим и индивидуальную настройку. Доставка может быть мгновенной или стаками по 5/10/20/кастомному размеру 2–100 глав. Для стакового режима карточка показывает накопленный прогресс, например `4 / 10`; при достижении или переполнении порога отправляется весь накопленный пакет, а неполный стак страхуется 7-дневным flush.

## Telegram Notifications v3 / Paid demand-aware scheduler

D1 хранит не только подписки и outbox, но и рассчитанный спрос на каждый тайтл. Инициализированный тайтл с хотя бы одним достижимым effective subscriber считается **HOT**; тайтл без достижимых подписчиков — **IDLE**. Пользователь с отсутствующей reachability-записью считается достижимым для обратной совместимости, а Telegram `403` переводит его в `blocked`. Новое приватное взаимодействие с меню/колбэками подписок снова делает пользователя достижимым.

Jobs разделены на пять независимых cron invocation:

- `* * * * *` — HOT fast scanner: выбирает не более 24 due-title и опрашивает RanobeLib с concurrency не выше 4. Инициализированные тайтлы с `notification_subscriber_count = 0` сюда не попадают; новые `snapshot_ready = 0` допускаются даже без подписчиков для быстрого bootstrap. Успешный HOT scheduler использует лестницу 1 / 2 / 5 / 10 / 30 минут, а ошибки — 5 / 10 / 20 / 30 минут;
- `17 */3 * * *` — IDLE scanner: до 24 активных инициализированных тайтлов с нулевым спросом, после успешной проверки следующий проход назначается через 180 минут;
- `*/30 * * * *` — team discovery: обновляет состав тайтлов команды без обхода глав всех книг и в том же bounded upsert рассчитывает текущий effective demand;
- `*/5 * * * *` — fallback delivery: независимо дренирует pending/retry строки из D1 outbox;
- `0 * * * *` — membership reconciliation: проверяет ограниченную пачку до 40 известных пользователей канала.

Переход спроса `0 → positive` немедленно выставляет тайтлу `next_check_at = CURRENT_TIMESTAMP` и поднимает приоритет. Переход `positive → 0` переводит его на 180-минутную IDLE cadence. Поэтому если все инициализированные тайтлы никому не нужны, минутный cron делает только D1 selection и не отправляет запросы к RanobeLib.

D1 outbox — источник истины (source of truth) для состояния доставки. Queue не хранит состояние уведомления: сообщение в `NOTIFICATION_QUEUE` только будит consumer после создания релиза. Если Queue недоступна или отправка wake-up завершается ошибкой, уведомления не теряются: pending строки остаются в D1 и будут подобраны пяти-минутным fallback cron.

Delivery engine берёт до 20 адресатов одним eligibility query и отправляет в Telegram максимум 5 запросов одновременно. Reachability всех успешных/403 исходов одного drain сохраняется одним JSON D1 write. `403` помечает адресата как blocked и после batch вызывает один пересчёт demand; `429` переносит повтор на Telegram `retry_after`, остальные временные ошибки остаются в retry-состоянии и не меняют reachability.

Queue настроена в `wrangler.jsonc`:

- binding producer: `NOTIFICATION_QUEUE`;
- queue: `domnkrbot-notifications-v3`;
- consumer batch: 1 сообщение;
- consumer concurrency: 1 invocation;
- Queue-сообщение содержит только `{ kind: "drain" }` и может быть продублировано без потери корректности, потому что фактический статус хранится в D1.

Перед первым production deploy Queue должна существовать в том же Cloudflare account:

```bash
npx wrangler queues create domnkrbot-notifications-v3
```

Новый тайтл после discovery получает первый chapter snapshot через HOT scanner. Bootstrap не создаёт релиз из всей исторической главы книги и не делает сотни отдельных D1 round-trip: массовый snapshot записывается одним JSON-expansion statement.

## Публичный сайт

На `/` доступны:

- свежие релизы RanobeLib;
- статистика каталога;
- предложения сообщества;
- Telegram Login;
- создание заявки и голосование после входа.

Сервер создаёт подписанную `HttpOnly; Secure; SameSite=Lax` session cookie после проверки Telegram Login payload. Администратор определяется только сервером по `ADMIN_TELEGRAM_IDS`.

## Админка

`/admin/` использует интерфейс и publishing workflow, адаптированные из `dollartlbot`:

- обзор и метрики;
- единая очередь заявок с вкладками `Новые / Одобрено / В плане / В работе / Закрытые`;
- фильтры заявок по наличию RanobeLib и поиск по названию;
- детальная панель заявки с пользователем, голосами, RAW, ссылками и комментариями;
- глобальный поиск RanobeLib для внешней заявки и привязка найденной карточки без пересоздания заявки;
- смена статуса с уведомлением автора заявки в Telegram для рабочих/финальных статусов;
- Publishing Center;
- автосохранение рабочего черновика;
- встроенные и пользовательские шаблоны;
- preflight перед созданием публикации;
- изображение + до 8 файлов;
- тестовая отправка администратору;
- публикация в Telegram-канал;
- отправка файлов в linked discussion group после automatic forward поста;
- список и скачивание сохранённых файлов;
- настройки канала/discussion group;
- ручной RanobeLib sync.

## Переменные и secrets

Скопируйте `.dev.vars.example` в `.dev.vars` для локальной разработки:

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
ADMIN_TELEGRAM_IDS=
WEBHOOK_URL=https://domnkrbot.<account>.workers.dev
```

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` и `ADMIN_TELEGRAM_IDS` не коммитить в git.

`BOT_USERNAME` и RanobeLib config находятся в `wrangler.jsonc` как обычные non-secret vars.

## Telegram Login и BotFather

После появления production HTTPS domain:

1. в `@BotFather` используйте `/setdomain` и привяжите домен сайта к `@domnekromanta_bot`;
2. настройте secrets Worker;
3. выполните `npm run configure-bot` с тем же production `WEBHOOK_URL`.

`configure-bot`:

- настраивает имя/описание и команды `/start`, `/propose`, `/subscriptions`, `/notifications`, `/site`, `/help`;
- сбрасывает старый Web App menu button в обычное меню команд;
- устанавливает webhook с `secret_token` и updates `message`, `callback_query`, `chat_member`.

## R2 для публикаций и RAW

Код файлового workflow работает через binding `FILES`, но repository намеренно не содержит выдуманного production bucket name.

Создайте или выберите отдельный R2 bucket для этого проекта, затем добавьте binding в `wrangler.jsonc`:

```jsonc
"r2_buckets": [
  {
    "binding": "FILES",
    "bucket_name": "<your-domnkrbot-files-bucket>"
  }
]
```

После изменения bindings выполните актуальную генерацию Wrangler types, если проект начинает использовать generated Env types.

Пока `FILES` отсутствует:

- сайт и D1-функции работают;
- текстовые publication drafts работают;
- админка показывает storage как not configured;
- backend отклоняет загрузку бинарных вложений вместо записи их в D1;
- Telegram-заявка без RAW остаётся возможной, но прикреплённый RAW никогда не отбрасывается молча.

## D1 migrations

Telegram-предложения добавляются forward-only миграцией:

```text
migrations/0013_telegram_title_proposals.sql
```

Notifications v3 scheduler/claim lease добавляется forward-only миграцией:

```text
migrations/0014_telegram_notifications_v3.sql
```

Paid demand-aware state добавляется следующей forward-only миграцией:

```text
migrations/0015_paid_backend_demand_aware.sql
```

Режимы доставки уведомлений и индивидуальные настройки тайтлов добавляются forward-only миграцией:

```text
migrations/0016_telegram_notification_delivery_modes.sql
```

Состояния поиска уведомлений и совместимость Text bot UX v2 добавляются forward-only миграцией:

```text
migrations/0017_telegram_text_bot_ux_v2.sql
```

`0015` добавляет `notification_subscriber_count`, `subscriber_count_updated_at`, таблицу `telegram_delivery_reachability`, индексы и начальный пересчёт effective demand. Последующие `0016`/`0017` расширяют настройки и UX-состояния без удаления существующих таблиц/подписок и без отката схемы назад.

Безопасный локальный порядок:

```bash
npm install
npm run db:local
npm run typecheck
npm test
```

Remote migration не применять до успешных local checks и проверки target environment.

## Локальный запуск

```bash
npm install
npm run db:local
npm run dev
```

Публичные данные можно смотреть сразу. Для реального Telegram Login нужен HTTPS domain, привязанный к боту через BotFather.

## Production

Перед production rollout:

```bash
npm run typecheck
npm test
npm run build:runtime-test
npx wrangler deploy --dry-run
```

Перед rollout demand-aware scheduler отдельно убедитесь, что Queue `domnkrbot-notifications-v3` уже создана, migration `0015_paid_backend_demand_aware.sql` применена к правильной production D1, а Worker действительно работает на оплачиваемом Workers plan, для которого рассчитан HOT batch 24.

После deploy проверить:

- `/api/health`;
- `/` и `/admin/`;
- Telegram Login;
- admin authorization / negative access;
- `/start`, `/propose`, `/subscriptions`, `/notifications` и webhook secret validation;
- оба пути предложения новеллы: RanobeLib и внешний источник;
- RAW upload/persist и повторное открытие заявки;
- admin RanobeLib search/link и конфликт активного дубликата;
- уведомление автора после смены статуса заявки;
- HOT scanner: `notification_subscriber_count > 0`, свежий `last_synced_at` и движение `next_check_at`;
- zero-demand тайтлы не вызывают минутный RanobeLib polling и обслуживаются IDLE cron;
- подписка на спящий тайтл переводит demand `0 → positive` и будит его на ближайший минутный scan;
- Telegram `403` создаёт blocked reachability и уменьшает effective demand, а новое приватное взаимодействие с subscriptions возвращает active;
- Queue wake-up и доставка нового релиза;
- пяти-минутный fallback из D1 при недоступной Queue;
- RanobeLib team discovery;
- hourly membership reconciliation;
- RanobeLib read/manual sync;
- publication test/publish;
- image/file upload/download и discussion delivery, если `FILES` подключён;
- Worker logs без token/session leakage.

Worker rollback не откатывает D1/R2 data.