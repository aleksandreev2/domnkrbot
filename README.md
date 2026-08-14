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

## Первый запуск с нуля

### 1. Установить зависимости

```bash
npm install
```

### 2. Войти в Cloudflare

```bash
npx wrangler login
npx wrangler whoami
```

### 3. Создать D1

```bash
npx wrangler d1 create domnkrbot-db
```

Wrangler выведет `database_id`. Вставьте его в `wrangler.jsonc` вместо:

```text
REPLACE_WITH_D1_DATABASE_ID
```

### 4. Добавить production secrets

Токен берётся у `@BotFather` для `@domnekromanta_bot`.

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put ADMIN_TELEGRAM_IDS
```

Для `TELEGRAM_WEBHOOK_SECRET` используйте длинную случайную строку. Для `ADMIN_TELEGRAM_IDS` укажите один или несколько numeric Telegram ID через запятую.

### 5. Применить миграции и задеплоить

```bash
npm run db:remote
npx wrangler deploy
```

После deploy Wrangler покажет адрес вида:

```text
https://domnkrbot.<account>.workers.dev
```

### 6. Подготовить локальный `.dev.vars` для настройки Telegram

```bash
cp .dev.vars.example .dev.vars
```

На Windows можно просто скопировать файл вручную. Заполните:

```text
TELEGRAM_BOT_TOKEN=<тот же токен @domnekromanta_bot>
TELEGRAM_WEBHOOK_SECRET=<тот же webhook secret>
ADMIN_TELEGRAM_IDS=<numeric Telegram ID админа>
WEBHOOK_URL=https://domnkrbot.<account>.workers.dev
```

`.dev.vars` находится в `.gitignore` и не должен коммититься.

### 7. Привязать `@domnekromanta_bot`

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
