// Generates the static site (site/index.html) from data/articles.json.
// The site is self-contained (data embedded) so it works from file:// or any static host.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadStore } from './util.js';

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
  excerpt: a.summary ? null : (a.contentText || '').slice(0, 220),
}));

const generatedAt = new Date().toISOString();
const template = readFileSync(join(ROOT, 'site-src', 'template.html'), 'utf8');
const html = template
  .replace('__GENERATED_AT__', generatedAt)
  .replace('"__DATA__"', JSON.stringify({ generatedAt, articles }));

mkdirSync(join(ROOT, 'site'), { recursive: true });
writeFileSync(join(ROOT, 'site', 'index.html'), html);
writeFileSync(join(ROOT, 'site', '.nojekyll'), ''); // tell GitHub Pages to serve files as-is

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
console.log(`Built site/index.html with ${articles.length} articles (${articles.filter((a) => a.summary).length} summarized). Copied ${assetCount} asset(s).`);
