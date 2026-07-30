---
name: web-extract
description: Open selected webpages and extract relevant正文, structured facts, tables, and source URLs. Use when an agent has one or more URLs and needs faithful page content, dynamic-page rendering, table extraction, or citation-ready evidence without yet synthesizing a full research conclusion.
---

# Web Extract

Turn selected webpages into structured, traceable evidence. Preserve the source URL on every extracted item.

## Workflow

1. Open the exact selected URL. Record redirects and use the final canonical URL as `source_url` when known.
2. Inspect page title, publisher, publication or update date, and the content area relevant to the question.
3. Prefer direct page reading or structured extraction for static pages.
4. Use Playwright or an equivalent browser tool only when content requires JavaScript rendering, interaction, pagination, expansion, or scrolling.
5. Extract only relevant正文 and preserve headings that give it meaning.
6. Extract tables as structured rows and columns. Preserve headers, units, notes, and table captions.
7. Separate page facts from interpretation. Keep exact short excerpts minimal and paraphrase the rest.
8. Record extraction gaps such as login walls, robots restrictions, missing dates, truncated tables, or inaccessible content.
9. Define acceptance before extraction. For dynamic pages, use `required_texts`, `min_content_chars`, `min_tables`, or `min_structured_items` with `fail_on_quality=true`.
10. Use `table_contains`, `max_tables`, and `max_table_rows` to keep large comparison pages focused and model-consumable.

## Output Contract

```json
{
  "source_url": "https://example.com/final-page",
  "title": "page title",
  "publisher": "source owner or null",
  "published_at": "known date or null",
  "retrieved_at": "retrieval timestamp",
  "content": [
    {
      "heading": "section heading",
      "text": "relevant extracted or faithfully paraphrased content",
      "source_url": "https://example.com/final-page"
    }
  ],
  "tables": [
    {
      "caption": "table caption or null",
      "columns": ["column A", "column B"],
      "rows": [["value A", "value B"]],
      "source_url": "https://example.com/final-page"
    }
  ],
  "extraction_notes": []
}
```

## Dynamic Pages

- Use Playwright as a low-level extraction tool, not as the research methodology.
- Perform the minimum interaction required to reveal the relevant content.
- Prefer `wait_for_selector` or `wait_for_text` over fixed sleeps. Use `click_texts` and `auto_scroll` only when required.
- Request `screenshot_path` when visual evidence is part of acceptance.
- Do not submit forms, log in, accept permissions, or trigger external side effects unless explicitly authorized.
- Record the interaction needed to obtain the content.

## Guardrails

- Never return extracted content without `source_url`.
- A page merely being non-empty is not evidence that the requested data was extracted. Require domain facts, tables, or structured items.
- Do not create a one-off `.mjs` scraper for ordinary research. Call `web_extract` with selectors, interactions, table filters, and quality gates. Escalate only when the generic tool cannot express the required interaction.
- For hierarchical catalog research, do not skip directly to a convenient sample. Extract and validate the parent inventory before traversing child pages.
- Do not infer missing table cells or silently repair source data.
- Do not confuse navigation, advertisements, comments, or related links with正文.
- Keep `browser-playwright-check` unchanged; it remains for UI verification rather than research extraction.
