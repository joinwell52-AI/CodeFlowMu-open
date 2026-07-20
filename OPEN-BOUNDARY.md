# CodeFlowMu Open Boundary / 开源版边界

CodeFlowMu Open is an application tool. The install directory is not a development target.

CodeFlowMu Open 是一个应用工具。安装目录不是开发项目目录。

## Read-only install area / 只读安装区

These files and folders are owned by CodeFlowMu release updates. Agents must not modify them:

以下文件和目录由 CodeFlowMu 发版更新接管，Agent 不允许修改：

- `.codeflowmu/`
- `adoptedSource/`
- `codeflowmu-shell/`
- `codeflowmu-desktop/`
- `docs/`
- install-root `fcop/`
- `packages/`
- root release files such as `package.json`, `VERSION.json`, `START-CODEFLOWMU-OPEN.bat`

## Writable project area / 可写项目区

All development writes happen inside the active project root:

所有开发写入都发生在当前项目根目录：

- `projects/<project>/**`
- legacy `workspace/<project>/**` (kept in place; never moved automatically)
- external project roots explicitly added in Settings
- project `fcop/**` ledger after initialization
- project `.cursor/rules/**` deployed during initialization

## Runtime rule / 运行时规则

The Open install-integrity shell snapshots release-owned code before Runtime starts. If an Agent changes, deletes, links over, or injects code in that area, the shell restores the startup baseline and records a security event. Normal project tools remain available. CodeFlowMu Open upgrades replace the install area from the public repository; customer project files are preserved outside that boundary.
