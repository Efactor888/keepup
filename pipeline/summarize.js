// Fills in missing summaries by calling an LLM API with structured JSON output.
// Self-contained: raw HTTPS via fetch, no SDK dependency. Runs in CI after
// fetch.js and before build.js — this replaces the manual summarization pass so
// the pipeline is fully automated.
//
// Provider is chosen from whichever key is present (first match wins):
//   GEMINI_API_KEY     -> Google Gemini (free tier, no card). Model: $GEMINI_MODEL or gemini-2.5-flash.
//   XAI_API_KEY        -> Grok (api.x.ai, OpenAI-compatible). Model: $XAI_MODEL or grok-4.1-fast.
//   ANTHROPIC_API_KEY  -> Claude (Haiku 4.5).
//   none               -> skip gracefully (build/deploy still run).
//
// Usage: GEMINI_API_KEY=... node pipeline/summarize.js [--limit N]

import { loadStore, saveStore, fetchArticleText } from './util.js';

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const XAI_KEY = process.env.XAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
// Auto-precedence Gemini -> Grok -> Claude, unless SUMMARIZE_PROVIDER forces one
// (useful when Gemini's daily free quota is exhausted and a fallback key is set).
const KEYS = { gemini: GEMINI_KEY, xai: XAI_KEY, anthropic: ANTHROPIC_KEY };
const FORCE = (process.env.SUMMARIZE_PROVIDER || '').toLowerCase();
const PROVIDER = (FORCE && KEYS[FORCE]) ? FORCE
  : (GEMINI_KEY ? 'gemini' : XAI_KEY ? 'xai' : ANTHROPIC_KEY ? 'anthropic' : null);

if (!PROVIDER) {
  // Skip rather than fail — new articles show as "just in" until a run has a key.
  console.warn('No GEMINI_API_KEY / XAI_API_KEY / ANTHROPIC_API_KEY set — skipping summarization.');
  process.exit(0);
}

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const XAI_MODEL = process.env.XAI_MODEL || 'grok-4.1-fast';
const ANTHROPIC_MODEL = 'claude-haiku-4-5';
const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;

const TAGS = [
  'model-release', 'agents', 'security', 'enterprise', 'partnership', 'coding', 'research',
  'product', 'policy', 'infrastructure', 'funding', 'science', 'benchmark', 'governance',
  'workforce', 'consumer', 'hardware', 'learning', 'digest',
];

// JSON Schema (Anthropic-style) for Claude structured outputs.
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

// Gemini responseSchema uses UPPERCASE types and no additionalProperties.
const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    enterpriseAngle: { type: 'STRING' },
    beginner: { type: 'STRING' },
    advanced: { type: 'STRING' },
    tags: { type: 'ARRAY', items: { type: 'STRING', enum: TAGS } },
  },
  required: ['summary', 'enterpriseAngle', 'beginner', 'advanced', 'tags'],
  propertyOrdering: ['summary', 'enterpriseAngle', 'beginner', 'advanced', 'tags'],
};

const SYSTEM = `You are the editor of KeepUp, an enterprise-AI news briefing written for both newcomers and expert practitioners. For the given article, return a single JSON object with exactly these keys:
- summary: 2-3 plain-English sentences a layman can follow, grounded ONLY in the provided text. Never invent facts, numbers, or quotes.
- enterpriseAngle: 1-2 sentences on what this means for enterprise security and/or product development teams.
- beginner: one sentence takeaway for someone new to AI.
- advanced: one actionable sentence for an experienced practitioner.
- tags: an array of 1-4 strings, each chosen ONLY from: ${TAGS.join(', ')}. Apply "security" ONLY when the article is genuinely about cybersecurity — vulnerabilities, prompt injection, data protection or leakage, model safeguards/misuse, threat intelligence, or security compliance controls. Do NOT tag general enterprise, product, partnership, or funding news as "security".
Be accurate, concise, and neutral. If the source text is thin, summarize only what it supports. Output JSON only — no prose, no code fences.`;

function userPrompt(a) {
  return `Source: ${a.sourceName}\nTitle: ${a.title}\nPublished: ${a.publishedAt}\nURL: ${a.url}\n\n` +
    `Article text:\n${(a.contentText || '').slice(0, 6000)}`;
}

async function postJSON(url, headers, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (res.status === 429 || res.status >= 500) {
      const wait = (Number(res.headers.get('retry-after')) || 2 ** attempt * 3) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return await res.json();
  }
  throw new Error('exhausted retries');
}

// Google Gemini — free tier, structured JSON via responseSchema.
async function summarizeGemini(a) {
  const data = await postJSON(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    { 'x-goog-api-key': GEMINI_KEY, 'content-type': 'application/json' },
    {
      system_instruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt(a) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: GEMINI_SCHEMA,
        maxOutputTokens: 1200,
        temperature: 0.3,
        // Gemini 2.5 Flash "thinks" by default and spends the output budget on it,
        // truncating the JSON. Disable it — this is a simple structured task.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
  const cand = data.candidates?.[0];
  if (!cand || cand.finishReason === 'SAFETY' || data.promptFeedback?.blockReason) {
    return { refused: true, usage: { in: 0, out: 0 } };
  }
  const text = cand.content?.parts?.map((p) => p.text || '').join('') || '';
  const u = data.usageMetadata || {};
  return { parsed: JSON.parse(text), usage: { in: u.promptTokenCount || 0, out: u.candidatesTokenCount || 0 } };
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

const IMPL = { gemini: summarizeGemini, xai: summarizeGrok, anthropic: summarizeClaude };
const RATE = { gemini: { in: 0, out: 0 }, xai: { in: 0.20, out: 0.50 }, anthropic: { in: 1, out: 5 } }; // $/1M
const MODEL = { gemini: GEMINI_MODEL, xai: XAI_MODEL, anthropic: ANTHROPIC_MODEL };
const PACE = PROVIDER === 'gemini' ? 7000 : 300; // Gemini free tier caps req/min; stay well under

const summarize = IMPL[PROVIDER];

const store = loadStore();
// Interleave pending articles by source (round-robin, newest-first within each
// source) so low-volume sources like OpenAI/Google aren't starved by high-volume
// scraped sources when a per-run --limit applies.
const bySource = {};
for (const a of store.articles.filter((a) => !a.summary)) {
  (bySource[a.source] ||= []).push(a); // store is already date-sorted desc
}
let pending = [];
for (let more = true; more; ) {
  more = false;
  for (const src of Object.keys(bySource)) {
    const next = bySource[src].shift();
    if (next) { pending.push(next); more = true; }
  }
}
if (Number.isFinite(limit)) pending = pending.slice(0, limit);
console.log(`${pending.length} article(s) to summarize via ${PROVIDER} (${MODEL[PROVIDER]}).`);

let inTok = 0, outTok = 0, done = 0, failed = 0, quotaStrikes = 0;
for (const a of pending) {
  if (quotaStrikes >= 5) {
    console.log('Stopping early: provider quota appears exhausted (5 consecutive retry failures). Remaining articles will be picked up next run.');
    break;
  }
  if (!a.contentText || a.contentText.length < 200) {
    const page = await fetchArticleText(a.url);
    if (page.text) a.contentText = page.text;
  }
  try {
    const { parsed, refused, usage } = await summarize(a);
    quotaStrikes = 0;
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
    if (/exhausted retries/.test(e.message)) quotaStrikes++;
    console.log(`  FAIL: ${a.title} — ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, PACE));
}

saveStore(store);
const cost = (inTok / 1e6) * RATE[PROVIDER].in + (outTok / 1e6) * RATE[PROVIDER].out;
const costStr = PROVIDER === 'gemini' ? '$0 (free tier)' : `~$${cost.toFixed(4)}`;
console.log(`\nSummarized ${done}, failed ${failed}. Tokens: ${inTok} in / ${outTok} out (${costStr} on ${MODEL[PROVIDER]}).`);
