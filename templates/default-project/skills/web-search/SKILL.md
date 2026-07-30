---
name: web-search
description: Construct focused search queries, search the public web, and select credible sources. Use when an agent needs to discover webpages, official documentation, current information, competing viewpoints, or candidate sources before opening and extracting them.
---

# Web Search

Find the smallest credible source set that can answer the research question. This skill discovers and selects sources; it does not extract full page content or write the final research report.

## Workflow

1. Convert the request into one or more answerable research questions.
2. Identify unstable facts that require current web verification.
3. Construct focused queries using the subject, required fact, date or version, geography, and preferred source type.
4. Search broadly enough to discover alternatives, then narrow quickly.
5. Prefer sources in this order when applicable:
   - Official documentation, standards, laws, datasets, or first-party announcements.
   - Primary research papers or original technical sources.
   - Reputable organizations with direct evidence.
   - High-quality secondary analysis for context or disagreement.
6. Check title, publisher, publication date, event date, snippet relevance, and URL before selecting a source.
7. Remove duplicates, mirrors, SEO pages, and sources that merely repeat another source.
8. Hand selected URLs and the reason for selection to `web-extract` or `web-research`.

## Query Rules

- Use one intent per query where possible.
- Add official domains or source-type terms when authority matters.
- Add exact product versions, model names, dates, or error strings when precision matters.
- For contested questions, search for both supporting and contradicting evidence.
- Stop expanding queries once the selected sources are sufficient and authoritative.

## Output Contract

For every selected result, preserve:

```json
{
  "query": "the query used",
  "title": "result title",
  "source_url": "https://example.com/page",
  "publisher": "source owner",
  "published_at": "known date or null",
  "source_type": "official|primary|secondary",
  "selection_reason": "why this source is useful"
}
```

## Guardrails

- Do not treat search snippets as evidence for the final conclusion.
- Do not invent publication dates, publishers, or URLs.
- Do not select many weak sources when one authoritative source is available.
- Do not use `browser-playwright-check` as a substitute for source discovery.
