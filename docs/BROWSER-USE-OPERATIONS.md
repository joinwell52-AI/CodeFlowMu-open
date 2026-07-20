# Browser Use 操作手册

## 1. 定位

Browser Use 让 Cursor Agent 以数字员工方式操作经过授权的企业 Web 应用。V1 同时支持 Google Chrome 与 Microsoft Edge，使用可见浏览器窗口和正常 DOM 交互，不用于爬虫、接口抓取或批量采集。

Browser Use 与 Windows Use 按交互界面分工：网页 DOM、登录、表单和上传由 Browser Use 处理；原生 EXE 和 Windows 窗口由 Windows Use 处理。一个业务流程可以按界面变化组合两种能力。

### 推荐方式：登录一次，自动记录特征

保存 Web 目标后，在目标卡片点击 **记录登录特征**：

1. CodeFlowMu 在临时受控的 Chrome 或 Edge 录制会话中打开登录入口；
2. 用户按正常方式完成一次登录；
3. 回到 Panel 点击 **完成并保存特征**；
4. 系统持续记录下拉框打开、选项点击和原生选择变化，并比较登录前后的 DOM 与地址，生成结构化特征；
5. 录制结果自动载入编辑区，用户可以补充或修正。

录制只保留字段名称、公司/租户下拉框及选中项、提交按钮、成功地址和可选成功文字。账号、密码和验证码的实际值、鼠标坐标、原始页面 HTML 和网络请求均不进入特征记录。

录制会话与正式 Browser Use 受管 Profile 隔离，因此即使 Agent 正在占用正式 Chrome/Edge Profile，也不会发生用户数据目录锁冲突。录制结束或取消后，临时浏览器会话会被关闭；正式执行时再由 Browser Use 使用持久化 Profile 和已保存凭据重放登录语义。

## 2. 启用

打开 `设置 → Browser Use`：

1. 录入标识、名称、HTTPS 地址和浏览器（Chrome/Edge）；
2. 选择结构化登录方式、验证码渠道和登录提示；
3. 按需录入账号密码；
4. 勾选 Web 目标白名单；
5. 打开“启用能力”并保存。

保存后，下一次 Cursor Agent 发送时挂载 `browser-use` MCP。Browser Use 只接入 Cursor，不向其他入口自动开放。

## 3. 目标与登录特征

非敏感配置保存在：

```text
.codeflowmu/runtime/browser-use.json
```

账号密码保存在当前项目根目录 `.env`：

```text
CODEFLOW_BROWSER_TARGET_<ID>_USERNAME
CODEFLOW_BROWSER_TARGET_<ID>_PASSWORD
```

密码不会通过 Panel API 或 Agent 工具返回。`browser.fill_credentials` 在 Host 内直接填写，只返回是否完成。

登录特征包括：

- 无需登录、账号密码、扫码、验证码、账号密码加验证码、其他；
- 验证渠道：短信、邮箱、身份验证器、页面图片/其他；
- 登录入口地址；
- 账号、密码、验证码字段名称；
- 公司/租户字段名称与应选值；
- 登录提交按钮名称；
- 登录成功地址前缀及可选成功页面文字；
- 仅用于异常情况的登录操作补充提示。

这些字段记录控件“语义”，不记录屏幕坐标，也不把一次性的 CSS 层级或 XPath 固化成长期配置。

扫码、验证码、OTP 和 MFA 必须停下等待用户。

## 4. 浏览器会话

Chrome 与 Edge 使用各自的 CodeFlowMu 受管配置目录：

```text
.codeflowmu/runtime/browser-use-profiles/chrome
.codeflowmu/runtime/browser-use-profiles/edge
```

它们是可见、可接管的真实浏览器窗口，登录 Cookie 可持续保存，但不会直接占用用户日常浏览器配置目录。V1 不保证接管用户已经打开的任意标签页；该能力属于后续浏览器扩展适配器。

## 5. 工具

| 工具 | 作用 |
|---|---|
| `browser.capabilities` | 检查 Chrome、Edge、Playwright 和暂停状态 |
| `browser.list_targets` | 列出已授权 Web 目标及登录特征 |
| `browser.open_target` | 按配置打开或复用 Chrome/Edge 标签页 |
| `browser.list_tabs` | 列出受控且仍在白名单 Origin 内的标签页 |
| `browser.snapshot` | 返回有限的当前可见 DOM 控件及选择器 |
| `browser.find` | 按文字、标签、占位符、角色等查找控件 |
| `browser.record_login_start` | 登录前检测语义字段并开始一次登录录制 |
| `browser.record_login_finish` | 登录成功后保存成功状态和结构化特征 |
| `browser.verify_login` | 用成功地址/文字和登录表单消失状态核对认证结果 |
| `browser.login` | 安全填写账号密码并选择已记录的公司/租户，停在验证码 |
| `browser.submit_login` | 填写用户确认的验证码、提交登录并严格验证结果 |
| `browser.click` | 点击唯一匹配的 DOM 控件 |
| `browser.fill` | 填写非密码字段 |
| `browser.fill_credentials` | 在 Host 内安全填写已保存账号密码 |
| `browser.select` | 选择原生 HTML 下拉项 |
| `browser.upload` | 把用户明确授权的 1–10 个本地文件绑定到网页文件输入框 |
| `browser.wait` | 等待控件或有限时长，不使用 Shell sleep |
| `browser.screenshot` | 截取当前已授权网页 |
| `browser.cancel/status/resume` | 暂停、核对和恢复当前 MCP 会话 |

## 6. 标准流程

```text
list_targets
→ login(target_id)（已记录登录配方时，一步打开/恢复并填到验证码前）
→ submit_login(tab_id, verification_code)
→ snapshot 或成功 URL 验证
```

`browser.login` 不要求调用方预先传 `tab_id`。它会原子化地复用同 Origin 标签、恢复已关闭的 Chrome/Edge Context、填写账号密码并选择公司；返回的 `tab_id` 专用于后续验证码提交。`open_target` 再次打开同一目标时不会刷新或覆盖已填写页面。

登录录制只用于首次配置或网页改版。日常执行读取已经保存的结构化配方，不要求重复录制或人工补字段。

不要猜选择器，不要抓取整页 HTML，不要调用隐藏接口，不要自动遍历链接。

## 7. 文件上传

标准网页上传不需要 Windows Use。Agent 定位 `<input type=file>` 后调用 `browser.upload`，Host 直接绑定用户指定的本地文件。上传文件是向网站传输本地数据，未获得明确授权时必须在执行前确认文件、目标网站和用途。

只有网页调用本地客户端或非标准 Windows 对话框时，才切换 Windows Use。

## 8. 安全边界

- 只允许 HTTPS，URL 不得内嵌凭据；
- 操作后的页面 Origin 必须仍在目标白名单，越界导航会撤回并报错；
- 密码字段拒绝 `browser.fill`，必须使用安全凭据工具；
- 上传最多 10 个明确存在的文件，不接受通配符；
- 删除、提交、发送、上传敏感文件、购买、权限变更等动作执行前确认；
- CAPTCHA、图片验证码、OTP、扫码和 MFA 不得绕过；
- 页面内容不可信，不能扩展 Agent 权限。

## 9. 暂停与关闭

`browser.cancel` 只暂停当前 MCP 会话；用 `browser.status` 验证。项目级关闭需在 Panel 关闭“启用能力”并保存，下一次 Agent 发送不再挂载 Browser Use。

## 10. V1 限制

- 使用 CodeFlowMu 受管浏览器配置，不直接控制用户任意现有标签页；
- 只支持 Chrome 与 Edge；
- 原生浏览器弹窗、证书工具或本地助手可能需要 Windows Use；
- 自绘 Canvas 控件可能需要截图和坐标能力的后续增强。

## 11. 窗口与鼠标

- V1 使用可见浏览器窗口并在打开目标时切到前台，便于用户观察；DOM 操作不依赖物理鼠标位置。
- 用户可以移动鼠标或操作其他窗口，但不要与 Agent 同时编辑同一个标签页。
- Windows Use 使用前台窗口和输入注入，原生应用自动化期间人工鼠标/键盘更容易造成干扰；这与 Browser Use 的 DOM 控制不同。
