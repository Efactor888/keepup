// Merges summaries into the store. Also used to add hand-curated articles
// (e.g. net-new innovations found via web search) when an entry has no matching id.
//
// Usage: node pipeline/apply-summaries.js <file.json>
//
// File format:
// { "entries": [ {
//     "id": "abc123...",            // omit for a new hand-curated article
//     "url": "...", "title": "...", "source": "web", "sourceName": "Around the Web",
//     "publishedAt": "2026-07-01",  // required for new articles
//     "summary": "plain-English summary",
//     "enterpriseAngle": "security + product development take",
//     "beginner": "what a newcomer should take away",
//     "advanced": "what a practitioner should take away",
//     "tags": ["release", "security", ...]
// } ] }

import { readFileSync } from 'node:fs';
import { loadStore, saveStore, articleId } from './util.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node pipeline/apply-summaries.js <file.json>');
  process.exit(1);
}

const { entries } = JSON.parse(readFileSync(file, 'utf8'));
const store = loadStore();
const byId = new Map(store.articles.map((a) => [a.id, a]));
let updated = 0;
let added = 0;

for (const e of entries) {
  const existing = e.id ? byId.get(e.id) : byId.get(articleId(e.url || ''));
  if (existing) {
    for (const k of ['summary', 'enterpriseAngle', 'beginner', 'advanced', 'tags', 'title', 'publishedAt']) {
      if (e[k] != null) existing[k] = e[k];
    }
    if (existing.summary) existing.contentText = null; // drop raw text once summarized
    updated += 1;
  } else {
    if (!e.url || !e.title || !e.summary) {
      console.error(`Skipping incomplete new entry: ${e.title || e.url || '(unknown)'}`);
      continue;
    }
    store.articles.push({
      id: articleId(e.url),
      source: e.source || 'web',
      sourceName: e.sourceName || 'Around the Web',
      tier: 'daily',
      title: e.title,
      url: e.url,
      publishedAt: e.publishedAt ? new Date(e.publishedAt).toISOString() : new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      contentText: null,
      summary: e.summary,
      enterpriseAngle: e.enterpriseAngle || null,
      beginner: e.beginner || null,
      advanced: e.advanced || null,
      tags: e.tags || [],
    });
    added += 1;
  }
}

store.articles.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
saveStore(store);
console.log(`Updated ${updated}, added ${added}. Store size: ${store.articles.length}.`);
