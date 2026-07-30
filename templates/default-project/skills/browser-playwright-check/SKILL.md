---
name: browser-playwright-check
description: Use when an agent needs to operate or verify a web page with Playwright, including screenshots, viewport checks, navigation, forms, clicks, canvas visibility, responsive layout, or local Panel/browser behavior.
---

# Browser Playwright Check

## When to use

Use when the task requires browser-visible evidence or interactive web verification.

Typical triggers:

- Open a local HTML file or dev-server URL in a browser.
- Click through UI, fill a form, test navigation, or inspect page state.
- Capture screenshots for evidence.
- Verify responsive layouts across desktop and mobile viewports.
- Check canvas, media, animation, or visual nonblank rendering.
- Diagnose Panel or web app behavior that cannot be proven by static code reading.

## Rules

- Prefer an existing project test command if it already uses Playwright.
- If no test exists, write the smallest ad hoc Playwright check needed for evidence.
- Use stable selectors where available; otherwise use visible text, roles, or narrow DOM queries.
- Verify behavior, not only file existence.
- Capture evidence: command output, screenshot paths, viewport sizes, URL, and pass/fail notes.
- Keep browser automation scoped to local/dev URLs or explicit user-provided URLs.
- Do not require network access unless the task explicitly depends on a remote page.
- Do not hide flaky or unverified criteria in the final report.

## Required output

When reporting, include:

- URL or local file opened.
- Viewports tested.
- Interactions performed.
- Evidence paths for screenshots or traces when captured.
- Any untested or flaky criteria.

## Forbidden actions

- Do not use Playwright as a substitute for code review when source inspection is required.
- Do not perform destructive UI actions unless explicitly authorized.
- Do not log secrets, session tokens, cookies, or private form data.
- Do not mark a visual/UI task done without at least one browser-visible verification when a browser can run locally.

## Minimal example

```text
Check: open http://127.0.0.1:5173, click "Submit", verify success toast
Viewport: 1280x720 and 390x844
Evidence: screenshots/playwright-submit-desktop.png
Result: pass
```
