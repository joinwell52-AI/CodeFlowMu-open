# Mobile PWA Action Matrix

> 生成日期：2026-06-18  
> Gateway allowlist：`GATEWAY_ALLOWLIST_VERSION = 2026-06-18-v4`（`codeflowmu-gateway/server.py`）  
> 错误格式：前端 `api()` 统一为 `METHOD path: status`（403 另附 `gateway_allowlist_version` 若 bootstrap 提供）

## 图例

| 状态 | 含义 |
|------|------|
| **OK** | 路由在 Gateway allowlist，Shell 有 handler，前端已接线 |
| **DISABLED** | 按钮可见但 `disabled` / `enabled:false`，灰色次按钮样式 |
| **LOCAL** | 仅本地存储，无服务端 API |
| **N/A** | 纯 UI 导航，无 HTTP |

## Gateway Allowlist（v4）与 Shell 对照

| Method | API Path（模式） | Gateway v4 | Shell (`mobileRoutes.ts`) |
|--------|------------------|------------|---------------------------|
| GET | `/api/v2/mobile/bootstrap` | ✓ | ✓ |
| GET | `/api/v2/mobile/tasks` | ✓ | ✓ |
| POST | `/api/v2/mobile/tasks` | ✓ | ✓ |
| GET | `/api/v2/mobile/tasks/:filename` | ✓ | ✓ |
| POST | `/api/v2/mobile/tasks/:filename/actions` | ✓ | ✓ |
| GET | `/api/v2/mobile/reports` | ✓ | ✓ |
| GET | `/api/v2/mobile/reports/:filename` | ✓ | ✓ |
| GET | `/api/v2/mobile/issues` | ✓ | ✓ |
| GET | `/api/v2/mobile/approvals` | ✓ | ✓ |
| GET | `/api/v2/mobile/approvals/:filename` | ✓ | ✓ |
| POST | `/api/v2/mobile/approvals/:filename/approve` | ✓ | ✓ |
| POST | `/api/v2/mobile/approvals/:filename/reject` | ✓ | ✓ |
| POST | `/api/v2/mobile/approvals/:filename/confirm` | ✓ | ✓ |
| POST | `/api/v2/mobile/approvals/:filename/execute` | ✓ | ✓ |
| POST | `/api/v2/mobile/attachments/upload` | ✓ | ✓ |
| GET | `/api/v2/mobile/files/attachment?path=` | ✓ | ✓ |
| GET/POST | `/api/v2/mobile/chat/messages` / `chat/send` | ✓ | ✓ |
| GET | `/api/v2/mobile/activity` | ✓ | ✓ |
| GET | `/api/v2/mobile/tasks/:filename/activity` | ✓ | ✓ |
| POST | `/api/v2/mobile/bind-confirm` | ✓ | ✓ |
| GET | `/api/v2/mobile/alerts` | ✓ | ✓ |
| GET | `/api/v2/mobile/events` | ✓ | ✓ |

---

## 1. 任务详情页（`#taskDetailPage`）

动态动作栏 `#fpTaskActionBar` 由 Shell `buildAvailableTaskActions()` 驱动；点击走 `runTaskAction()`。

| 按钮文案 | 前端函数 | Method | API Path | Gateway | Shell 动作 | Runtime / Ledger | 状态 |
|----------|----------|--------|----------|---------|------------|------------------|------|
| 审批通过 | `runTaskAction('approve')` | POST | `/api/v2/mobile/tasks/{fn}/actions` body `{action:'approve'}` | ✓ v4 | `executeLifecycleRuntimeAction('approve_review')` | FCoP lifecycle approve | **OK**（bucket=review 时显示） |
| 打回 | `runTaskAction('reject')` | POST | 同上 `action:'reject'` + `{reason}` | ✓ v4 | `executeLifecycleRuntimeAction('reject_review')` | FCoP lifecycle reject | **OK** |
| 归档 | `runTaskAction('archive')` | POST | 同上 `action:'archive'` | ✓ v4 | `executeLifecycleRuntimeAction('archive_task')` | archive_task | **OK**（bucket=done 时显示） |
| 催办 | `runTaskAction('nudge')` | POST | 同上 `action:'nudge'` | ✓ v4 | proxy `POST /api/v2/pm/governance/wake-downstream` | PM 治理唤醒 | **DISABLED**（`panelPort` 未就绪时 `enabled:false`） |
| 一键解除卡死 | `runTaskAction('unstick')` | POST | 同上 `action:'unstick'` | ✓ v4 | proxy `POST /api/v2/tasks/{taskId}/unstick` | 面板 unstick | **DISABLED**（同上） |
| 返回 | `runTaskAction('back')` / `#taskDetailBackBtn` | — | — | — | `closeTaskDetail()` | — | **N/A** |

关联卡片 / 流程节点：`.flow-node`、`.related-card` → `openDetail(kind, filename)` → GET 对应详情 API。**OK**

---

## 2. 报告详情页（同 `#taskDetailPage`）

| 按钮/区域 | 前端函数 | Method | API Path | Gateway | Shell | 状态 |
|-----------|----------|--------|----------|---------|-------|------|
| 打开详情 | `openDetail('report', fn)` | GET | `/api/v2/mobile/reports/{fn}` | ✓ | 读 ledger + body | **OK** |
| 关联任务卡片 | `renderRelatedList` → click | GET | `/api/v2/mobile/tasks/{fn}` | ✓ | 任务详情 | **OK** |
| 返回 | `#taskDetailBackBtn` | — | — | — | `closeTaskDetail` | **N/A** |

报告详情无独立审批/归档动作栏（仅查看 + 跳转关联任务）。

---

## 3. 审批详情页（同 `#taskDetailPage`，`#fpApprovalActions`）

| 按钮文案 | 前端函数 | Method | API Path | Gateway | Shell | Runtime | 状态 |
|----------|----------|--------|----------|---------|-------|---------|------|
| 批准并执行该操作 | `approveCurrentApproval()` | POST | `/api/v2/mobile/approvals/{id}/approve`，随后 `/execute` | ✓ | `OperationApprovalService.approve` + 一次性 token + Panel 受控执行器 | **OK**；必须填写批准理由，执行状态独立显示 |
| 拒绝该操作 | `rejectCurrentApproval()` | POST | `/api/v2/mobile/approvals/{id}/reject` body `{reason}` | ✓ | `OperationApprovalService.reject` | **OK**；拒绝不打回任务、不改 REVIEW/REPORT |
| 关联报告/任务 | 卡片 click | GET | reports/tasks 详情 | ✓ | 同上 | **OK** |

> 与任务详情动作栏区别：审批页只处理 `.codeflowmu/operation-approvals` 中的执行前操作授权，走 **专用** `/approvals/.../approve|reject|execute`；任务详情 review 桶走 **`/tasks/.../actions`**，属于任务生命周期。两者不共享批准凭证。

---

## 4. 审批列表页（`#viewApprovals`）

| 按钮 | 前端 | Method | API | 状态 |
|------|------|--------|-----|------|
| 刷新 | `loadApprovals` | GET | `/api/v2/mobile/approvals` | **OK** |
| 列表项 | `openDetail('approval', fn)` | GET | `/api/v2/mobile/approvals/{fn}` | **OK** |

---

## 5. 任务列表 / 发布（`#viewTasks`）

| 按钮文案 | 前端函数 | Method | API Path | Gateway | Shell / 动作 | 状态 |
|----------|----------|--------|----------|---------|--------------|------|
| 发送任务 | `sendTaskFromTasksPage()` | POST（可先 upload） | `POST /attachments/upload` 然后 `POST /tasks` | ✓ | 创建任务 + 关联 `relation_mode` / `references` / `current_task_id` | **OK** |
| 添加图片 | `#taskAttachBtn` → `#taskAttachFile` | POST | `/attachments/upload`（发送时批量） | ✓ | `saveMobileAttachment` | **OK** |
| 导入 MD | `#taskMdImportBtn` | — | — | — | 本地读文件填入正文 | **LOCAL** |
| 关联模式 | `#taskSendRelationMode` | — | — | — | 控制 POST body；无开放任务时 continue/child **DISABLED** | **OK** |
| 刷新列表 | `loadTasks` | GET | `/api/v2/mobile/tasks` | ✓ | ledger 列表 | **OK** |
| 列表项 | `openDetail('task')` | GET | `/api/v2/mobile/tasks/{fn}` | ✓ | 详情 + actions | **OK** |
| 未绑定去绑定 | `#tasksUnboundBindBtn` | — | 跳转绑定页 | — | — | **N/A** |

---

## 6. 首页快捷发布（`#viewHome`）

| 按钮 | 前端 | Method | API | 状态 |
|------|------|--------|-----|------|
| 发送 | `sendQuickTaskFromHome()` | POST | `/api/v2/mobile/tasks`（`relation_mode:new`） | **OK** |
| 查看全部任务 | 切 tab tasks | — | — | **N/A** |
| 顶栏刷新 | `refreshAll()` | 多 GET | bootstrap/tasks/reports/… | **OK** |

---

## 7. 聊天页（`#viewChat`）

| 按钮 | 前端函数 | Method | API Path | Gateway | Shell | 状态 |
|------|----------|--------|----------|---------|-------|------|
| 发送 | `sendChatMessage()` | POST | 先 `attachments/upload`，再 `chat/send` | ✓ | `chatStore` + `ctx.sendChat` | **OK** |
| 添加图片 | `#chatAttachBtn` | POST | upload（发送时） | ✓ | 同上 | **OK**（未绑定仅纯文本 **LOCAL**） |
| 轮询消息 | `loadChatMessages` | GET | `/api/v2/mobile/chat/messages` | ✓ | listMobileChatMessages | **OK** |
| 附件缩略图 | `hydrateChatAttachmentThumbnails` | GET | `/api/v2/mobile/files/attachment?path=` | ✓ | 读附件文件 | **OK** |

---

## 8. 报告 / 动态 / 我的

| 区域 | 按钮 | Method | API | 状态 |
|------|------|--------|-----|------|
| 报告 | 刷新 / 列表项 | GET | `/reports`, `/reports/{fn}` | **OK** |
| 动态 | 刷新 | GET | `/api/v2/mobile/activity?limit=100` | **OK** |
| 我的 | 清除缓存 | — | `caches` / SW | **LOCAL** |
| 我的 | 重新绑定 | — | 清 storage + 绑定页 | **N/A** |
| 我的 | 语言切换 | — | i18n localStorage | **LOCAL** |

---

## 9. 设备绑定

| 按钮 | 前端 | Method | API | Gateway | 状态 |
|------|------|--------|-----|---------|------|
| 扫码绑定 | QR 流程 → `runBind` | POST | `/api/v2/mobile/bind-confirm`（raw `fetch`） | ✓ | **OK** |
| 粘贴链接 | `runBind` | POST | 同上 | ✓ | **OK** |
| 手动 bind_id/token | `#bindManualBtn` | POST | 同上 | ✓ | **OK** |
| Banner 去绑定 | `openBindPage` | — | — | **N/A** |

---

## 10. 前端错误提示规范（`mobile.js` `api()`）

| HTTP | 展示格式 |
|------|----------|
| 401 | `METHOD path: 401` + 登录/绑定引导 |
| 403 | `METHOD path: 403 Gateway 拒绝（…allowlist=…）` |
| 404 | `METHOD path: 404` |
| 5xx | `METHOD path: status` + 响应片段 |

不再使用写死的「attachments 接口」类文案。

---

## 11. UI：禁用按钮样式

| 组件 | 规则 |
|------|------|
| `#fpTaskActionBar` | `enabled:false` → `btn-secondary-block`；可用主操作 → `btn-block-primary` |
| `#fpApprovalApprove` | `can_approve===false` 或 `material_missing` → disabled + `btn-secondary-block` |
| `#fpApprovalReject` | 始终 `btn-secondary-block`（非蓝色主按钮） |
| CSS | `.btn-block-primary:disabled` 灰底（`mobile.css`） |

---

## 12. QA 点测清单（待真机填写）

| # | 场景 | 预期 API | 结果 | 备注 |
|---|------|----------|------|------|
| 1 | 审批详情 → 批准并执行 | `POST …/approvals/{id}/approve` + `/execute` | ☐ | |
| 2 | 审批详情 → 审批拒绝（填原因） | `POST …/approvals/{fn}/reject` | ☐ | |
| 3 | 任务详情 review → 动作栏「审批通过」 | `POST …/tasks/{fn}/actions` | ☐ | |
| 4 | 任务/审批 → 查看关联报告 | `GET …/reports/{fn}` | ☐ | |
| 5 | 聊天 → 上传图片并发送 | upload + `chat/send` | ☐ | |
| 6 | 任务页 → 关联子任务/继续任务 | `POST …/tasks` + relation 字段 | ☐ | |
| 7 | Gateway 403 时 Toast | 含 `POST /api/...` 与状态码 | ☐ | 需远端部署 v4 allowlist |
| 8 | panel 未就绪时催办/解卡 | 按钮灰色不可点 | ☐ | |

---

## 13. 自动化测试（本地已跑）

| 套件 | 命令 | 结果 |
|------|------|------|
| Gateway allowlist | `pytest codeflowmu-gateway/tests/test_gateway.py` | `is_path_allowed` 含 `tasks/.../actions`；另有 1 条无关 `ui_version` 失败 |
| Shell mobile API | `node --test` `mobile-api.test.ts` + `mobile-gateway-config.test.ts` | 14 passed |

---

## 14. 部署备注

远程 Gateway 需运行 **allowlist v4** 后，`POST /api/v2/mobile/tasks/*/actions` 才不会 403：

```bash
python codeflowmu-gateway/scripts/deploy_gateway_allowlist.py  # 按项目脚本说明部署到 ai.chedian.cc
```

部署后重启 gateway 进程，并在 PWA bootstrap/403 Toast 中核对 allowlist 版本。
