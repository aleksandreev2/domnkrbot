const url = process.env.PRODUCTION_URL || 'https://domnkrbot.sashahumortele2.workers.dev/';
const marker = process.env.EXPECTED_MARKER || 'domnkr-build-20260814-1949';
const attempts = Number(process.env.ATTEMPTS || 6);
const delayMs = Number(process.env.DELAY_MS || 10000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let last = null;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}smoke=${Date.now()}`, {
      headers: { 'cache-control': 'no-cache' },
      redirect: 'follow',
    });
    const text = await response.text();
    last = { status: response.status, text: text.slice(0, 600) };
    console.log(`production smoke attempt ${attempt}/${attempts}: HTTP ${response.status}`);
    if (response.ok && text.includes(marker)) {
      console.log(`PASS: production serves marker ${marker}`);
      process.exit(0);
    }
    console.log(`marker ${marker} not present yet`);
  } catch (error) {
    last = { error: error instanceof Error ? error.message : String(error) };
    console.log(`production smoke attempt ${attempt}/${attempts} failed: ${last.error}`);
  }
  if (attempt < attempts) await sleep(delayMs);
}

console.error('FAIL: production did not serve the expected build marker.');
console.error(JSON.stringify(last, null, 2));
process.exit(1);
