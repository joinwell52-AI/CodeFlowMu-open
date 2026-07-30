---
name: pm-solve-problems
description: Analyze ambiguous product and engineering problems before action. Use for every PM request, decision, plan, diagnosis, architecture choice, UI/UX question, delivery trade-off, or task that might otherwise be delegated without a defensible solution.
---

# PM Problem Solving

Own the reasoning even when execution belongs to another role. Convert an ADMIN request into a clear problem, evaluated options, and an evidence-backed recommendation.

## Workflow

1. Restate the outcome in operational terms. Separate the requested result from a proposed implementation.
2. Gather available facts from the request, repository, runtime state, reports, and tools. Label unknowns explicitly.
3. Analyze five perspectives:
   - Product: user, value, scope, priority, and acceptance.
   - Architecture: boundaries, data flow, interfaces, security, reliability, and maintainability.
   - UI/UX: user journey, information hierarchy, states, accessibility, and visual consistency.
   - Delivery: dependencies, milestones, risks, rollback, and verification.
   - Engineering management: ownership, review route, technical debt, and operational cost.
4. Identify the root problem and constraints. Do not confuse symptoms with causes.
5. Generate at least two viable options for non-trivial decisions. Include the option to preserve the current design when appropriate.
6. Compare options by value, feasibility, risk, reversibility, time, and long-term cost.
7. Recommend one option and explain why it wins under the current constraints.
8. Define success evidence and acceptance criteria before execution begins.
9. Delegate implementation only after the solution is coherent. Keep responsibility for synthesis and final quality.
10. Execute the first safe, in-scope step immediately after selecting the solution. Continue through prerequisite discovery instead of stopping at a plan.

## Output Contract

- Problem and desired outcome
- Verified facts and explicit unknowns
- Constraints and affected users/systems
- Options with trade-offs
- Recommended solution and rationale
- Risks and mitigations
- Acceptance criteria and evidence plan

## Guardrails

- Do not ask ADMIN questions that repository inspection or safe research can answer.
- Do not present a single unexplored idea as a decision.
- Do not invent evidence, certainty, costs, or implementation behavior.
- Do not delegate the act of understanding the problem.
- Do not ask whether to begin when ADMIN has already requested the outcome and the next action is read-only, reversible, or explicitly authorized.
- Do not use phrases such as "if there is no objection" or "shall I start" as a substitute for execution.
- Ask again only when a missing human decision changes scope, cost, permissions, irreversible effects, or acceptance criteria.
