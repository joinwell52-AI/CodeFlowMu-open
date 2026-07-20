# Common Agent Playbook Skills

These sixteen common skills are behavior contracts. Status describes current implementation maturity and must not overstate runtime capability.

| Skill | Purpose | Status | MCP / runtime mapping |
|---|---|---|---|
| `read_context` | Read thread, task, report, ledger, and local context before acting. | `playbook_stub` | `pm.summarize_thread` |
| `read_task` | Read a TASK file and extract sender, recipient, scope, acceptance, and boundaries. | `partially_implemented` | `fcop.read_task` |
| `write_report` | Write a truthful handoff report with evidence and stop. | `partially_implemented` | `fcop.write_report`, `pm.close_admin_task`, `pm.review_check` |
| `attach_evidence` | Link files, logs, screenshots, tests, and commands to claims. | `playbook_stub` | `pm.review_check` |
| `browser-playwright-check` | Operate or verify web pages with Playwright, screenshots, viewports, navigation, forms, and browser-visible evidence. | `playbook_stub` | none |
| `run-local-command-check` | Run local commands for tests, typechecks, builds, scripts, or diagnostics and report truthful command evidence. | `playbook_stub` | none |
| `code-search-navigation` | Locate files, symbols, routes, call sites, tests, and ownership boundaries before editing. | `playbook_stub` | none |
| `test-selection` | Choose focused or broader verification scope after changes, including skipped checks and residual risk. | `playbook_stub` | none |
| `summarize_logs` | Compress noisy logs into verifiable evidence. | `playbook_stub` | none |
| `detect_blocked` | Classify blocked state and owner. | `playbook_stub` | `pm.detect_thread_stall` |
| `create_followup_request` | Ask downstream or upstream for missing work through a controlled task or wake path. | `partially_implemented` | `fcop.write_task`, `pm.wake_downstream` |
| `classify_issue_scope` | Suggest whether an issue belongs to local CodeFlowMu, FCoP, or neither. | `playbook_stub` | EVAL issue workflow |
| `create_issue_draft` | Generate an internal issue draft only. | `partially_implemented` | EVAL three actions / issue draft logic |
| `safe_public_draft` | Check public-facing drafts for secrets, private paths, and sensitive context. | `playbook_stub` | planned issue safety check |
| `update_frontmatter` | Update allowed metadata without changing task truth or lifecycle meaning. | `partially_implemented` | `fcop.update_frontmatter` |
| `respect_mutation_boundary` | Keep agents inside allowed file, lifecycle, role, and governance boundaries. | `playbook_stub` | lifecycle authority docs |

## Shared Rules

- Playbook skills describe behavior; they do not create Panel/API runtime features.
- Runtime skills may support a playbook, but do not replace ADMIN acceptance.
- EVAL can suggest promotion; ADMIN or Panel performs final public or governance action.
- REPORT, TASK, EVAL, ISSUE, REVIEW, and lifecycle state must not be confused.
