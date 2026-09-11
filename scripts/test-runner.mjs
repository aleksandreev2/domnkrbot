import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const TEST_SUFFIX = '.test.mjs';
const BATCH_SIZE = 40;

async function collectTestFiles(root, dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(root, fullPath));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(TEST_SUFFIX)) continue;
    files.push(path.relative(root, fullPath));
  }
  return files;
}

export async function discoverTestFiles(root = process.cwd()) {
  return collectTestFiles(root, path.join(root, 'tests'));
}

export async function verifyTestDiscovery(root = process.cwd()) {
  const files = await discoverTestFiles(root);
  if (files.length === 0) throw new Error('No tests/*.test.mjs files were discovered');

  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const testScript = String(packageJson.scripts?.test ?? '');
  const pretestScript = String(packageJson.scripts?.pretest ?? '');
  const runnerPattern = /(?:^|&&|;)\s*node\s+scripts[\\/]test-runner\.mjs(?:\s|$)/;
  const manualTestPattern = /tests[\\/][^\s"']+\.test\.mjs/;

  if (!runnerPattern.test(testScript)) {
    throw new Error('package.json scripts.test must invoke node scripts/test-runner.mjs');
  }
  if (manualTestPattern.test(testScript) || manualTestPattern.test(pretestScript)) {
    throw new Error('Manual .test.mjs enumeration is forbidden in test/pretest scripts; use automatic discovery');
  }

  console.log(`[test-discovery] ${files.length} test files discovered automatically`);
  return files;
}

function runNodeTests(root, files, stdio = 'inherit') {
  return spawnSync(process.execPath, ['--test', ...files], {
    cwd: root,
    env: process.env,
    stdio,
    encoding: stdio === 'inherit' ? undefined : 'utf8',
  });
}

function annotationEscape(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function diagnoseFailedBatch(root, files) {
  console.error('[test-discovery] batch failed; isolating failing files');
  const failed = [];
  for (const file of files) {
    const result = runNodeTests(root, [file], 'pipe');
    if (result.error) throw result.error;
    if (result.status === 0) continue;
    failed.push(file);
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.error(`::error file=${annotationEscape(file)},title=Test file failed::${annotationEscape(`${file} failed in automatic test discovery`)}`);
    } else {
      console.error(`[test-discovery] failing file: ${file}`);
    }
  }
  return failed;
}

function runBatch(root, files, index, total) {
  console.log(`[test-discovery] running batch ${index}/${total} (${files.length} files)`);
  const result = runNodeTests(root, files);
  if (result.error) throw result.error;
  if (result.status === 0) return;

  const failed = diagnoseFailedBatch(root, files);
  if (failed.length === 0) {
    console.error('[test-discovery] batch failed only when files ran together; check shared global state or resource contention');
  } else {
    console.error(`[test-discovery] ${failed.length} failing file(s): ${failed.join(', ')}`);
  }
  process.exit(result.status ?? 1);
}

const root = process.cwd();
const verifyOnly = process.argv.includes('--verify');
const files = await verifyTestDiscovery(root);

if (!verifyOnly) {
  const total = Math.ceil(files.length / BATCH_SIZE);
  for (let offset = 0, batch = 1; offset < files.length; offset += BATCH_SIZE, batch += 1) {
    runBatch(root, files.slice(offset, offset + BATCH_SIZE), batch, total);
  }
}
