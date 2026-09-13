import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('home forum and review cards use the exact live title section query contract', async () => {
  const source = await read('../public/home-parity.js');

  assert.match(source, /sectionUrl\(item\.bookRef,['"]discussions['"]\)/);
  assert.match(source, /sectionUrl\(item\.bookRef,['"]review['"]\)/);
  assert.doesNotMatch(source, /titleUrl\(item\.bookRef\)\}#discussions/);
  assert.doesNotMatch(source, /titleUrl\(item\.bookRef\)\}#reviews/);
  assert.match(source, /function sectionUrl\(ref,section\)/);
  assert.match(source, /\/title\/\?ref=/);
  assert.match(source, /&section=/);
});
