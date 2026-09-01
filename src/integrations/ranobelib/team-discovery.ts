import type { RanobeLibTeamBookRef } from './types.js';

const BOOK_PATH_RE = /(?:https?:\/\/ranobelib\.me)?\/(?:ru\/)?book\/(\d+)--([^?"'<>\s&\\}]+)/gi;

export function discoverTeamBooksFromHtml(html: string): RanobeLibTeamBookRef[] {
  const decoded = decodeHtmlEntities(html)
    .replaceAll('\\/', '/')
    .replaceAll('\\u002F', '/')
    .replaceAll('\\u002f', '/');
  const seen = new Set<string>();
  const books: RanobeLibTeamBookRef[] = [];

  for (const match of decoded.matchAll(BOOK_PATH_RE)) {
    const idText = match[1];
    const slug = match[2];
    if (!idText || !slug) continue;

    const ref = `${idText}--${slug}`;
    if (seen.has(ref)) continue;
    seen.add(ref);

    books.push({
      id: Number(idText),
      slug,
      ref,
      url: `https://ranobelib.me/ru/book/${ref}`,
    });
  }

  return books;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&#38;', '&')
    .replaceAll('&#x26;', '&');
}
