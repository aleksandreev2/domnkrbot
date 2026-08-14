# Дом Некроманта Bot

Telegram Mini App для команды переводов «Дом Некроманта».

## Что уже есть в MVP

- Cloudflare Worker + D1;
- Telegram webhook;
- `/start`, `/app`, `/propose`, `/help`;
- Telegram Menu Button, открывающий Mini App;
- главная Mini App в фирменном тёмном стиле;
- предложение нового тайтла;
- предложение конкретного диапазона глав;
- публичная очередь предложений сообщества;
- личный список заявок пользователя;
- статусы `Новая → Одобрено → Запланировано → В работе → Готово`;
- скрытая админ-очередь со сменой статусов;
- проверка Telegram Mini App `initData` на сервере;
- существующий read-only RanobeLib sync spike сохранён в `src/integrations/ranobelib` и будет подключён к D1 следующим этапом.

## Рекомендуемый production setup: GitHub → Cloudflare Workers Builds

Для production не нужно вручную запускать `wrangler deploy` после каждого изменения. Подключите репозиторий `aleksandreev2/domnkrbot` к Cloudflare Workers Builds, и Cloudflare будет автоматически собирать и деплоить `main` после каждого push/merge.

### 1. Импортировать GitHub-репозиторий в Cloudflare

Cloudflare Dashboard → **Workers & Pages → Create application → Import a repository**.

Выберите:

```text
aleksandreev2/domnkrbot
```

Production branch:

```text
main
```

Worker name должен быть:

```text
domnkrbot
```

Он уже совпадает с `name` в `wrangler.jsonc`.

D1 binding `DB` описан без `database_id`, поэтому Wrangler/Cloudflare может автоматически provision'ить `domnkrbot-db`. Ручное копирование UUID базы в GitHub не требуется.

### 2. Настроить Workers Builds

В **Settings → Builds** используйте:

Build command:

```bash
npm test
```

Deploy command:

```bash
npm run deploy
```

`npm run deploy` сначала делает TypeScript check, затем применяет неприменённые D1 migrations к remote DB и только после этого запускает `wrangler deploy`.

После этого каждый merge в `main` автоматически обновляет production Worker.

### 3. Добавить Cloudflare secrets

В Worker → **Settings → Variables and Secrets** добавьте encrypted secrets:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
ADMIN_TELEGRAM_IDS
```

`TELEGRAM_BOT_TOKEN` — токен `@domnekromanta_bot` из `@BotFather`.

`TELEGRAM_WEBHOOK_SECRET` — длинная случайная строка.

`ADMIN_TELEGRAM_IDS` — numeric Telegram ID одного или нескольких администраторов через запятую.

Секреты не должны храниться в GitHub.

### 4. Первый deploy

После сохранения Git integration и secrets запустите первый build из Cloudflare или сделайте merge/push в `main`.

Cloudflare выдаст адрес вида:

```text
https://domnkrbot.<account>.workers.dev
```

### 5. Один раз привязать `@domnekromanta_bot`

Webhook и Menu Button Telegram нужно настроить один раз после появления production URL.

Локально:

```bash
npm install
cp .dev.vars.example .dev.vars
```

На Windows можно просто скопировать `.dev.vars.example` в `.dev.vars`.

Заполните:

```text
TELEGRAM_BOT_TOKEN=<тот же токен @domnekromanta_bot>
TELEGRAM_WEBHOOK_SECRET=<тот же webhook secret из Cloudflare>
ADMIN_TELEGRAM_IDS=<numeric Telegram ID админа>
WEBHOOK_URL=https://domnkrbot.<account>.workers.dev
```

Затем:

```bash
npm run configure-bot
```

Скрипт автоматически:

- проверит токен через `getMe`;
- выставит имя **Дом Некроманта**;
- выставит описание;
- добавит команды `/start`, `/app`, `/propose`, `/help`;
- поставит Web App Menu Button;
- зарегистрирует webhook `https://.../telegram/webhook`;
- передаст Telegram webhook secret;
- выведет итоговый `getWebhookInfo`.

После этого отправьте боту `/start` — должна появиться кнопка **«☠️ Открыть Дом Некроманта»**.

## Ручной deploy (только как fallback)

Если Git integration временно отключена:

```bash
npm install
npx wrangler login
npm run deploy
```

## Локальная разработка

Создайте `.dev.vars` и выполните:

```bash
npm run db:local
npm run dev
```

В обычном браузере дизайн Mini App открывается в режиме гостя. Создание заявок доступно только при запуске через Telegram, потому что сервер проверяет подписанный `initData`.

## RanobeLib spike

Существующая интеграция сохранена:

```bash
npm test
npm run sync:ranobelib:spike -- --team 11969--dom-nekromanta --limit 3
```

Следующий этап — перенести snapshot RanobeLib в D1, показывать реальные новые главы и активные переводы на главной и запускать sync через Cloudflare Cron.
