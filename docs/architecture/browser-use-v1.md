# Browser Use V1 Architecture

```text
Cursor Agent
  │ browser.* MCP
  ▼
Browser Use MCP (TypeScript)
  ├─ target/origin policy
  ├─ structured login profile
  ├─ secure credential fill
  ├─ bounded DOM observation
  ├─ upload and action guards
  └─ audit/session pause boundary
       │ Playwright, headless=false
       ├─ Chrome managed profile
       └─ Edge managed profile
```

## Ownership

- Browser Use owns Web targets, HTTPS origins, DOM interaction and browser profiles.
- Login behavior is recorded as semantic before/after state: entry URL, field labels, tenant selection, submit label, success URL and optional success text. Secret values and coordinates are excluded.
- The user-facing lifecycle is shared with Windows Use (`start → perform once → finish → review`), while Web uses DOM/Playwright and native apps use Windows UI Automation collectors.
- Windows Use owns native EXE targets and Windows UI Automation.
- Cursor is the only mounted Agent entry in V1. The capability bus can add other entries later without changing the tool contract.

## Digital employee, not crawler

The Host uses Playwright as an interaction transport. It exposes only visible bounded controls, performs user-like browser actions, and verifies UI state. It does not expose raw network interception, arbitrary JavaScript, hidden API calls, unrestricted HTML export, link crawling, or bulk extraction tools.

## Trust boundaries

1. Project configuration authorizes target IDs and HTTPS origins.
2. The MCP server launches only configured Chrome/Edge executables with managed profiles.
3. Every tab action revalidates the active origin.
4. Passwords stay in local `.env` and are filled inside the Host.
5. Upload accepts explicit existing files only and relies on Agent confirmation policy for transmission.
6. Session pause rejects further tools until explicit resume.
