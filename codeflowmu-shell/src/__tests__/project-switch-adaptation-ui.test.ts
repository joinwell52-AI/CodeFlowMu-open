import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const panel = readFileSync(
  join(process.cwd(), "..", "codeflowmu-desktop", "panel", "index.html"),
  "utf-8",
);
const backend = readFileSync(
  join(process.cwd(), "src", "web-panel.ts"),
  "utf-8",
);

test("project switch shows adaptation progress and waits for the target runtime root", () => {
  assert.match(panel, /项目已切换，正在同步适配/);
  assert.match(panel, /openProjectAdaptation/);
  assert.match(panel, /waitForProjectAdaptation/);
  assert.match(panel, /runtimeReloadScheduled/);
  assert.match(panel, /health\?project-adapt=/);
  assert.match(panel, /health\.projectRoot\s*\|\|\s*health\.root/);
  assert.match(panel, /同步适配完成，正在刷新项目界面/);
  assert.match(panel, /同步适配等待超时/);
});

test("both project switch entrances share handleProjSwitch", () => {
  assert.match(panel, /id="proj-switcher" onchange="handleProjSwitch\(this\.value\)"/);
  assert.match(panel, /onclick="handleProjSwitch\('\$\{esc\(p\.id\)\}'\)"/);
});

test("mother app badge stays codeflowmu while development project switches separately", () => {
  assert.match(panel, /id="hdr-proj-badge"[^>]*>codeflowmu<\/span>/);
  assert.match(panel, /if \(badge\) badge\.textContent = 'codeflowmu'/);
  assert.doesNotMatch(panel, /badge\.textContent = active\?\.name/);
  assert.doesNotMatch(panel, /badge\.textContent = d\.project\?\.name/);
});

test("new independent project is distinct from adding an existing project or PM workspace", () => {
  assert.match(panel, /新建独立项目/);
  assert.match(panel, /添加已有项目/);
  assert.match(panel, /创建、初始化并切换/);
  assert.match(panel, /新项目完整路径（固定位于 projects\/）/);
  assert.match(panel, /readonly/);
  assert.match(panel, /任务内的 new_workspace 也不是此功能/);
  assert.match(panel, /fetch\('\/api\/v2\/projects\/create'/);
  assert.match(backend, /POST \/api\/v2\/projects\/create/);
  assert.match(
    backend,
    /projectsCollectionRoot\(resolveBootstrapProjectRoot\(\)\)/,
  );
  assert.match(backend, /const workspaceMode: WorkspaceMode = "multi"/);
  assert.match(backend, /arbitrary existing paths[\s\S]*POST \/api\/v2\/projects/);
  assert.match(backend, /PROJECT_CREATE_ROOT_NOT_EMPTY/);
  assert.match(backend, /switch_project_then_publish_task/);
});

test("PM heartbeat never overlaps an active PM session or patrols review-only roots", () => {
  assert.match(backend, /activeSessions\s*=\s*await runtime\.sessionManager\.listActive\(\)/);
  assert.match(backend, /session\.protocol\.agent_id/);
  assert.match(backend, /pmActionableRootBuckets\s*=\s*new Set\(\["inbox", "active", "tasks"\]\)/);
  assert.match(backend, /selectPmHeartbeatFocus\(activeRoots\)/);
  assert.match(backend, /最新未收口叶子任务/);
  assert.match(backend, /task_id:\s*focusTaskId/);
  assert.match(backend, /thread_key:\s*focusThreadKey/);
});

test("project switch repairs public Open skill projections", () => {
  assert.match(
    backend,
    /await deployOpenEditionProjectProjection\(target\.root\)/,
  );
  assert.match(backend, /skills", "windows-use/);
  assert.match(backend, /skills", "browser-use/);
});
