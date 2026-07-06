// Generates the static site (site/index.html) from data/articles.json.
// The site is self-contained (data embedded) so it works from file:// or any static host.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadStore, decodeEntities } from './util.js';

const store = loadStore();

// Only ship what the page needs.
const articles = store.articles.map((a) => ({
  id: a.id,
  source: a.source,
  sourceName: a.sourceName,
  title: a.title,
  url: a.url,
  publishedAt: a.publishedAt,
  summary: a.summary,
  enterpriseAngle: a.enterpriseAngle,
  beginner: a.beginner,
  advanced: a.advanced,
  tags: a.tags || [],
  excerpt: a.summary ? null : decodeEntities(a.contentText || '').slice(0, 220),
}));

// Keep the page itself light: embed only the newest EMBED_RECENT articles in
// index.html; the rest ship as a static archive.json the page fetches on demand
// (search, filters, or "load older stories"). Storage is cheap — page weight isn't.
const EMBED_RECENT = Number(process.env.EMBED_RECENT) || 200;
articles.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
const embedded = articles.slice(0, EMBED_RECENT);
const archived = articles.slice(EMBED_RECENT);

const generatedAt = new Date().toISOString();
const template = readFileSync(join(ROOT, 'site-src', 'template.html'), 'utf8');
const html = template
  .replace('__GENERATED_AT__', generatedAt)
  .replace('"__DATA__"', JSON.stringify({ generatedAt, articles: embedded, archiveCount: archived.length }));

mkdirSync(join(ROOT, 'site'), { recursive: true });
writeFileSync(join(ROOT, 'site', 'index.html'), html);
writeFileSync(join(ROOT, 'site', 'archive.json'), JSON.stringify(archived));
writeFileSync(join(ROOT, 'site', '.nojekyll'), ''); // tell GitHub Pages to serve files as-is
writeFileSync(join(ROOT, 'site', 'CNAME'), 'erikhuang.ai\n'); // custom domain (GitHub Pages reads this)

// Copy static assets (photos, etc.) from site-src/assets → site/assets so they
// survive rebuilds and are served alongside index.html.
const assetSrc = join(ROOT, 'site-src', 'assets');
let assetCount = 0;
if (existsSync(assetSrc)) {
  const assetOut = join(ROOT, 'site', 'assets');
  mkdirSync(assetOut, { recursive: true });
  for (const f of readdirSync(assetSrc)) {
    if (f.startsWith('.')) continue;
    copyFileSync(join(assetSrc, f), join(assetOut, f));
    assetCount += 1;
  }
}
console.log(`Built site/index.html with ${embedded.length} embedded + ${archived.length} archived articles (${articles.filter((a) => a.summary).length}/${articles.length} summarized). Copied ${assetCount} asset(s).`);
