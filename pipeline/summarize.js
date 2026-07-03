// Fills in missing summaries by calling the Claude API (Haiku 4.5) with
// structured JSON output. Self-contained: raw HTTPS via fetch + ANTHROPIC_API_KEY,
// no SDK dependency. Runs in CI after fetch.js and before build.js — this is what
// replaces the human/Claude-app summarization pass so the pipeline is fully automated.
//
// Usage: ANTHROPIC_API_KEY=... node pipeline/summarize.js [--limit N]

import { loadStore, saveStore, fetchArticleText } from './util.js';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. In GitHub Actions add it under Settings → Secrets and variables → Actions.');
  process.exit(1);
}

const MODEL = 'claude-haiku-4-5'; // cheapest model; plenty for short summaries ($1/$5 per 1M tok)
const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;

const TAGS = [
  'model-release', 'agents', 'security', 'enterprise', 'partnership', 'coding', 'research',
  'product', 'policy', 'infrastructure', 'funding', 'science', 'benchmark', 'governance',
  'workforce', 'consumer', 'hardware', 'learning', 'digest',
];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    enterpriseAngle: { type: 'string' },
    beginner: { type: 'string' },
    advanced: { type: 'string' },
    tags: { type: 'array', items: { type: 'string', enum: TAGS } },
  },
  required: ['summary', 'enterpriseAngle', 'beginner', 'advanced', 'tags'],
};

const SYSTEM = `You are the editor of KeepUp, an enterprise-AI news briefing written for both newcomers and expert practitioners. For the given article, return JSON with:
- summary: 2-3 plain-English sentences a layman can follow, grounded ONLY in the provided text. Never invent facts, numbers, or quotes.
- enterpriseAngle: 1-2 sentences on what this means for enterprise security and/or product development teams.
- beginner: one sentence takeaway for someone new to AI.
- advanced: one actionable sentence for an experienced practitioner.
- tags: 1-4 items chosen from the allowed list only.
Be accurate, concise, and neutral. If the source text is thin, summarize only what it supports.`;

async function summarize(article) {
  const body = {
    model: MODEL,
    max_tokens: 800,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content:
        `Source: ${article.sourceName}\nTitle: ${article.title}\nPublished: ${article.publishedAt}\nURL: ${article.url}\n\n` +
        `Article text:\n${(article.contentText || '').slice(0, 6000)}`,
    }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      const wait = (Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    if (data.stop_reason === 'refusal') return { refused: true, usage: data.usage };
    const text = (data.content || []).find((b) => b.type === 'text')?.text || '';
    return { parsed: JSON.parse(text), usage: data.usage };
  }
  throw new Error('exhausted retries');
}

const store = loadStore();
let pending = store.articles.filter((a) => !a.summary);
if (Number.isFinite(limit)) pending = pending.slice(0, limit);
console.log(`${pending.length} article(s) to summarize with ${MODEL}.`);

let inTok = 0, outTok = 0, done = 0, failed = 0;
for (const a of pending) {
  // Backfill body text if the fetch step captured little or nothing.
  if (!a.contentText || a.contentText.length < 200) {
    const page = await fetchArticleText(a.url);
    if (page.text) a.contentText = page.text;
  }
  try {
    const { parsed, refused, usage } = await summarize(a);
    if (usage) { inTok += usage.input_tokens || 0; outTok += usage.output_tokens || 0; }
    if (refused || !parsed) { failed++; console.log(`  skip (refused/empty): ${a.title}`); continue; }
    a.summary = parsed.summary;
    a.enterpriseAngle = parsed.enterpriseAngle;
    a.beginner = parsed.beginner;
    a.advanced = parsed.advanced;
    a.tags = (parsed.tags || []).filter((t) => TAGS.includes(t));
    a.contentText = null; // drop raw text once summarized
    done++;
    console.log(`  ok: ${a.title}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL: ${a.title} — ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 300)); // gentle pacing
}

saveStore(store);
const cost = (inTok / 1e6) * 1 + (outTok / 1e6) * 5;
console.log(`\nSummarized ${done}, failed ${failed}. Tokens: ${inTok} in / ${outTok} out (~$${cost.toFixed(4)} at Haiku rates).`);
