# KeepUp

A self-updating website that tracks the latest developments, learnings, and innovation in **enterprise AI** — with every article summarized in plain English, viewed through an **enterprise security and product development lens**, and written for both beginners and advanced practitioners.

Open the site: run `npm run serve` and visit **http://localhost:4173** (or open `site/index.html` directly — it's fully self-contained).

## What it tracks

| Tier | Sources | Cadence |
|------|---------|---------|
| Near-real-time | Anthropic (news + engineering), OpenAI, Google AI, Google DeepMind, xAI/Grok, Cursor (blog + changelog) | Hourly, 7am–10pm |
| Daily | TechCrunch AI, VentureBeat AI, MIT Technology Review, plus a web scan for net-new innovation beyond the big labs | Twice daily (7:30am, 4:30pm) |

Every article gets: a layman summary · an enterprise lens (security + product implications) · a beginner takeaway · an advanced practitioner takeaway · topic tags. The site has a beginner/advanced mode toggle, source filters, tag filters, full-text search, and a "Start here" primer with a glossary.

## How it works

```
config/sources.json      # feed/scrape source definitions and limits
pipeline/fetch.js        # pulls RSS feeds, the Anthropic sitemap, and scraped pages; adds new articles
pipeline/pending.js      # lists articles that still need summaries
pipeline/apply-summaries.js  # merges summaries (or adds curated finds) into the store
pipeline/build.js        # renders site/index.html from data + site-src/template.html
pipeline/serve.js        # tiny static server (respects PORT env var)
data/articles.json       # the article store (single source of truth)
```

Summaries are written by Claude, not by a script: two **scheduled tasks** (managed in the app's "Scheduled" sidebar) run the pipeline and write the summaries each cycle:

- `keepup-vendor-watch` — hourly vendor check (near-real-time for major LLM vendors)
- `keepup-daily-digest` — twice-daily full refresh + web search for innovations outside the tracked sources, plus pruning of items older than 60 days

Scheduled tasks run while the Claude app is open; missed runs execute on next launch. Tip: click **Run now** on each task once to pre-approve its tool permissions so future runs never stall on prompts.

## Manual update

Ask Claude: *"Run a KeepUp update"* — or run the mechanical parts yourself:

```sh
npm run fetch      # pull new articles (add -- --tier realtime for vendors only)
npm run pending    # see what needs summarizing
npm run build      # regenerate the site
```

## Notes & known quirks

- **xAI** (x.ai) 403-blocks all scripted fetching; the scheduled tasks cover it via web search instead.
- **Anthropic** has no RSS feed, so we use its sitemap; `lastmod` dates there can differ from real publish dates — the summarization pass corrects them.
- The **Cursor** blog/changelog scrapers occasionally pick up junk entries (pagination links, category labels); the scheduled tasks clean these up.
- Summaries are AI-written for clarity — the site links every piece to its original source.
