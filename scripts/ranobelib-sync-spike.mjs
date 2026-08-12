import fs from 'node:fs/promises';
import path from 'node:path';
import { RanobeLibClient, detectReleaseDelta } from '../dist/index.js';

const args = parseArgs(process.argv.slice(2));
const teamRef = args.team ?? '11969--dom-nekromanta';
const statePath = path.resolve(args.state ?? '.ranobelib-sync-state.json');
const limit = args.limit ? Number(args.limit) : undefined;

if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
  throw new Error('--limit must be a positive integer');
}

const client = new RanobeLibClient();
const previousState = await readState(statePath, teamRef);
const discovered = await client.discoverTeamBooks(teamRef);
const books = limit ? discovered.slice(0, limit) : discovered;

console.log(`RanobeLib team ${teamRef}: discovered ${discovered.length} book(s); syncing ${books.length}.`);

const nextBooks = { ...previousState.books };
const releases = [];
const failures = [];

for (const book of books) {
  try {
    const [title, chapters] = await Promise.all([
      client.getTitle(book.ref),
      client.getChapters(book.ref),
    ]);

    const previous = previousState.books[book.ref];
    const delta = detectReleaseDelta(book.ref, previous?.chapters, chapters);
    if (delta?.added.length) {
      releases.push({
        ...delta,
        title: title.title ?? previous?.title ?? book.ref,
        url: book.url,
      });
    }

    nextBooks[book.ref] = {
      bookRef: book.ref,
      url: book.url,
      title: title.title,
      coverUrl: title.coverUrl,
      chapters,
      syncedAt: new Date().toISOString(),
    };

    console.log(`✓ ${title.title ?? book.ref}: ${chapters.length} chapter(s)`);
  } catch (error) {
    failures.push({ bookRef: book.ref, error: error instanceof Error ? error.message : String(error) });
    console.error(`✗ ${book.ref}:`, error instanceof Error ? error.message : error);
  }
}

const nextState = {
  version: 1,
  teamRef,
  books: nextBooks,
  syncedAt: new Date().toISOString(),
};

await fs.writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');

if (releases.length) {
  console.log('\nDetected release(s):');
  for (const release of releases) {
    console.log(`• ${release.title}: ${release.summary} — ${release.url}`);
  }
} else {
  console.log('\nNo new releases detected. First successful run is treated as bootstrap and does not emit historical releases.');
}

if (failures.length) {
  console.log(`\n${failures.length} book(s) failed; successful books were still persisted.`);
  process.exitCode = 2;
}

async function readState(filePath, currentTeamRef) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (parsed?.version !== 1 || parsed?.teamRef !== currentTeamRef || typeof parsed.books !== 'object') {
      throw new Error('state schema/team mismatch');
    }
    return parsed;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`Ignoring previous state (${error instanceof Error ? error.message : error}).`);
    }
    return { version: 1, teamRef: currentTeamRef, books: {}, syncedAt: new Date(0).toISOString() };
  }
}

function parseArgs(tokens) {
  const result = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const value = tokens[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    result[key] = value;
    i += 1;
  }
  return result;
}
