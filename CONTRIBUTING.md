# Contributing to CodeFlowMu Open

Thank you for helping improve CodeFlowMu Open.

Before opening a pull request:

1. Keep changes inside the public-edition boundary described in `OPEN-BOUNDARY.md`.
2. Do not commit credentials, runtime ledgers, user projects, generated caches, or private Gateway code.
3. Install dependencies with `npm ci` from the committed root lockfile.
4. Run the focused tests for the area you changed and describe the evidence in the pull request.
5. Keep Windows Use and Browser Use targets allowlisted; do not weaken their policy boundaries.

Public releases are generated from a clean mother-repository commit. Direct edits in the generated public worktree may be overwritten by the next full replacement release.
