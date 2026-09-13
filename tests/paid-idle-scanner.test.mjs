import assert from 'node:assert/strict';
import test from 'node:test';

async function loadScanner() {
  return import('../dist-runtime/ranobelib-fast-scanner.js');
}

test('idle selector is disabled for zero-demand titles', async () => {
  const scanner = await loadScanner();
  let prepares = 0;
  const env = {
    DB: {
      prepare() {
        prepares += 1;
        throw new Error('idle selector must not query D1');
      },
    },
  };

  const selected = await scanner.selectIdleTitles(env, 24);
  assert.deepEqual(selected, []);
  assert.equal(prepares, 0);
});

test('idle scanner performs no D1 or RanobeLib work when there is no subscriber demand', async () => {
  const scanner = await loadScanner();
  let prepares = 0;
  let fetches = 0;
  const env = {
    DB: {
      prepare() {
        prepares += 1;
        throw new Error('idle scanner must not query D1');
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response('{}');
  };

  try {
    const result = await scanner.scanIdleRanobeLibTitles(env);
    assert.deepEqual(result, {
      selected: 0,
      succeeded: 0,
      failed: 0,
      newReleases: 0,
      errors: [],
    });
    assert.equal(prepares, 0);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
