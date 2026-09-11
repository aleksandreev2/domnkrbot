import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

function normalizedSha(value) {
  const text = String(value ?? '').trim();
  return /^[0-9a-f]{40}$/i.test(text) ? text.toLowerCase() : '';
}

function gitHead() {
  try {
    return normalizedSha(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }));
  } catch {
    return '';
  }
}

const revision = normalizedSha(process.env.WORKERS_CI_COMMIT_SHA)
  || normalizedSha(process.env.GITHUB_SHA)
  || gitHead();

if (!revision) {
  throw new Error('Unable to determine deployment git revision');
}

await writeFile(new URL('../public/deploy-revision.txt', import.meta.url), `${revision}\n`, 'utf8');
console.log(`deploy revision asset: ${revision}`);