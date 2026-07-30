---
name: web-research
description: Orchestrate web search and web extraction to produce evidence-based conclusions or reports with traceable source URLs. Use for web research, market or competitor scans, current-fact verification, technical investigation, policy research, multi-source comparison, dynamic-page research, table-backed analysis, or any answer that must cite web sources.
---

# Web Research

Run an end-to-end research workflow by combining `web-search` and `web-extract`. Produce conclusions that remain traceable to the underlying webpages.

## Workflow

1. Define the research question, decision to support, scope, freshness requirement, and expected report shape.
2. Use the `web-search` procedure to construct queries and select authoritative, diverse sources.
3. Use the `web-extract` procedure on the selected URLs:
   - Open webpages.
   - Use Playwright only for dynamic content when needed.
   - Extract relevant正文.
   - Extract relevant tables with headers and units.
   - Preserve `source_url` on every evidence item.
   - Set explicit extraction quality gates; reject weak pages instead of treating navigation text as evidence.
4. Compare sources. Resolve differences using source authority, dates, definitions, methods, and directness of evidence.
5. Separate verified facts, reasonable inferences, conflicting evidence, and unknowns.
6. Form conclusions only from extracted evidence. Attach one or more source URLs to each material claim.
7. Write the requested answer or report with findings, evidence, limitations, and source list.
8. When operating inside an agent task, use the available report tool and include source URLs in the report body or structured evidence.
9. Do not generate a site-specific `.mjs` probe for normal work; configure the shared web tools instead.
10. When the research hierarchy is known, execute it in dependency order. Complete the inventory layer before sampling descendants, and continue automatically while each next step is read-only and in scope.

## Research Report Contract

```markdown
## Research Question
<question and scope>

## Method
<queries, source-selection rule, retrieval date, dynamic-page use>

## Findings
1. <finding> [source](source_url)
2. <finding> [source](source_url)

## Table Evidence
<normalized table or comparison, with source_url for each source/table>

## Conclusion
<answer, recommendation, or decision support>

## Uncertainty And Conflicts
<unknowns, stale data, conflicting definitions, inaccessible sources>

## Sources
- <title> - <source_url>
```

## Source Discipline

- Every material factual claim must be supported by an extracted source.
- Use exact dates when freshness affects the conclusion.
- Prefer primary and official sources; use secondary sources for context or comparison.
- Clearly label inference rather than presenting it as a sourced fact.
- Do not cite a search result that was never opened and checked.
- Do not cite a URL that does not support the associated claim.

## Completion Criteria

- Searches were purposeful and recorded.
- Selected pages were opened and inspected.
- Dynamic content used Playwright only where necessary.
- Relevant正文 and tables were extracted.
- Every evidence item retained `source_url`.
- Conclusions distinguish fact, inference, conflict, and uncertainty.
- The final answer or report includes usable source links.
- The workflow did not stop at a proposed method when the next research action was already authorized and executable.
