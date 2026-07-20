# Update CodeFlowMu Open Dev Team Edition

## Policy

Open edition updates are full replacement updates.

The mother repository builds a complete open-edition package, then synchronizes it into the public repository/worktree. The update replaces application source, panel assets, shell/runtime source, docs, and public initialization templates.

## Preserved locally

The update process must preserve:

- `.git/`
- `node_modules/`
- `.venv/` and `venv/`
- `.env` and `.env.*`
- `projects/`
- legacy `workspace/`
- external project roots outside `CodeFlowMu-open`

The install-level `.codeflowmu/mobile-gateway.json` is a product template and is replaced on update. Per-project Gateway identity and credentials remain preserved under `projects/`, legacy `workspace/`, or an external project root.

## User update flow

```bash
cd CodeFlowMu-open
git pull
npm install
START-CODEFLOWMU-OPEN.bat
```

If dependencies changed, `npm install` refreshes Node packages. The launcher checks Python and installs `fcop` plus `fcop-mcp` into `.venv` when needed.

## First-run state after update

An update does not delete your external project. If you need a clean tool runtime, delete:

```text
.codeflowmu/open-runtime-initialized.flag
```

Then run `START-CODEFLOWMU-OPEN.bat` again. The launcher will reset generated open-edition runtime caches only.
