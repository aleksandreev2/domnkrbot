# Дом Некроманта

Обычный web-сайт + Telegram-бот + web-админка для команды переводов «Дом Некроманта».

Telegram Mini App больше не является частью runtime: сайт открывается как обычный HTTPS URL, а Telegram используется для входа, webhook бота и доставки публикаций.

## Архитектура

- Cloudflare Worker — API, Telegram webhook и серверная авторизация;
- Workers Static Assets — публичный сайт `/` и админка `/admin/`;
- D1 — пользователи, заявки, RanobeLib snapshot, публикации и metadata файлов;
- R2 binding `FILES` — изображения и файлы публикаций (опционально до настройки bucket);
- Telegram Login Widget — вход на обычном сайте;
- RanobeLib sync — Cron + ручной запуск из админки.

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
- заявки и смена статусов;
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

## Telegram Login для сайта

После появления production HTTPS domain:

1. в `@BotFather` используйте `/setdomain` и привяжите домен сайта к `@domnekromanta_bot`;
2. настройте secrets Worker;
3. выполните `npm run configure-bot` с тем же production `WEBHOOK_URL`.

`configure-bot`:

- настраивает имя/описание и команды `/start`, `/site`, `/propose`, `/help`;
- сбрасывает старый Web App menu button в обычное меню;
- устанавливает webhook с `secret_token`.

## R2 для публикаций и файлов

Код файлового workflow уже работает через binding `FILES`, но repository намеренно не содержит выдуманного production bucket name.

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
- backend отклоняет загрузку бинарных вложений вместо записи их в D1.

## D1 migration

Новая схема публикаций находится в:

```text
migrations/0004_web_admin_publishing.sql
```

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
npx wrangler deploy --dry-run
```

Затем отдельно проверить pending D1 migrations, применить migration к правильной DB и только потом deploy согласно совместимости текущей schema/code.

После deploy проверить:

- `/api/health`;
- `/` и `/admin/`;
- Telegram Login;
- admin authorization / negative access;
- `/start` и webhook secret validation;
- RanobeLib read/sync;
- publication test/publish;
- image/file upload/download и discussion delivery, если `FILES` подключён;
- Worker logs без token/session leakage.

Worker rollback не откатывает D1/R2 data.
