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
const beforePrune = store.articles.length;
store.articles = store.articles.filter((a) => !junkTitle(a.title));
store.articles.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
// Cap the store so it doesn't grow unbounded; keep the newest maxKeep.
const maxKeep = config.limits.maxKeep || 100;
if (store.articles.length > maxKeep) store.articles = store.articles.slice(0, maxKeep);
saveStore(store);
console.log(`\nTotal new articles: ${totalNew}. Pruned ${beforePrune - store.articles.length}. Store size: ${store.articles.length}.`);
if (failures.length) {
  console.log(`Sources that failed (consider WebFetch fallback): ${failures.join('; ')}`);
}
