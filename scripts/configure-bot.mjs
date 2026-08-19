import fs from 'node:fs';
import path from 'node:path';

loadDevVars();

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
const rawWebhookUrl = (process.env.WEBHOOK_URL || '').trim();

if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required in .dev.vars or environment');
if (!webhookSecret) throw new Error('TELEGRAM_WEBHOOK_SECRET is required in .dev.vars or environment');
if (!rawWebhookUrl) throw new Error('WEBHOOK_URL is required, for example https://domnkrbot.<account>.workers.dev');

const siteUrl = rawWebhookUrl.replace(/\/+$/, '');
if (!/^https:\/\//i.test(siteUrl)) throw new Error('WEBHOOK_URL must use https://');

const apiBase = `https://api.telegram.org/bot${token}`;

async function call(method, payload = {}) {
  const response = await fetch(`${apiBase}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(`${method} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.result;
}

const me = await call('getMe');
console.log(`Configuring @${me.username} (${me.id})…`);

await call('setMyName', { name: 'Дом Некроманта' });
await call('setMyDescription', {
  description: 'Переводы, новые главы и предложения сообщества. Каталог и управление доступны на сайте «Дом Некроманта».',
});
await call('setMyShortDescription', {
  short_description: 'Переводы и предложения сообщества «Дом Некроманта».',
});

await call('setMyCommands', {
  commands: [
    { command: 'start', description: 'Открыть Дом Некроманта' },
    { command: 'site', description: 'Открыть сайт' },
    { command: 'propose', description: 'Предложить перевод' },
    { command: 'help', description: 'Помощь' },
  ],
});

// Remove the old Mini App menu button. The default menu opens the command list.
await call('setChatMenuButton', { menu_button: { type: 'default' } });

await call('setWebhook', {
  url: `${siteUrl}/telegram/webhook`,
  secret_token: webhookSecret,
  allowed_updates: ['message'],
  drop_pending_updates: false,
});

const webhook = await call('getWebhookInfo');
console.log(`✓ Bot: @${me.username}`);
console.log(`✓ Site: ${siteUrl}`);
console.log(`✓ Webhook: ${webhook.url || '(not set)'}`);
console.log(`✓ Pending updates: ${webhook.pending_update_count ?? 0}`);
console.log('! For website login, link this HTTPS domain to the bot in BotFather (/setdomain).');

function loadDevVars() {
  const filePath = path.resolve('.dev.vars');
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
