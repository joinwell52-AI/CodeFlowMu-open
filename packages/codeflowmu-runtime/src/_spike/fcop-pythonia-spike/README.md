# `_spike/fcop-pythonia-spike` — P4 sprint 隔离 spike

**对应任务**：[TASK-20260511-005-PM-to-DEV](../../../../../fcop/tasks/TASK-20260511-005-PM-to-DEV.md)
**回执参考**：[REPORT-20260511-005-DEV-to-PM](../../../../../fcop/tasks/REPORT-20260511-005-DEV-to-PM.md)（历史归档路径，若已迁移 v3 请到 ledger 检索）

## 背景

ADMIN 5/11 将 **D7 = 方案 P** 定为：CodeFlowMu runtime 通过 `pythonia` npm 包**隔离调用** Python 侧 fcop@1.1.0，不污染主 runtime 依赖树。PM 派给 DEV-001 的 P1 任务是 spike：**证明 import 可行、demo 可跑**，再决定是否进入 sprint 主链路。本目录为**一次性隔离实验**，不得被主包 import。

## 隔离约束

- **禁止** runtime workspace 根目录依赖 `@codeflowmu/_spike-fcop-pythonia`（主包不得 import）
- **禁止** 影响 runtime 112+ 用例：`npm test` 在 `packages/codeflowmu-runtime/` 根目录必须全绿
- **禁止** 在 `package.json` dependencies 加入 `pythonia`（仅 spike 子目录本地 install，不进主 `node_modules/`）
- **禁止** 向 fcop 上游提 issue / PR（除非 PM 明确授权；本 spike 不应造成 surprise）
- **禁止** 提前实现 P4 sprint（TASK-006+）功能；spike 只验证可行性

## 目录说明

| 文件 | 说明 |
|---|---|
| `package.json` | spike 独立包；在此目录执行 `pnpm install` / `npm install` |
| `tsconfig.json` | 仅编译 spike 脚本，不参与主 runtime 构建 |
| `hello-fcop.ts` | 场景 1：pythonia + fcop import 冒烟 |
| `demo-fcop-api.ts` | 场景 2：调用 fcop 公开 API demo |
| `.gitignore` | 忽略 `node_modules/` + `D:/temp/codeflowmu-spike-project/` 等 spike 产物 |

## 运行

### 环境

- Python 3.10+，且 **fcop@1.1.0 importable**
- Node 16+（开发机 node v24.14.0 已验证）
- npm（若 TASK §3.1 要求 `pnpm`，可换 pnpm；REPORT 记录避免 surprise 即可）

### 安装（setup）

```powershell
cd packages/codeflowmu-runtime/src/_spike/fcop-pythonia-spike
npm install
```

### Windows：pythonia 默认 spawn 的 python 与 fcop 所需 Python 不一致时

若 PATH 中 `python` = 3.9.5（无法 import fcop），而 fcop 安装在 `py -3` 指向的 Python 3.12.9，则 pythonia 可能 spawn 错误解释器。**临时**用 env var 指向 3.12：

```powershell
$env:PYTHON_BIN = "C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe"
npm run hello
```

（pythonia 是否尊重该变量见 hello-fcop.ts 注释；若无效需改 spawn 配置。）

### 执行

```powershell
npm run hello   # 场景 1
npm run demo    # 场景 2
```

## 与主 runtime 的关系

P4 sprint（TASK-006 及以后）若采纳本方案，CodeFlowMu runtime 才会正式 `import { python } from 'pythonia'`。
PM 将根据 spike 回执决定：是否进入主链路、错误边界、以及 import 失败时的降级策略。
