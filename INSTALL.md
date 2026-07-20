# Install CodeFlowMu Open Dev Team Edition

Version: `V1.1.10-open`

## Requirements

- Windows 10/11 recommended for the bundled launcher
- Node.js 22+
- Python 3.10+
- Git
- Cursor SDK access for local agent execution

## Recommended Windows Install

```bat
git clone https://github.com/joinwell52-AI/CodeFlowMu-open.git
cd CodeFlowMu-open
START-CODEFLOWMU-OPEN.bat
```

Current policy: one standard CodeFlowMu Open installation per computer.
Use the default install root `D:\CodeFlowMu-open` on Windows. Multiple local
installations are not supported in `V1.0.0-open`, because they would need
separate ports, runtime data directories, upgrade targets, and local caches.

The launcher checks Node.js and npm, creates `.venv` when needed, installs the Python `fcop` package, runs `npm install` when needed, and starts the local panel.

Default URL:

```text
http://127.0.0.1:18765/
```

## Manual Install

```bash
git clone https://github.com/joinwell52-AI/CodeFlowMu-open.git
cd CodeFlowMu-open
npm install
npm start
```

On Windows, `npm start` first looks for `.venv\Scripts\python.exe`, then falls back to `where.exe python`. If Python is installed elsewhere, set `PYTHON_BIN` to the full `python.exe` path before starting.

## First-Run Initialization

The open edition is a tool install directory. It is not the project you ask agents to edit.

On first launch, the launcher resets generated open-edition runtime caches and preserves source code, Git history, `node_modules`, and `.venv`.

After the panel opens:

1. Open `Settings -> General`.
2. Enter your Cursor API Key and save. A green check means the key was verified and model list was loaded through the Cursor SDK.
3. Open `Settings -> Projects`.
4. Use the initialized default `projects/newproject`, click `New Independent Project` (defaults to `projects/<name>`), or add existing source. Registered legacy `workspace/<project>` paths stay in place.
5. Switch explicitly to the target project and wait for Runtime adaptation to finish before publishing a TASK.
6. Run environment check; initialize or repair FCoP only when the panel reports it is required.

Tasks, reports, FCoP files, attachments, agent sessions, and Runtime state are written to the active project root. Runtime uses `<active-project>/.codeflowmu/runtime`; projects with the same folder name never share Agent/session state.

The application install root is protected by an integrity shell, without reducing Agent capabilities inside the active project. If the Cursor API Key is missing, tasks remain in inbox and the panel asks for configuration. PM final reports automatically generate EVAL closeout observations; the manual EVAL action is a retry/refresh control.

## Update Policy

Open edition updates are full replacement updates.

User update flow:

```bash
cd CodeFlowMu-open
git pull
npm install
START-CODEFLOWMU-OPEN.bat
```

The update replaces application files, panel assets, shell/runtime source, docs, and public initialization templates.

The update preserves:

- `.git/`
- `node_modules/`
- `.venv/` and `venv/`
- `.env` and `.env.*`
- `.codeflowmu/mobile-gateway.json`
- `projects/`
- legacy `workspace/`
- external project roots outside `CodeFlowMu-open`

To force a clean open-edition tool runtime after an update, delete:

```text
.codeflowmu/open-runtime-initialized.flag
```

Then run `START-CODEFLOWMU-OPEN.bat` again.

## Provider Boundary

The open edition fixes:

```text
CODEFLOW_PROVIDER=cursor
```

Google Gen AI, Claude Code, OpenRouter provider switching, private Gateway credentials, internal observation/evaluation flows, and company release tooling belong to the private mother edition.

## Local Port Boundary

Open edition:

```text
http://127.0.0.1:18765/
```

Private mother edition:

```text
http://127.0.0.1:18766/
```

The two local editions must not share the same port, FCoP state, runtime state, or workspace state.
