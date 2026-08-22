# 码流 CodeFlowMu Open — 历史开源版

> **已冻结 / 历史版本** —— 本仓库于 **2026-08-22** 正式进入冻结状态。

`CodeFlowMu-open` 是 CodeFlowMu 的历史开源版本。仓库继续保留，用于工程历史、研究引用、可复现性，以及仍依赖最后开源版本的用户。

## 当前状态

- 最后开源版本：**V1.2.29-open**
- 不再进行新功能开发
- 不再从当前私有 CodeFlowMu 开发仓库同步代码
- 不再计划从本仓库发布新的 Open Edition
- 不再接受面向新功能的 Pull Request
- 本仓库**不是**当前 CodeFlowMu 客户产品的发布来源

CodeFlowMu 项目本身没有停止。当前 CodeFlowMu 已转为独立的**闭源产品线**继续开发，源码仓库不再公开。

## 当前 CodeFlowMu 产品

当前产品的开发与发布已经与本历史开源仓库完全分离：

```text
CodeFlowMu-open
→ 历史开源实现
→ V1.2.29-open 冻结

codeflowmu
→ 当前私有开发仓库
→ 不对客户公开源码

CodeflowMu-Distribution
→ 当前产品发布仓库
→ 安装包、安装说明、升级说明和正式 Release
```

当前产品仍在产品化与安装链验证阶段，因此 `CodeflowMu-Distribution` **暂时保持私有**。产品完成并通过正式 Release Gate 后，再决定该分发仓库是否对外公开。

**CodeFlowMu Distribution（当前开发阶段为私有）**  
https://github.com/joinwell52-AI/CodeflowMu-Distribution

> 目前未获仓库访问权限的 GitHub 用户可能看到 404，这是因为产品尚未完成、分发仓库暂未公开，不代表 CodeFlowMu 项目停止或仓库不存在。

未来如果分发仓库公开，用户将从该仓库 README、安装文档和 GitHub Releases 获取正式安装方式；CodeFlowMu 源码仍不通过该仓库发布。

请不要把本仓库的历史源码安装方式、历史版本号或历史 Release 当作当前 CodeFlowMu 产品的安装方式。

## 历史定位

CodeFlowMu Open 曾提供本地优先的多 Agent 开发团队能力，包括 PM / DEV / OPS / QA、独立 EVAL 观察、FCoP 任务/报告/证据工作流、PC Panel、Mobile PWA、Cursor SDK，以及受控的 Windows / Browser Use。

该版本形成于 TMPA V1.0 正式定稿之前，是后续 CodeFlowMu 与 TMPA 发展的历史工程来源之一。它不代表当前 CodeFlowMu 实现，也不声明为当前 TMPA 符合性参考实现。

## 公开参考

- TMPA / Digital Employee Works：https://joinwell52-ai.github.io/joinwell52/zh/
- TMPA 仓库：https://github.com/joinwell52-AI/joinwell52
- FCoP：https://github.com/joinwell52-AI/FCoP
- 历史 CodeFlowMu Open 站点：https://joinwell52-ai.github.io/CodeFlowMu-open/

## 历史文档与源码

现有源码树、安装说明、截图、操作手册、发布记录和 Git 历史继续保留，供历史查阅与复现。

可继续查看：

- [冻结说明](ARCHIVED.md)
- [贡献状态](CONTRIBUTING.md)
- [历史安装说明](INSTALL.md)
- [历史发布记录](RELEASES.md)
- [English README](README.md)

## 许可证

冻结仓库不会追溯改变已经公开发布代码的许可证。历史 CodeFlowMu Open 代码仍适用其发布时采用的许可证条款。

未来私有 CodeFlowMu 产品代码不会再通过本仓库公开或同步。

---

**指令成流，智能随行。**
