# Open Release Content Boundary

The mother repository releases the open edition as a complete public package.
Each release should update both the runnable application and the public GitHub
materials.

## Included In A Release

- app source required to run the Open Dev Team Edition
- web panel assets
- shell/runtime source required by open startup
- public FCoP protocol and team initialization templates
- root README / install docs
- public articles under `docs/articles/`
- product screenshots and public images under `docs/images/`
- version metadata: `VERSION.json`, `RELEASES.md`, and `RELEASE_MANIFEST.json`

## Preserved During Local Update

The open release uses a full replacement strategy, while preserving local state:

- `.git/`
- `node_modules/`
- `.venv/` and `venv/`
- `.env` and `.env.*`
- `.codeflowmu/mobile-gateway.json`
- `workspace/`
- external project roots outside `CodeFlowMu-open`

## Excluded From Public Release

- private gateway credentials
- real internal tasks, reports, logs, chat history, and reviews
- company-only release automation secrets
- mother-repository open-plan documents
- internal evaluation / observation streams

## 中文摘要

公开发版不是单纯复制代码。它必须同时更新可运行应用、README、安装说明、公开
文章、截图素材和版本记录。用户本地更新采用全量替换应用文件，但保留 Git 历史、
依赖、虚拟环境、本地配置、`workspace/` 和外部项目目录。
