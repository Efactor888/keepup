import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_FILE = join(ROOT, 'data', 'articles.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 KeepUpBot/1.0';

export async function fetchText(url, timeoutMs = 20000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml,text/xml,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

export function articleId(url) {
  return createHash('sha1').update(url.replace(/[?#].*$/, '').replace(/\/$/, '')).digest('hex').slice(0, 12);
}

export function loadStore() {
  if (!existsSync(DATA_FILE)) return { updatedAt: null, articles: [] };
  return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
}

export function saveStore(store) {
  store.updatedAt = new Date().toISOString();
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

export function decodeEntities(s) {
  return (s || '')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#8217;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8212;|&mdash;/g, '—')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16))) // hex entities e.g. &#x27;
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

export function stripHtml(html) {
  return decodeEntities(
    (html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract readable body text from an article page, capped for summarization context.
export async function fetchArticleText(url, maxChars = 7000) {
  try {
    const html = await fetchText(url);
    const main =
      html.match(/<article[\s\S]*?<\/article>/i)?.[0] ||
      html.match(/<main[\s\S]*?<\/main>/i)?.[0] ||
      html;
    const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
    const text = stripHtml(main).slice(0, maxChars);
    return { title, text };
  } catch (err) {
    return { title: '', text: '', error: String(err.message || err) };
  }
}
