const origin = (process.env.PRODUCTION_URL || 'https://domnkrbot.sashahumortele2.workers.dev').replace(/\/+$/, '');
const marker = process.env.EXPECTED_MARKER || 'domnkr-build-20260819-web-admin';
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
    const site = await fetchText('/site.js?v=20260819-web3');
    const icons = await fetchText('/ui-icons.js?v=20260819-icons1');
    const lucide = await fetchText('/vendor/lucide.min.js?v=1.27.0');
    const admin = await fetchText('/admin/');
    const adminJs = await fetchText('/admin/admin.js?v=20260819-admin1');
    const adminPolish = await fetchText('/admin/admin-polish.css?v=20260819-admin2');
    const health = await fetchText('/api/health');

    last = {
      build: build.response.status,
      shell: shell.response.status,
      site: site.response.status,
      icons: icons.response.status,
      lucide: lucide.response.status,
      admin: admin.response.status,
      adminJs: adminJs.response.status,
      adminPolish: adminPolish.response.status,
      health: health.response.status,
      adminEntryVisible: shell.text.includes('id="adminLink"'),
      lucideMounted: shell.text.includes('/vendor/lucide.min.js?v=1.27.0') && admin.text.includes('/vendor/lucide.min.js?v=1.27.0'),
      storageReady: health.text.includes('"storageReady":true'),
      publishingChannelReady: health.text.includes('"publishingChannelReady":true'),
      publishingDiscussionReady: health.text.includes('"publishingDiscussionReady":true'),
    };

    const ok = build.response.ok && build.text.includes(marker)
      && shell.response.ok && shell.text.includes('Переводы без лишнего шума')
      && shell.text.includes('id="adminLink"')
      && site.response.ok && site.text.includes('/auth/telegram/callback')
      && icons.response.ok && icons.text.includes('window.DomNkrIcons')
      && lucide.response.ok && lucide.text.length > 10000
      && admin.response.ok && admin.text.includes('ADMIN CONSOLE')
      && admin.text.includes('/admin/admin-polish.css?v=20260819-admin2')
      && adminJs.response.ok && adminJs.text.includes('Publishing Center')
      && adminPolish.response.ok && adminPolish.text.includes('.admin-v2')
      && health.response.ok && health.text.includes('"service":"domnkrbot"')
      && health.text.includes('"storageReady":true')
      && health.text.includes('"publishingChannelReady":true');

    console.log(`production smoke attempt ${attempt}/${attempts}:`, JSON.stringify(last));
    if (ok) {
      console.log(`PASS: redesigned website/admin, Lucide assets, R2 FILES binding and publishing channel are ready (${marker})`);
      process.exit(0);
    }
  } catch (error) {
    last = { error: error instanceof Error ? error.message : String(error) };
    console.log(`production smoke attempt ${attempt}/${attempts} failed: ${last.error}`);
  }
  if (attempt < attempts) await sleep(delayMs);
}

console.error('FAIL: redesigned production assets are stale, Lucide runtime is missing, R2 FILES is missing, publishing channel is not ready, or the Worker is unreachable.');
console.error(JSON.stringify(last, null, 2));
process.exit(1);
