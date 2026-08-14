const origin = (process.env.PRODUCTION_URL || 'https://domnkrbot.sashahumortele2.workers.dev').replace(/\/+$/, '');
const marker = process.env.EXPECTED_MARKER || 'domnkr-build-20260814-1949';
const attempts = Number(process.env.ATTEMPTS || 6);
const delayMs = Number(process.env.DELAY_MS || 10000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fetchText = async (path) => {
  const response = await fetch(`${origin}${path}${path.includes('?') ? '&' : '?'}smoke=${Date.now()}`, {
    headers: { 'cache-control': 'no-cache' },
    redirect: 'follow',
  });
  return { response, text: await response.text() };
};

let last = null;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const build = await fetchText('/build.txt');
    const shell = await fetchText('/');
    const theme = await fetchText('/dollartl-theme.css?v=20260814-hotfix1');
    const app = await fetchText('/app.js?v=20260814-hotfix1');

    last = {
      build: build.response.status,
      shell: shell.response.status,
      theme: theme.response.status,
      app: app.response.status,
      shellType: shell.response.headers.get('content-type'),
      shellPrefix: shell.text.slice(0, 120),
    };

    const ok = build.response.ok && build.text.includes(marker)
      && shell.response.ok && shell.text.includes('Переводы, которые выбирает сообщество')
      && theme.response.ok && theme.text.includes('--bg:#fcfbf8')
      && app.response.ok && app.text.includes('void bootstrap()');

    console.log(`production smoke attempt ${attempt}/${attempts}:`, JSON.stringify(last));
    if (ok) {
      console.log(`PASS: production shell/assets are current (${marker})`);
      process.exit(0);
    }
  } catch (error) {
    last = { error: error instanceof Error ? error.message : String(error) };
    console.log(`production smoke attempt ${attempt}/${attempts} failed: ${last.error}`);
  }
  if (attempt < attempts) await sleep(delayMs);
}

console.error('FAIL: production shell/assets are not current or not reachable.');
console.error(JSON.stringify(last, null, 2));
process.exit(1);
