---
name: windows-use
description: Control approved Windows desktop applications through CodeFlowMu Windows Use tools. Use when a Cursor Agent must inspect, click, type, scroll, invoke UI Automation controls, or capture a window in a native Windows app; do not use for browser-only work when a browser-specific capability is available.
---

# Windows Use

Control only applications the user approved in CodeFlowMu Panel. Treat application approval as permission to access that app, not blanket permission for risky side effects.

## Workflow

1. Call `windows.capabilities` when host readiness is unknown.
2. Call `windows.list_targets` before handling login. Follow `loginMethod`, `verificationChannel`, `loginInstruction`, and `requiresUser`; never infer an authentication flow. A saved password is reported only as a boolean and is never returned.
3. For `qr_code` or verification-code methods, stop at the login step and wait for the user. If the method is `unspecified`, ask the user instead of guessing.
4. To open an approved target, first reuse any window returned by discovery. Call `windows.launch_target` only when the target is not already running. Native launch is idempotent and may return `already_running=true`; never relaunch a minimized, hidden, or initializing application. Web launch only opens the URL—route all page DOM work to a browser-specific capability.
5. For a native target, call `windows.wait_for_app` instead of using Shell sleep, then select the returned `app_id` and `window_id`. Never invent or reuse a stale window identifier.
6. Call `windows.inspect_ui` when labels or standard controls can identify the target. Prefer `windows.invoke_ui`: UI Automation InvokePattern works without taking foreground focus.
7. Only when an operation truly needs foreground input, call `windows.activate`. Never use PowerShell, Alt+Tab, or a terminal to force focus. If activation is blocked, `windows.click` can deliver a bounded window-message fallback, while text/keyboard input must pause for one user click.
8. Use `windows.screenshot` and window-relative coordinates only when UI Automation is insufficient.
9. Batch a small set of related actions, then inspect again to verify the result. Stop after an error or if the user takes over the foreground window.
10. Call `windows.cancel` when the user asks to stop. Claim “paused” only after it returns `paused=true`. This is an MCP-session pause, not project-level disablement. Call `windows.status` to verify; call `windows.resume` only after explicit user instruction.

## Tool selection

- Discover applications: `windows.list_apps`
- Read approved targets and login characteristics: `windows.list_targets`
- Open an approved native or Web target: `windows.launch_target`
- Wait for a launched native window: `windows.wait_for_app`
- Restore and activate a window: `windows.activate`
- Verify/pause/resume the current session: `windows.status`, `windows.cancel`, `windows.resume`
- Observe pixels: `windows.screenshot`
- Read control structure: `windows.inspect_ui`
- Invoke a standard control: `windows.invoke_ui`
- Point interaction: `windows.click`, `windows.scroll`
- Text and keys: `windows.type_text`, `windows.keypress`

Use literal text with `windows.type_text`; use `windows.keypress` for Enter, Tab, Escape, arrows, and chords. Focus the observed editable surface before typing.

## Safety

- Never attempt to authorize an application through the tools. Ask the user to approve it in Panel.
- Never automate terminals, CodeFlowMu, ChatGPT/Codex, authentication dialogs, password managers, Windows security tools, the Run dialog, or permission/security settings.
- Do not bypass CAPTCHA, MFA, paywalls, safety warnings, or access controls.
- Ask for action-time confirmation before deleting data, sending messages, submitting forms, uploading files, changing sharing/access, installing software, making purchases, or transmitting sensitive data unless the user explicitly pre-approved that exact action and destination.
- Stop if the desktop is locked, the target window cannot be activated, observation fails, or the window no longer belongs to the approved application.
- Prefer a browser-specific capability for Chrome or web applications so logged-in browser state and page semantics remain available.

Windows Use actions bring the target app to the foreground. Keep operations bounded and allow immediate user interruption.
