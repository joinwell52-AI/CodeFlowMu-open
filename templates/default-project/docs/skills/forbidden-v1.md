# Forbidden v1 Skills

v1 only creates auditable Playbooks. It does not create autonomous governance.

| Forbidden ID | Risk |
|---|---|
| `auto_github_submit` | Automatically submitting public GitHub issues can leak private context and bypass ADMIN approval. |
| `auto_archive_all` | Bulk archive can hide unfinished work and confuse lifecycle state with business acceptance. |
| `auto_delete_task` | Deleting TASK, REPORT, or EVAL files breaks the audit trail. |
| `auto_role_switch` | Letting a child agent switch sender, recipient, or role code breaks role identity and accountability. |
| `auto_adr` | Automatically generating and adopting ADRs turns observations into protocol decisions without review. |
| `auto_shared` | Automatically writing shared rules can promote local guesses into team norms without acceptance. |
| `auto_emergence_absorb` | Automatically absorbing emergence into official capability bypasses reverse-absorption governance. |
| `large_migration` | Large directory, protocol, or state migrations have high blast radius and need explicit ADMIN planning. |
| `autonomous_governance` | Agent self-governance removes the human decision boundary. |
| `multi_agent_negotiation` | Automatic negotiation over resources or permissions can invent authority that was never granted. |
| `knowledge_graph_build` | Complex knowledge graphs can create opaque, stale, or overfit governance state. |
| `full_runtime_repair` | Rewriting runtime, planner, or lifecycle core logic is too risky for a playbook stub. |

These items must not be registered as skills in v1.
