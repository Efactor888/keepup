// Prints articles that still need summaries, as JSON, for the summarization pass.
// Usage: node pipeline/pending.js [--full]  (--full includes contentText)

import { loadStore } from './util.js';

const full = process.argv.includes('--full');
const store = loadStore();
const pending = store.articles
  .filter((a) => !a.summary)
  .map((a) => ({
    id: a.id,
    source: a.sourceName,
    title: a.title,
    url: a.url,
    publishedAt: a.publishedAt,
    ...(full ? { contentText: a.contentText } : { contentPreview: (a.contentText || '').slice(0, 300) }),
  }));

console.log(JSON.stringify({ count: pending.length, pending }, null, 2));
