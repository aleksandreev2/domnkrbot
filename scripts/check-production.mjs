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
const fetchAsset = async (path) => {
  const response = await fetch(`${origin}${path}${path.includes('?') ? '&' : '?'}smoke=${Date.now()}`, {
    headers: { 'cache-control': 'no-cache' },
    redirect: 'follow',
  });
  const bytes = await response.arrayBuffer();
  return { response, bytes: bytes.byteLength };
};

let last = null;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const build = await fetchText('/build.txt');
    const shell = await fetchText('/');
    const site = await fetchText('/site.js?v=20260819-web5');
    const propose = await fetchText('/propose/');
    const proposeJs = await fetchText('/propose.js?v=20260819-propose1');
    const logo = await fetchAsset('/brand/team-logo.webp');
    const icons = await fetchText('/ui-icons.js?v=20260819-icons2');
    const lucide = await fetchText('/vendor/lucide.min.js?v=1.27.0');
    const admin = await fetchText('/admin/');
    const adminJs = await fetchText('/admin/admin.js?v=20260819-admin1');
    const adminPolish = await fetchText('/admin/admin-polish.css?v=20260819-admin2');
    const health = await fetchText('/api/health');

    last = {
      build: build.response.status,
      shell: shell.response.status,
      site: site.response.status,
      propose: propose.response.status,
      proposeJs: proposeJs.response.status,
      logo: logo.response.status,
      logoBytes: logo.bytes,
      icons: icons.response.status,
      lucide: lucide.response.status,
      admin: admin.response.status,
      adminJs: adminJs.response.status,
      adminPolish: adminPolish.response.status,
      health: health.response.status,
      readerShell: shell.text.includes('Своя читалка') && shell.text.includes('href="/propose/"'),
      adminHiddenByDefault: shell.text.includes('id="adminLink" class="utility-admin hidden"'),
      titleRawPage: propose.text.includes('RAW ОБЯЗАТЕЛЕН') && propose.text.includes('id="proposalRaw"'),
      safeIconRuntime: icons.text.includes("querySelectorAll('i[data-lucide]')")
        && icons.text.includes("nameAttr:'data-domnkr-lucide'")
        && icons.text.includes("removeAttribute('data-domnkr-lucide')"),
      storageReady: health.text.includes('"storageReady":true'),
      publishingChannelReady: health.text.includes('"publishingChannelReady":true'),
      publishingDiscussionReady: health.text.includes('"publishingDiscussionReady":true'),
    };

    const ok = build.response.ok && build.text.includes(marker)
      && shell.response.ok && shell.text.includes('Своя читалка')
      && shell.text.includes('href="/propose/"')
      && shell.text.includes('id="adminLink" class="utility-admin hidden"')
      && shell.text.includes('/brand/team-logo.webp')
      && site.response.ok && site.text.includes('state.bootstrap?.isAdmin')
      && site.text.includes('restorePostLoginRoute')
      && propose.response.ok && propose.text.includes('RAW ОБЯЗАТЕЛЕН')
      && propose.text.includes('id="proposalRaw"')
      && proposeJs.response.ok && proposeJs.text.includes("proposalType:'title'")
      && proposeJs.text.includes('sourceUrl:raw')
      && logo.response.ok && logo.bytes > 1000
      && icons.response.ok
      && icons.text.includes("querySelectorAll('i[data-lucide]')")
      && icons.text.includes("nameAttr:'data-domnkr-lucide'")
      && icons.text.includes("removeAttribute('data-domnkr-lucide')")
      && lucide.response.ok && lucide.text.length > 10000
      && admin.response.ok && admin.text.includes('ADMIN CONSOLE')
      && admin.text.includes('/ui-icons.js?v=20260819-icons2')
      && admin.text.includes('/admin/admin-polish.css?v=20260819-admin2')
      && adminJs.response.ok && adminJs.text.includes('Publishing Center')
      && adminPolish.response.ok && adminPolish.text.includes('.admin-v2')
      && health.response.ok && health.text.includes('"service":"domnkrbot"')
      && health.text.includes('"storageReady":true')
      && health.text.includes('"publishingChannelReady":true');

    console.log(`production smoke attempt ${attempt}/${attempts}:`, JSON.stringify(last));
    if (ok) {
      console.log(`PASS: reader-oriented website, separate RAW proposal page, admin visibility gate and existing production services are ready (${marker})`);
      process.exit(0);
    }
  } catch (error) {
    last = { error: error instanceof Error ? error.message : String(error) };
    console.log(`production smoke attempt ${attempt}/${attempts} failed: ${last.error}`);
  }
  if (attempt < attempts) await sleep(delayMs);
}

console.error('FAIL: production assets are stale, reader shell/proposal page/admin gate is missing, or existing storage/publishing readiness regressed.');
console.error(JSON.stringify(last, null, 2));
process.exit(1);
