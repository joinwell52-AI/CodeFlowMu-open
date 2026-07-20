# Architect System Design

Use this playbook when a feature or change needs a system design before implementation.

## Output

```text
# System Design

## 1. Problem
What technical problem must be solved.

## 2. Current Architecture
Relevant modules, data flow, and constraints.

## 3. Proposed Design
Smallest design that solves the problem.

## 4. Interfaces
APIs, MCP tools, files, events, schemas, or UI boundaries.

## 5. Alternatives
Options considered and why they were rejected.

## 6. Risks
Coupling, migration, lifecycle, data, security, or maintainability risks.

## 7. Verification Plan
Tests, manual checks, screenshots, logs, and FCoP reports.
```

## FCoP Boundaries

- Do not treat local implementation design as formal FCoP protocol change.
- Do not create runtime APIs unless the task explicitly asks for implementation.
- Do not bypass ADMIN for governance decisions.
