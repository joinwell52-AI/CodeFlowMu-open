/**
 * RoleToolPolicy — PM native-tool hard gate.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  evaluateRoleToolCall,
  recordRoleToolBlocked,
} from "../RoleToolPolicy.ts";

test("PM edit on product path is blocked", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "edit",
    args: { path: "codeflowmu-shell/src/web-panel.ts" },
    projectRoot: "D:/codeflowmu",
  });
  assert.equal(gate.allow, false);
  assert.equal(gate.severity, "block");
  assert.match(gate.reason ?? "", /dispatch implementation work/i);
});

test("PM Set-Content shell write is blocked", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command: "Set-Content codeflowmu-desktop/panel/index.html '<html></html>'",
    },
    projectRoot: "D:/codeflowmu",
  });
  assert.equal(gate.allow, false);
});

test("PM Get-Content read-only shell is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "run_terminal_cmd",
    args: { command: "Get-Content codeflowmu-shell/src/web-panel.ts" },
    projectRoot: "D:/codeflowmu",
  });
  assert.equal(gate.allow, true);
});

test("PM PowerShell directory probe is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'if (Test-Path "D:\\CodeFlowMu-open\\workspace\\newproject") { Get-ChildItem "D:\\CodeFlowMu-open\\workspace\\newproject" -Force | Select-Object Name, Mode } else { Write-Output "DIR_MISSING" }',
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("PM PowerShell sorted directory probe is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'Get-ChildItem -Path "D:\\CodeFlowMu-open\\workspace\\newproject\\fcop\\tasks" -ErrorAction SilentlyContinue | Select-Object Name, LastWriteTime | Sort-Object LastWriteTime -Descending | Select-Object -First 5',
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("PM PowerShell sorted directory probe with write remains blocked", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'Get-ChildItem -Path "D:\\CodeFlowMu-open\\workspace\\newproject" | Sort-Object LastWriteTime; Remove-Item "D:\\CodeFlowMu-open\\workspace\\newproject\\README.md"',
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, false);
});

test("PM PowerShell compound artifact read probe is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'Get-ChildItem -Force "D:\\CodeFlowMu-open\\workspace\\newproject\\smoke-tetris-8" -ErrorAction SilentlyContinue | Format-Table Name,Length,LastWriteTime; if (Test-Path "D:\\CodeFlowMu-open\\workspace\\newproject\\smoke-tetris-8\\index.html") { Get-Content "D:\\CodeFlowMu-open\\workspace\\newproject\\smoke-tetris-8\\README.md" -TotalCount 20 }',
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("PM PowerShell Get-Item artifact verification is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'Get-Item "D:\\CodeFlowMu-open\\workspace\\newproject\\smoke-tetris-9\\index.html","D:\\CodeFlowMu-open\\workspace\\newproject\\smoke-tetris-9\\README.md" | Format-Table Name,Length,LastWriteTime',
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("PM cmd dir bundle probe is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'cmd /c "dir /s /b D:\\CodeFlowMu-open\\docs\\agents 2>nul"; cmd /c "dir /s /b D:\\CodeFlowMu-open\\workspace 2>nul"; cmd /c "dir /b D:\\CodeFlowMu-open\\workspace"; if (Test-Path "D:\\CodeFlowMu-open\\workspace\\newproject") { cmd /c "dir /s /b D:\\CodeFlowMu-open\\workspace\\newproject" }',
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("PM cmd dir bundle with write command remains blocked", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'cmd /c "dir /b D:\\CodeFlowMu-open\\workspace"; cmd /c "del D:\\CodeFlowMu-open\\workspace\\newproject\\x.txt"',
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, false);
});

test("PM cmd dir echo if-exist probe is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'cmd /c "dir /b D:\\CodeFlowMu-open\\workspace\\newproject && echo --- && if exist D:\\CodeFlowMu-open\\workspace\\newproject\\tetris-final (dir /s /b D:\\CodeFlowMu-open\\workspace\\newproject\\tetris-final) else (echo tetris-final: NOT_EXISTS)"',
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("PM Python import/version probe shell is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'python -c "import fcop; print(\'fcop\', fcop.__version__)" 2>&1; python -c "import fcop_mcp; print(\'fcop_mcp ok\')" 2>&1',
    },
    projectRoot: "D:/codeflowmu",
  });
  assert.equal(gate.allow, true);
});

test("PM FCoP read-only project status probe shell is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command: `cd "D:\\CodeFlowMu-open\\workspace\\newproject" && python -c "
from fcop.project import Project
p = Project('.')
print(p.is_initialized())
print(p.status())
print(len(p.list_tasks()))
print(len(p.list_reports()))
" 2>&1`,
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("PM FCoP nonexistent report/check Python API is not allowlisted", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command: `cd "D:\\CodeFlowMu-open\\workspace\\newproject" && python -c "
from fcop.project import Project
p = Project('.')
print(p.report(lang='zh'))
print(p.check(lang='zh'))
" 2>&1`,
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, false);
});

test("PM FCoP one-shot read-only patrol shell is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'python "D:\\CodeFlowMu-open\\packages\\codeflowmu-runtime\\scripts\\fcop_invoke_once.py" "D:\\CodeFlowMu-open\\workspace\\newproject" fcop_report lang=zh 2>&1',
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("PM FCoP one-shot IPC write shell is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'python "D:\\CodeFlowMu-open\\packages\\codeflowmu-runtime\\scripts\\fcop_invoke_once.py" "D:\\CodeFlowMu-open\\workspace\\newproject" write_report reporter=PM recipient=ADMIN 2>&1',
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("PM FCoP one-shot IPC write shell is allowed through PowerShell JSON wrapper", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command: `$ws = "D:\\CodeFlowMu-open\\workspace\\newproject"
$py = "D:\\CodeFlowMu-open\\packages\\codeflowmu-runtime\\scripts\\fcop_invoke_once.py"
$ack = @{
  tool = "write_report"
  arguments = @{
    task_id = "TASK-20260708-999"
    reporter = "PM"
    recipient = "ADMIN"
    body = "ack"
    status = "in_progress"
  }
} | ConvertTo-Json -Compress -Depth 5
python $py $ws $ack
Write-Output "ACK_EXIT=$LASTEXITCODE"`,
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("PM FCoP one-shot IPC temp payload file is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command: `$py = "D:\\CodeFlowMu-open\\packages\\codeflowmu-runtime\\scripts\\fcop_invoke_once.py"
$root = "D:\\CodeFlowMu-open\\workspace\\newproject"
$payloadPath = "$env:TEMP\\fcop-ack-012.json"
$payload = @{
  tool = "write_report"
  arguments = @{
    task_id = "TASK-20260708-012"
    reporter = "PM"
    recipient = "ADMIN"
    body = "ack"
    status = "in_progress"
  }
} | ConvertTo-Json -Compress -Depth 5
Set-Content -Path $payloadPath -Value $payload -Encoding UTF8
python $py $root $payloadPath
Remove-Item $payloadPath -ErrorAction SilentlyContinue`,
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("PM FCoP one-shot temp payload cannot write protected root", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command: `$py = "D:\\CodeFlowMu-open\\packages\\codeflowmu-runtime\\scripts\\fcop_invoke_once.py"
$root = "D:\\CodeFlowMu-open\\workspace\\newproject"
$payloadPath = "$env:TEMP\\fcop-ack-012.json"
Set-Content -Path "D:\\CodeFlowMu-open\\codeflowmu-shell\\bad.txt" -Value "bad"
python $py $root $payloadPath`,
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, false);
});

test("PM ledger review_check shell is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'cd /d D:\\CodeFlowMu-open\\packages\\codeflowmu-runtime && npx --yes tsx scripts/ledger_cli.ts review_check "D:\\CodeFlowMu-open\\workspace\\newproject" --task_id=TASK-20260708-015 --report_id=REPORT-20260708-004',
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("PM ledger wake_downstream_plan shell is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'npx --yes tsx packages/codeflowmu-runtime/scripts/ledger_cli.ts wake_downstream_plan "D:\\CodeFlowMu-open\\workspace\\newproject" "TASK-20260708-003" "DEV" "cold_path_dispatch_smoke"',
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("PM ledger summarize_thread shell is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'npx --yes tsx "D:\\CodeFlowMu-open\\packages\\codeflowmu-runtime\\scripts\\ledger_cli.ts" summarize_thread "D:\\CodeFlowMu-open\\workspace\\newproject" "panel-task-1000"',
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("PM ledger close_admin_task shell is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'npx --yes tsx "D:\\CodeFlowMu-open\\packages\\codeflowmu-runtime\\scripts\\ledger_cli.ts" close_admin_task "D:\\CodeFlowMu-open\\workspace\\newproject" "TASK-20260708-1004" "REPORT-20260708-013"',
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("PM ledger review_check with extra write remains blocked", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'cd /d D:\\CodeFlowMu-open\\packages\\codeflowmu-runtime && npx --yes tsx scripts/ledger_cli.ts review_check "D:\\CodeFlowMu-open\\workspace\\newproject" --task_id=TASK-20260708-015 && del D:\\CodeFlowMu-open\\workspace\\newproject\\README.md',
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, false);
});

test("PM local governance review-check API shell is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'curl -s "http://127.0.0.1:18766/api/v2/pm/governance/review-check?task_id=TASK-20260709-002&report_id=REPORT-20260709-002-DEV-to-PM"',
    },
    projectRoot: "D:/codeflowmu",
  });
  assert.equal(gate.allow, true);
});

test("PM local governance wake-downstream API shell is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'curl -s -X POST "http://127.0.0.1:18766/api/v2/pm/governance/wake-downstream" -H "Content-Type: application/json" -d "{\\"task_id\\":\\"TASK-20260709-002\\",\\"role\\":\\"DEV\\"}"',
    },
    projectRoot: "D:/codeflowmu",
  });
  assert.equal(gate.allow, true);
});

test("PM local governance API shell with file write remains blocked", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        'curl -s "http://127.0.0.1:18766/api/v2/pm/governance/review-check?task_id=TASK-20260709-002"; Set-Content "D:\\codeflowmu\\workspace\\smoke-app\\bad.txt" bad',
    },
    projectRoot: "D:/codeflowmu",
  });
  assert.equal(gate.allow, false);
});

test("PM FCoP probe with write intent remains blocked", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command: `cd "D:\\CodeFlowMu-open\\workspace\\newproject" && python -c "
from fcop.project import Project
open('x.txt', 'w').write('bad')
p = Project('.')
print(p.status())
" 2>&1`,
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, false);
});

test("PM write_task is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "write_task",
    args: { recipient: "DEV", body: "fix panel" },
    projectRoot: "D:/codeflowmu",
  });
  assert.equal(gate.allow, true);
});

test("DEV edit on product path is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "DEV-01",
    toolName: "edit",
    args: { path: "codeflowmu-shell/src/web-panel.ts" },
    projectRoot: "D:/codeflowmu",
  });
  assert.equal(gate.allow, true);
});

test("PM controlled workspace MCP tools are allowed", () => {
  for (const toolName of ["new_workspace", "list_workspaces"]) {
    const gate = evaluateRoleToolCall({
      agentId: "PM-01",
      toolName,
      args:
        toolName === "new_workspace"
          ? { slug: "three-things-smoke", title: "今日三件事" }
          : {},
      projectRoot: "D:/CodeFlowMu-open/workspace/codedaysign",
    });
    assert.equal(gate.allow, true, `${toolName} should be allowed for PM`);
  }
});

test("PM Python os.makedirs is not misclassified as a read-only probe", () => {
  const gate = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "shell",
    args: {
      command:
        `python -c "import os; os.makedirs(r'D:\\codeflowmu\\workspace\\three-things-smoke', exist_ok=True); print('ok')"`,
    },
    projectRoot: "D:/codeflowmu",
  });
  assert.equal(gate.allow, false);
});

test("Open edition still protects release-owned program files", () => {
  const previous = process.env.CODEFLOW_OPEN_EDITION;
  process.env.CODEFLOW_OPEN_EDITION = "1";
  try {
    const gate = evaluateRoleToolCall({
      agentId: "DEV-01",
      toolName: "edit",
      args: { path: "D:/CodeFlowMu-open/codeflowmu-shell/src/main.ts" },
      projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
      protectedRoots: ["D:/CodeFlowMu-open"],
    });
    assert.equal(gate.allow, false);
  } finally {
    if (previous === undefined) delete process.env.CODEFLOW_OPEN_EDITION;
    else process.env.CODEFLOW_OPEN_EDITION = previous;
  }
});

test("Open edition infers the protected host from projects paths with Chinese and spaces", () => {
  const previous = process.env.CODEFLOW_OPEN_EDITION;
  process.env.CODEFLOW_OPEN_EDITION = "1";
  try {
    const projectRoot = "D:/CodeFlowMu-open/projects/中文 Project";
    const projectWrite = evaluateRoleToolCall({
      agentId: "DEV-01",
      toolName: "edit",
      args: { path: `${projectRoot}/src/main.ts` },
      projectRoot,
    });
    assert.equal(projectWrite.allow, true);

    const installWrite = evaluateRoleToolCall({
      agentId: "DEV-01",
      toolName: "edit",
      args: { path: "D:/CodeFlowMu-open/codeflowmu-shell/src/main.ts" },
      projectRoot,
    });
    assert.equal(installWrite.allow, false);
  } finally {
    if (previous === undefined) delete process.env.CODEFLOW_OPEN_EDITION;
    else process.env.CODEFLOW_OPEN_EDITION = previous;
  }
});

test("Open edition blocks PM project-local implementation writes", () => {
  const previous = process.env.CODEFLOW_OPEN_EDITION;
  process.env.CODEFLOW_OPEN_EDITION = "1";
  try {
    const gate = evaluateRoleToolCall({
      agentId: "PM-01",
      toolName: "shell",
      args: {
        command:
          `python -c "import os; os.makedirs(r'D:\\CodeFlowMu-open\\workspace\\codedaysign\\workspace\\demo', exist_ok=True)"`,
      },
      projectRoot: "D:/CodeFlowMu-open/workspace/codedaysign",
    });
    assert.equal(gate.allow, false);
  } finally {
    if (previous === undefined) delete process.env.CODEFLOW_OPEN_EDITION;
    else process.env.CODEFLOW_OPEN_EDITION = previous;
  }
});

test("PM implementation override is path-, task-, reason-, and time-scoped", () => {
  const allowed = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "edit",
    args: {
      path: "src/emergency.ts",
      pm_implementation_override: true,
      approved_by: "ADMIN",
      task_id: "TASK-20260712-001",
      reason: "紧急恢复",
      scope: ["src/emergency.ts"],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
    projectRoot: "D:/projects/demo",
  });
  assert.equal(allowed.allow, true);

  const wrongPath = evaluateRoleToolCall({
    agentId: "PM-01",
    toolName: "edit",
    args: {
      path: "src/other.ts",
      pm_implementation_override: true,
      approved_by: "ADMIN",
      task_id: "TASK-20260712-001",
      reason: "紧急恢复",
      scope: ["src/emergency.ts"],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
    projectRoot: "D:/projects/demo",
  });
  assert.equal(wrongPath.allow, false);
});

test("Open edition runtime fcop directory write is not blocked by install boundary", () => {
  const gate = evaluateRoleToolCall({
    agentId: "OPS-01",
    toolName: "edit",
    args: { path: "D:/CodeFlowMu-open/fcop/reports/REPORT-test.md" },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("Open edition runtime workspace directory write is not blocked by install boundary", () => {
  const gate = evaluateRoleToolCall({
    agentId: "DEV-01",
    toolName: "edit",
    args: { path: "D:/CodeFlowMu-open/workspace/newproject/fcop/reports/REPORT-test.md" },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("Open edition active project write is not blocked by install boundary", () => {
  const gate = evaluateRoleToolCall({
    agentId: "DEV-01",
    toolName: "edit",
    args: { path: "D:/CodeFlowMu-open/workspace/newproject/src/app.ts" },
    projectRoot: "D:/CodeFlowMu-open/workspace/newproject",
    protectedRoots: ["D:/CodeFlowMu-open"],
  });
  assert.equal(gate.allow, true);
});

test("Open edition active-project boundary blocks a worker write to the mother repo", () => {
  const gate = evaluateRoleToolCall({
    agentId: "DEV-01",
    toolName: "edit",
    args: { path: "D:/codeflowmu/packages/codeflowmu-runtime/src/Runtime.ts" },
    projectRoot: "D:/CodeFlowMu-open/workspace/flowday-sign",
    enforceProjectWriteBoundary: true,
  });
  assert.equal(gate.allow, false);
  assert.match(gate.reason ?? "", /active project root/i);
});

test("Open edition active-project boundary allows a worker write inside active root", () => {
  const gate = evaluateRoleToolCall({
    agentId: "DEV-01",
    toolName: "edit",
    args: { path: "D:/projects/flowday-sign/src/app.ts" },
    projectRoot: "D:/projects/flowday-sign",
    enforceProjectWriteBoundary: true,
  });
  assert.equal(gate.allow, true);
});

test("Open edition shell boundary blocks an absolute root-outside write", () => {
  const gate = evaluateRoleToolCall({
    agentId: "DEV-01",
    toolName: "shell",
    args: {
      command:
        'Set-Content "D:\\codeflowmu\\packages\\codeflowmu-runtime\\src\\Runtime.ts" bad',
    },
    projectRoot: "D:/CodeFlowMu-open/workspace/flowday-sign",
    enforceProjectWriteBoundary: true,
  });
  assert.equal(gate.allow, false);
  assert.match(gate.reason ?? "", /shell writes cannot escape/i);
});

test("A to B project switch immediately revokes writes to project A", () => {
  const target = "D:/projects/project-a/src/app.ts";
  const beforeSwitch = evaluateRoleToolCall({
    agentId: "DEV-01",
    toolName: "edit",
    args: { path: target },
    projectRoot: "D:/projects/project-a",
    enforceProjectWriteBoundary: true,
  });
  const afterSwitch = evaluateRoleToolCall({
    agentId: "DEV-01",
    toolName: "edit",
    args: { path: target },
    projectRoot: "D:/projects/project-b",
    enforceProjectWriteBoundary: true,
  });
  assert.equal(beforeSwitch.allow, true);
  assert.equal(afterSwitch.allow, false);
});

test("OPS diagnostic shell is allowed", () => {
  const gate = evaluateRoleToolCall({
    agentId: "OPS-01",
    toolName: "shell",
    args: { command: "git diff --stat" },
    projectRoot: "D:/codeflowmu",
  });
  assert.equal(gate.allow, true);
});

test("recordRoleToolBlocked writes runtime event jsonl", async () => {
  const root = await mkdtemp(join(tmpdir(), "cfmu-role-gate-"));
  await recordRoleToolBlocked({
    projectRoot: root,
    agentId: "PM-01",
    toolName: "edit",
    reason: "Current role must dispatch implementation work through FCoP task files",
    channel: "cursor_sdk",
    sessionId: "sess-test",
    runId: "run-test",
  });
  const d = new Date();
  const key = d.toISOString().slice(0, 10).replace(/-/g, "");
  const logPath = join(root, "fcop", "logs", "runtime", `runtime-events-${key}.jsonl`);
  const raw = await readFile(logPath, "utf-8");
  const line = raw.trim().split("\n").pop() ?? "";
  const evt = JSON.parse(line) as {
    event_type: string;
    suggested_action?: string;
    reason?: string;
  };
  assert.equal(evt.event_type, "role_tool_blocked");
  assert.equal(evt.suggested_action, "write_task_to_responsible_role");
  assert.match(raw, /Current role must dispatch implementation work/);
});
