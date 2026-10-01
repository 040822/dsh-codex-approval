# 更新日志

本插件的版本历史。版本号以 git tag 与 `package.json` 为准；早于 `v0.2.1` 的版本没有打 tag，按其功能提交归类。

---

## v0.4.4 — 2026-10-01

**修复：空回复现在会推进候选链，兜底模型终于能被用上。**

候选链此前只在**传输层失败**时推进。当流在没有任何 `text-delta` 的情况下结束（包括 `AbortSignal` 掐断而没有 `finish(error/aborted)` 分片），`attemptJudge` 返回 `{ok:true, text:""}`——于是一个不含可用判定的回复被当成**成功的判定尝试**：链停在空串上，配置好的 `ai.fallbacks` 永远轮不到，审计日志里堆满 `kind=ai-error` + `unparseable judge output` + 空 `rawOutput` 且**没有 `judgeAttempts`** 的记录（WX301 实测：66 条 unparseable、全部空回复、0 条带 `judgeAttempts`）。

- 候选只有在 `parseVerdict` 接受其回复时才算答对；空文本与"有文本但无判定对象"都会推进候选链（全链失败才落到 `failOpen`）
- 审计原因区分 `unparseable judge output (empty reply)` 与 `unparseable judge output (no verdict)`
- 新增候选诊断字段 `textChars` 与 `endedWithoutFinish`，随 `ai-error` 记录落盘
- 不变：`judgeModel` / `judgeFallbackFrom` / `judgeAttempts` / `judgeTried` 语义、单候选结果形状、`failOpen` / `mode3OnAsk` / `riskTolerance` / 规则 / 形状判定

---

## v0.4.3 — 2026-10-01

**双平面客户端兼容（DSH 0.2.0 `configForms`）+ 审批逃逸修复。**

- 客户端半边同时适配 DSH 0.1.5（schemastery 3.18.2）与 0.2.0（3.18.4）的可发现平面；测试套件对每个可发现的 schemastery 平面各跑一遍
- 声明 DSH `0.2.0-rc.2` 为兼容版本
- 关闭 2026-09-22 审计发现的确定性自动放行逃逸路径

## v0.4.2 — 2026-09-12

**判定候选链 + Web 模型选择卡片 + AI 失败诊断。**

Host：

- `ai.fallbacks`：有序判定候选链（每候选各自计时、按 provider+model 去重、取消感知中断）；全链失败时按主模型信息记 `judgeAttempts` / `judgeTried`，走兜底时记 `judgeModel` / `judgeFallbackFrom`
- settings 改走 `settings.register()` 返回的 owner scope（DSH 0.1.5），同时兼容 0.1.2 的服务级 API，live 更新恢复；注册失败被记录而非 try/catch 吞掉
- 拒绝反馈携带 `finishKind` / `failure` 安全诊断

Client：

- 设置卡片：主模型选择 + 兜底链编辑（增删、调序，上限 4）+ 按模型目录标注可用性 + 调用顺序摘要 + 未保存标记
- 原生卡片外观：样式逐条抄自内置 `PluginCard` / `fields`，控件取自 shell primitives 表
- 修复 `slot entry crashed in settings.plugin.item`：显式声明点号服务 `remote.session`，并在自己的 fiber 上解析 `modelCatalog()`
- 可复现的客户端 bundle 构建（`scripts/build-client.mjs`）

> **版本号说明**：这次开发期 `package.json` 曾被写成 `0.5.4`（提交 `cd2b8d6` 的标题也照此记录）。发布时以维护者决定的 tag 为准，下一个提交把清单改回 `0.4.2`——所以这个提交的标题里的 `0.5.4` 是开发期编号，不是漏发的版本。本页一律以 tag 与 `package.json` 为准。

## v0.4.1 — 2026-09-08

**修复：客户端 bundle 按 loader factory 形式构建。**

## v0.4.0 — 2026-09-02

**`transcript`：给 AI 审判提供紧凑会话上下文。**

- 新增 `transcript.js`：语义过滤（丢弃流式分片与插件注入的用户消息）、两级窗口（最近用户消息 + ≤3 条工具链 / 更早的用户意图线）、超长粘贴的头尾省略与省略计数、分层预算与硬上限
- `judge.js` 接受可选 Context 块；系统提示新增**意图优先规则**（用户明确要求的操作除非明显高风险，否则可判 allow）
- `sessionId` 透传到 LLM 调用（provider 侧前缀缓存所需）
- 默认规则新增 11 条 `Pwsh(...)` 只读 allow，与 `Bash(...)` 族并存
- 配置：`transcript: off|short`（默认 off）+ `transcriptMaxChars`（100–16000）

## v0.3.0 — 2026-09-02

**`denyFeedback`：拒绝归因反馈。**

- 插件自身产生的拒绝（规则 / AI / `ai-error` / 兜底 / `mode3`）进入每会话队列
- 新增 `agent/pre-step` 注入器：在下一次模型请求前追加一条 plugin 来源的更正消息（"这不是用户拒绝" + 来源 / 风险 / 理由 + 不得绕路）
- 中英文案模板，含来源标签与 `viaAsk`（`ai-auto` 的 mode3）归因
- 配置：`denyFeedback`（默认 true）+ `denyFeedbackMax`（默认 3）

## v0.2.2 — 2026-08-16

**双语 `/approval-mode` 文案 + `npm publish` 询问规则。**

- `i18n.js`：中英文案表、`pickLocale`、双语命令描述；`locale: auto|zh|en`
- 默认规则新增 `Bash(npm publish*)` → `ask`：每次发布升级请求都必须询问人类（`cd x && npm publish` 同样命中）

## v0.2.1 — 2026-08-16

内部发布提交，无面向用户的变化。

## v0.2.0 — 2026-08-15

**审批模式维度（`manual` / `ai` / `ai-auto`）+ `/approval-mode` 命令。**

- `modes.js`：模式词汇、数字别名（1/2/3）、生效模式解析、`ask → mode3OnAsk` 映射（纯函数）
- `manual` 完全旁路（不决策、不写日志）；`ai-auto` 绝不把 `ask` 交给人类——规则 ask、AI 判 ask 且超容忍度、`failOpen=ask`、`fallback=ask` 全部按 `mode3OnAsk`（默认 deny）结算
- `ai-auto` 使用禁用 `ask` 的判定提示词变体（模型必须给出 allow 或 deny）
- `/approval-mode` 命令：查看 / 切换 / 清除会话覆盖
- 会话覆盖经 settings namespace 持久化（服务不可用时降级为纯内存）
- 新增依赖 `@deepseek-ai/schemastery`（设置 schema）

## v0.1.0 — 2026-08-15

**首个版本：Codex 风格 AI 审批自动驾驶。**

- 规则层（approve-always / reject-always 风格 glob，`deny > ask > allow` 优先级）
- AI 审判层（风险 `low/medium/high` + 授权 `allow/ask/deny` + `riskTolerance` 映射）
- 人类兜底（GUI 弹窗），经 `approval/request` 应答者瀑布
- JSONL 决策审计日志（`~/.dsh/logs/approval.jsonl`）
