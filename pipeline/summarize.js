// Fills in missing summaries by calling an LLM API with structured JSON output.
// Self-contained: raw HTTPS via fetch, no SDK dependency. Runs in CI after
// fetch.js and before build.js — this replaces the manual summarization pass so
// the pipeline is fully automated.
//
// Provider is chosen from whichever key is present (xAI/Grok takes precedence):
//   XAI_API_KEY        -> Grok (api.x.ai, OpenAI-compatible). Model: $XAI_MODEL or grok-4.1-fast.
//   ANTHROPIC_API_KEY  -> Claude (Haiku 4.5).
//   neither            -> skip gracefully (build/deploy still run).
//
// Usage: XAI_API_KEY=... node pipeline/summarize.js [--limit N]

import { loadStore, saveStore, fetchArticleText } from './util.js';

const XAI_KEY = process.env.XAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PROVIDER = XAI_KEY ? 'xai' : (ANTHROPIC_KEY ? 'anthropic' : null);

if (!PROVIDER) {
  // Skip rather than fail — new articles show as "just in" until a run has a key.
  console.warn('No XAI_API_KEY or ANTHROPIC_API_KEY set — skipping summarization for this run.');
  process.exit(0);
}

const XAI_MODEL = process.env.XAI_MODEL || 'grok-4.1-fast';
const ANTHROPIC_MODEL = 'claude-haiku-4-5';
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

const SYSTEM = `You are the editor of KeepUp, an enterprise-AI news briefing written for both newcomers and expert practitioners. For the given article, return a single JSON object with exactly these keys:
- summary: 2-3 plain-English sentences a layman can follow, grounded ONLY in the provided text. Never invent facts, numbers, or quotes.
- enterpriseAngle: 1-2 sentences on what this means for enterprise security and/or product development teams.
- beginner: one sentence takeaway for someone new to AI.
- advanced: one actionable sentence for an experienced practitioner.
- tags: an array of 1-4 strings, each chosen ONLY from: ${TAGS.join(', ')}.
Be accurate, concise, and neutral. If the source text is thin, summarize only what it supports. Output JSON only — no prose, no code fences.`;

function userPrompt(a) {
  return `Source: ${a.sourceName}\nTitle: ${a.title}\nPublished: ${a.publishedAt}\nURL: ${a.url}\n\n` +
    `Article text:\n${(a.contentText || '').slice(0, 6000)}`;
}

async function postJSON(url, headers, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (res.status === 429 || res.status >= 500) {
      const wait = (Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return await res.json();
  }
  throw new Error('exhausted retries');
}

// Grok (xAI) — OpenAI-compatible chat completions with JSON mode.
async function summarizeGrok(a) {
  const data = await postJSON('https://api.x.ai/v1/chat/completions',
    { Authorization: `Bearer ${XAI_KEY}`, 'content-type': 'application/json' },
    {
      model: XAI_MODEL,
      max_tokens: 800,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt(a) }],
    });
  const text = data.choices?.[0]?.message?.content || '';
  const u = data.usage || {};
  return { parsed: JSON.parse(text), usage: { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 } };
}

// Claude (Anthropic) — structured outputs guarantee schema-valid JSON.
async function summarizeClaude(a) {
  const data = await postJSON('https://api.anthropic.com/v1/messages',
    { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    {
      model: ANTHROPIC_MODEL,
      max_tokens: 800,
      system: SYSTEM,
      messages: [{ role: 'user', content: userPrompt(a) }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    });
  if (data.stop_reason === 'refusal') return { refused: true, usage: { in: 0, out: 0 } };
  const text = (data.content || []).find((b) => b.type === 'text')?.text || '';
  const u = data.usage || {};
  return { parsed: JSON.parse(text), usage: { in: u.input_tokens || 0, out: u.output_tokens || 0 } };
}

const summarize = PROVIDER === 'xai' ? summarizeGrok : summarizeClaude;
const RATE = PROVIDER === 'xai' ? { in: 0.20, out: 0.50 } : { in: 1, out: 5 }; // $/1M tokens
const modelName = PROVIDER === 'xai' ? XAI_MODEL : ANTHROPIC_MODEL;

const store = loadStore();
let pending = store.articles.filter((a) => !a.summary);
if (Number.isFinite(limit)) pending = pending.slice(0, limit);
console.log(`${pending.length} article(s) to summarize via ${PROVIDER} (${modelName}).`);

let inTok = 0, outTok = 0, done = 0, failed = 0;
for (const a of pending) {
  if (!a.contentText || a.contentText.length < 200) {
    const page = await fetchArticleText(a.url);
    if (page.text) a.contentText = page.text;
  }
  try {
    const { parsed, refused, usage } = await summarize(a);
    if (usage) { inTok += usage.in; outTok += usage.out; }
    if (refused || !parsed) { failed++; console.log(`  skip (refused/empty): ${a.title}`); continue; }
    a.summary = parsed.summary;
    a.enterpriseAngle = parsed.enterpriseAngle;
    a.beginner = parsed.beginner;
    a.advanced = parsed.advanced;
    a.tags = (Array.isArray(parsed.tags) ? parsed.tags : []).filter((t) => TAGS.includes(t)).slice(0, 4);
    a.contentText = null;
    done++;
    console.log(`  ok: ${a.title}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL: ${a.title} — ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 300));
}

saveStore(store);
const cost = (inTok / 1e6) * RATE.in + (outTok / 1e6) * RATE.out;
console.log(`\nSummarized ${done}, failed ${failed}. Tokens: ${inTok} in / ${outTok} out (~$${cost.toFixed(4)} on ${modelName}).`);
