# CodeFlowMu Open Edition Scope

CodeFlowMu Open Dev Team Edition is a local multi-agent software development
tool built around Cursor access and the FCoP protocol.

It is not the private mother repository. It is not a workspace for developing
CodeFlowMu itself. It is the public application package used to coordinate a
fixed local development team around user projects.

## Fixed Product Shape

- Edition: `open-dev-team`
- Product version: `V1.0.0-open`
- npm package version: `1.0.0-open`
- Provider boundary: Cursor SDK first
- Development team: PM / DEV / OPS / QA
- Independent observer: EVAL
- Default project: `projects/newproject`
- Runtime URL: `http://127.0.0.1:18765/`
- Mobile entry: supported
- Gateway: official demo / limited-use mode only by default

## Project Boundary

The open tool root is protected:

```text
D:\CodeFlowMu-open
```

The default writable project is:

```text
D:\CodeFlowMu-open\projects\newproject
```

Users may also add their own external project roots. Tasks, reports, FCoP
initialization files, attachments, and agent sessions belong to the project
root, not to the protected tool root.

## First-Run Goal

On first launch, the user should be guided to:

1. confirm the default project or add another project root;
2. enter the Cursor API key;
3. initialize the FCoP Open Dev Team;
4. start using PM / DEV / OPS / QA for project development while EVAL observes independently;
5. optionally open the mobile entry.

## 中文摘要

CodeFlowMu 开源版是一个确定的、基于 Cursor 入口和 FCoP 协议的多 Agent
软件开发应用。它保护 `CodeFlowMu-open` 工具根目录，默认把项目开发工作放到
`projects/newproject`，也允许用户添加自己的外部项目目录；已登记的旧版 `workspace/<项目>` 保持原地兼容。
