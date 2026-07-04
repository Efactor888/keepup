// Fetches new articles from configured sources into data/articles.json.
// New items get summary: null — the summarization pass (a Claude session)
// fills in summary/enterpriseAngle/beginner/advanced, then build.js renders the site.
//
// Usage: node pipeline/fetch.js [--tier realtime|daily] [--source <id>]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, fetchText, fetchArticleText, articleId, loadStore, saveStore, decodeEntities, stripHtml,
} from './util.js';

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'sources.json'), 'utf8'));
const args = process.argv.slice(2);
const tierArg = args.includes('--tier') ? args[args.indexOf('--tier') + 1] : null;
const sourceArg = args.includes('--source') ? args[args.indexOf('--source') + 1] : null;

const { maxNewPerSourcePerRun, maxAgeDays } = config.limits;
const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;

// Pull a "Jan 5, 2026" / "January 5, 2026" style date out of scraped text.
// Returns a date-only ISO string (rendered by its UTC calendar day on the site).
function extractDate(text) {
  const m = (text || '').match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/);
  if (!m) return null;
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const d = new Date(Date.UTC(Number(m[3]), months[m[1].toLowerCase()], Number(m[2])));
  if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 86400000) return null;
  return d.toISOString().slice(0, 10);
}

function parseRss(xml) {
  const items = [];
  const blocks = xml.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/g) || [];
  for (const block of blocks) {
    const tag = (name) =>
      decodeEntities(block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || '').trim();
    let link = tag('link');
    if (!link) link = block.match(/<link[^>]*href="([^"]+)"/i)?.[1] || '';
    const title = stripHtml(tag('title'));
    const date = tag('pubDate') || tag('published') || tag('updated') || tag('dc:date');
    const desc = stripHtml(tag('description') || tag('summary') || tag('content:encoded') || tag('content'));
    if (link && title) items.push({ url: link.trim(), title, publishedAt: date ? new Date(date).toISOString() : null, excerpt: desc.slice(0, 4000) });
  }
  return items;
}

function parseSitemap(xml, pathPrefixes) {
  const items = [];
  const blocks = xml.match(/<url>[\s\S]*?<\/url>/g) || [];
  for (const block of blocks) {
    const loc = block.match(/<loc>([\s\S]*?)<\/loc>/)?.[1]?.trim();
    const lastmod = block.match(/<lastmod>([\s\S]*?)<\/lastmod>/)?.[1]?.trim();
    if (!loc) continue;
    const path = loc.replace(/^https?:\/\/[^/]+/, '');
    if (!pathPrefixes.some((p) => path.startsWith(p) && path.length > p.length)) continue;
    items.push({ url: loc, title: null, publishedAt: lastmod ? new Date(lastmod).toISOString() : null, excerpt: '' });
  }
  // Newest first when lastmod exists.
  items.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  return items;
}

function parseLinkedPage(html, baseUrl, linkPattern) {
  const origin = new URL(baseUrl).origin;
  const seen = new Set();
  const items = [];
  for (const m of html.matchAll(/<a[^>]+href="([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    let href = m[1];
    if (href.startsWith('/')) href = origin + href;
    if (!href.startsWith(origin)) continue;
    const path = href.replace(origin, '');
    if (!path.startsWith(linkPattern) || path === linkPattern || path === linkPattern.replace(/\/$/, '')) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const text = stripHtml(m[2]).slice(0, 200);
    items.push({ url: href, title: text || null, publishedAt: null, excerpt: '' });
  }
  return items;
}

async function fetchSource(source) {
  const xmlOrHtml = await fetchText(source.url);
  if (source.type === 'rss') return parseRss(xmlOrHtml);
  if (source.type === 'sitemap') return parseSitemap(xmlOrHtml, source.pathPrefixes);
  if (source.type === 'scrape-links') return parseLinkedPage(xmlOrHtml, source.url, source.linkPattern);
  throw new Error(`Unknown source type: ${source.type}`);
}

const store = loadStore();
const known = new Set(store.articles.map((a) => a.id));
let totalNew = 0;
const failures = [];

for (const source of config.sources) {
  if (tierArg && source.tier !== tierArg) continue;
  if (sourceArg && source.id !== sourceArg) continue;
  let items;
  try {
    items = await fetchSource(source);
  } catch (err) {
    failures.push(`${source.id}: ${err.message}`);
    console.error(`FAIL ${source.id}: ${err.message}`);
    continue;
  }

  let added = 0;
  for (const item of items) {
    if (added >= maxNewPerSourcePerRun) break;
    const id = articleId(item.url);
    if (known.has(id)) continue;
    if (item.publishedAt && Date.parse(item.publishedAt) < cutoff) continue;

    // Fill in missing title/date/excerpt from the article page itself.
    let { title, publishedAt, excerpt } = item;
    if (!title || !excerpt) {
      const page = await fetchArticleText(item.url);
      if (!title) title = (page.title || '').replace(/\s*[|\\–—-]\s*(Anthropic|OpenAI|xAI|Cursor|Google.*)$/i, '').trim();
      if (!excerpt) excerpt = page.text;
    }
    if (!title) continue;

    // Scraped pages (xAI, Cursor) often carry no machine-readable date, which would
    // default to "now" and make old posts look current. Extract a "Jan 5, 2026"-style
    // date from the title/text instead, and apply the age cutoff to it.
    if (!publishedAt) {
      publishedAt = extractDate(title) || extractDate((excerpt || '').slice(0, 1200));
      if (publishedAt && Date.parse(publishedAt) < cutoff) continue;
    }

    known.add(id);
    store.articles.push({
      id,
      source: source.id,
      sourceName: source.name,
      tier: source.tier,
      title,
      url: item.url,
      publishedAt: publishedAt || new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      contentText: excerpt || null,
      summary: null,
      enterpriseAngle: null,
      beginner: null,
      advanced: null,
      tags: [],
    });
    added += 1;
    totalNew += 1;
  }
  console.log(`${source.id}: ${items.length} found, ${added} new`);
}

// Drop scraper junk (nav labels, bare category/byline lines, version stubs, too-short titles).
const junkTitle = (t) => {
  t = (t || '').trim();
  if (t.length < 18) return true;
  if (/^(customers|ideas|research|product|company|enterprise|pricing|blog|news|docs|more)$/i.test(t)) return true;
  if (/^(view all|read more|see all|load more|next|previous|older|newer)\b/i.test(t)) return true;
  if (/^\d+(\.\d+)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t)) return true;
  if (!/[a-z]/i.test(t)) return true;
  return false;
};
// Re-derive dates for entries whose stored date isn't the real publish date:
//  - scraped sources with no date default publishedAt to fetch time
//  - Anthropic sitemap dates are lastmod, not publish (old posts look new)
// Tries title/stored text first, then refetches the page once (dateChecked
// marks entries so pages with no findable date aren't refetched every run).
for (const a of store.articles) {
  if (a.dateChecked) continue;
  const defaulted = a.publishedAt && a.fetchedAt &&
    Math.abs(Date.parse(a.publishedAt) - Date.parse(a.fetchedAt)) < 5 * 60 * 1000;
  const lastmodSuspect = a.source === 'anthropic';
  if (!defaulted && !lastmodSuspect) continue;
  // Anthropic pages open with "Announcements <title> <publish date> ..." — the
  // first date in the text is the publish date, so restrict to the header area.
  let real = extractDate(a.title) || extractDate((a.contentText || '').slice(0, 1200));
  if (!real) {
    const page = await fetchArticleText(a.url);
    real = extractDate(page.title) || extractDate((page.text || '').slice(0, 1500));
  }
  a.dateChecked = true; // one pass per article, refetch at most once
  if (real && real !== (a.publishedAt || '').slice(0, 10)) {
    a.publishedAt = real;
    console.log(`re-dated: ${a.title.slice(0, 60)} -> ${real}`);
  }
}

const beforePrune = store.articles.length;
store.articles = store.articles.filter((a) => !junkTitle(a.title));
// Retention: keep a rolling year of coverage. Age-based (not count-based) so
// summarized articles are never churned out and re-fetched while feeds still list them.
const retentionDays = config.limits.retentionDays || 365;
const keepCutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
store.articles = store.articles.filter((a) => !a.publishedAt || Date.parse(a.publishedAt) >= keepCutoff);
store.articles.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
if (store.articles.length > 6000) store.articles = store.articles.slice(0, 6000); // safety valve only
saveStore(store);
console.log(`\nTotal new articles: ${totalNew}. Pruned ${beforePrune - store.articles.length}. Store size: ${store.articles.length}.`);
if (failures.length) {
  console.log(`Sources that failed (consider WebFetch fallback): ${failures.join('; ')}`);
}
