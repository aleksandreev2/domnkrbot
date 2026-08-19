const origin = (process.env.PRODUCTION_URL || 'https://domnkrbot.sashahumortele2.workers.dev').replace(/\/+$/, '');
const marker = process.env.EXPECTED_MARKER || 'domnkr-build-20260819-admin-cockpit1';
const attempts = Number(process.env.ATTEMPTS || 6);
const delayMs = Number(process.env.DELAY_MS || 10000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fetchText = async (path) => {
  const response = await fetch(`${origin}${path}${path.includes('?') ? '&' : '?'}smoke=${Date.now()}`, {
    headers: { 'cache-control': 'no-cache' }, redirect: 'follow',
  });
  return { response, text: await response.text() };
};
const fetchAsset = async (path) => {
  const response = await fetch(`${origin}${path}${path.includes('?') ? '&' : '?'}smoke=${Date.now()}`, {
    headers: { 'cache-control': 'no-cache' }, redirect: 'follow',
  });
  const bytes = await response.arrayBuffer();
  return { response, bytes: bytes.byteLength };
};
const fetchUnauthedRawInit = async () => {
  const response = await fetch(`${origin}/api/proposal-raw/init`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ filename: 'smoke.zip', size: 1024 }), redirect: 'manual',
  });
  return { response, text: await response.text() };
};

let last = null;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const build = await fetchText('/build.txt');
    const shell = await fetchText('/');
    const site = await fetchText('/site.js?v=20260819-reader1');
    const propose = await fetchText('/propose/');
    const proposeJs = await fetchText('/propose.js?v=20260819-raw2');
    const title = await fetchText('/title/');
    const titleJs = await fetchText('/title.js?v=20260819-title1');
    const reader = await fetchText('/reader/');
    const readerJs = await fetchText('/reader.js?v=20260819-reader1');
    const rawAuth = await fetchUnauthedRawInit();
    const membershipAuth = await fetchText('/api/admin/membership-access');
    const usersAuth = await fetchText('/api/admin/users');
    const logo = await fetchAsset('/brand/team-logo.webp');
    const icons = await fetchText('/ui-icons.js?v=20260819-icons2');
    const lucide = await fetchText('/vendor/lucide.min.js?v=1.27.0');
    const admin = await fetchText('/admin/');
    const adminJs = await fetchText('/admin/admin.js?v=20260819-admin1');
    const adminRaw = await fetchText('/admin/proposal-raw.js?v=20260819-raw1');
    const adminStats = await fetchText('/admin/publishing-analytics.js?v=20260819-ops2');
    const adminStatsCss = await fetchText('/admin/publishing-analytics.css?v=20260819-ops2');
    const adminCockpit = await fetchText('/admin/admin-cockpit.js?v=20260819-cockpit1');
    const adminCockpitCss = await fetchText('/admin/admin-cockpit.css?v=20260819-cockpit1');
    const health = await fetchText('/api/health');

    last = {
      build: build.response.status, shell: shell.response.status, site: site.response.status,
      propose: propose.response.status, proposeJs: proposeJs.response.status,
      title: title.response.status, titleJs: titleJs.response.status,
      reader: reader.response.status, readerJs: readerJs.response.status,
      rawUnauthed: rawAuth.response.status, membershipUnauthed: membershipAuth.response.status,
      usersUnauthed: usersAuth.response.status,
      logo: logo.response.status, logoBytes: logo.bytes,
      icons: icons.response.status, lucide: lucide.response.status, admin: admin.response.status,
      adminRaw: adminRaw.response.status, adminStats: adminStats.response.status, adminStatsCss: adminStatsCss.response.status,
      adminCockpit: adminCockpit.response.status, adminCockpitCss: adminCockpitCss.response.status,
      health: health.response.status,
      storageReady: health.text.includes('"storageReady":true'),
      publishingChannelReady: health.text.includes('"publishingChannelReady":true'),
      publicationDeliveryReady: health.text.includes('"publicationDeliveryReady":true'),
      membershipAccessReady: health.text.includes('"membershipAccessReady":true'),
    };

    const ok = build.response.ok && build.text.includes(marker)
      && shell.response.ok && shell.text.includes('Последние обновления') && shell.text.includes('Наши переводы')
      && shell.text.includes('id="adminLink" class="admin-entry hidden"')
      && site.response.ok && site.text.includes('/title/?ref=') && site.text.includes('/reader/?ref=')
      && propose.response.ok && propose.text.includes('id="rawDrop"') && propose.text.includes('id="proposalRawUrl"')
      && proposeJs.response.ok && proposeJs.text.includes('/api/proposal-raw/init') && proposeJs.text.includes('/api/title-proposals')
      && title.response.ok && title.text.includes('id="titleApp"') && title.text.includes('Список глав')
      && titleJs.response.ok && titleJs.text.includes('/api/title?ref=') && titleJs.text.includes('readerAvailable')
      && reader.response.ok && reader.text.includes('id="readerSettings"')
      && readerJs.response.ok && readerJs.text.includes('/api/reader/chapter?ref=') && readerJs.text.includes('Текст этой главы ещё не импортирован')
      && rawAuth.response.status === 401 && membershipAuth.response.status === 401 && usersAuth.response.status === 401
      && logo.response.ok && logo.bytes > 1000
      && icons.response.ok && icons.text.includes("querySelectorAll('i[data-lucide]')")
      && icons.text.includes("nameAttr:'data-domnkr-lucide'") && icons.text.includes("removeAttribute('data-domnkr-lucide')")
      && lucide.response.ok && lucide.text.length > 10000
      && admin.response.ok && admin.text.includes('ADMIN CONSOLE')
      && admin.text.includes('/admin/publishing-analytics.js?v=20260819-ops2')
      && admin.text.includes('/admin/admin-cockpit.js?v=20260819-cockpit1')
      && admin.text.includes('/admin/admin-cockpit.css?v=20260819-cockpit1')
      && adminJs.response.ok && adminJs.text.includes('Publishing Center')
      && adminRaw.response.ok && adminRaw.text.includes('/api/admin/proposal-raw')
      && adminStats.response.ok && adminStats.text.includes('/api/admin/publishing-analytics')
      && adminStats.text.includes('/api/admin/membership-access') && adminStats.text.includes('Чёрный список')
      && adminStatsCss.response.ok && adminStatsCss.text.includes('.publishing-access-list')
      && adminCockpit.response.ok && adminCockpit.text.includes('/api/admin/users')
      && adminCockpit.text.includes('/api/admin/activity') && adminCockpit.text.includes('Пользователи')
      && adminCockpitCss.response.ok && adminCockpitCss.text.includes('.cockpit-users-layout')
      && health.response.ok && health.text.includes('"service":"domnkrbot"')
      && health.text.includes('"storageReady":true') && health.text.includes('"publishingChannelReady":true')
      && health.text.includes('"publicationDeliveryReady":true') && health.text.includes('"membershipAccessReady":true');

    console.log(`production smoke attempt ${attempt}/${attempts}:`, JSON.stringify(last));
    if (ok) {
      console.log(`PASS: admin cockpit, membership-gated bot delivery, publishing analytics and existing production services are ready (${marker})`);
      process.exit(0);
    }
  } catch (error) {
    last = { error: error instanceof Error ? error.message : String(error) };
    console.log(`production smoke attempt ${attempt}/${attempts} failed: ${last.error}`);
  }
  if (attempt < attempts) await sleep(delayMs);
}

console.error('FAIL: admin cockpit assets/routes are stale or existing production services regressed.');
console.error(JSON.stringify(last, null, 2));
process.exit(1);
