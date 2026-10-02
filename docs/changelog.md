# 更新日志

本插件的版本历史。版本号以 git tag 与 `package.json` 为准；早于 `v0.2.1` 的版本没有打 tag，按其功能提交归类。

---

## 未发布 — 决策语义与证据补齐（版本号待定）

**两处语义变更：放行由程序按规则算，红条不再受无人值守开关影响。**

- **策略层 `decidePolicy` 取代旧的容忍度映射**：裁判只给风险、处理意见与**用户授权强度**（`none` / `weak` / `strong`），最终动作由固定分支表算出，命中的分支名进审计（`policy`）。行为变化：裁判判 `allow` 不再自动越过 `riskTolerance`——超档放行需要用户明确要求过这条动作；**风险 high 且授权不是 strong 时一律交人工**，容忍度管不了它
- **红条 `hardAsk`**：发布（npm / pnpm / yarn / bun publish、npm unpublish、twine upload、cargo publish、docker push、gh release create、git push）与凭据路径（`.ssh` / `.aws` / `.codex/auth.json` / `id_rsa` / `id_ed25519`）标为红条。`ai-auto` 下不走 `mode3OnAsk`，改由 `ai.hardAskOnUnattended` 决定（默认**拒绝**）；`.dsh/*` 保持普通 `ask`。`ai.hardAskOnUnattended` 不接受 `allow`
- **执行事实进判定与审计**：`workdir`（本条命令的实际目录）、`sandbox_permissions` + `justification`（本次请求的提权目标与理由）此前被 `argsPreview` 丢掉，现在随请求进入判定与审计；提权理由是 agent 自述，属不可信证据
- **按需补证（`ai.evidenceFetch`，默认 `read-file`）**：裁判可请求读取工作区内至多 `evidenceMaxFiles`（默认 2）个文件，插件按白名单抓取（realpath 复核、拒凭据与二进制、超长截断）并**再审一次**；拒绝原因进审计（`evidenceRefused`）与第二轮提示。`off` 恢复单轮判定
- **审计可解释性**：记录新增 `policy` / `userAuthorization` / `aiEvidence` / `aiUnknowns` / `cwd` / `workdir` / `escalation` / `evidenceFetched` / `evidenceRefused` / `evidenceRounds` / `hardAsk`
- **一次审批的总预算 `ai.totalBudgetMs`（默认 30s）**：覆盖全部候选与补证轮次，单候选仍受 `timeoutMs` 限制但会被剩余预算压低；耗尽即按 `failOpen` 落地并在审计标 `budgetExhausted`
- **拒绝熔断 `denialBreaker`**：连续 `consecutive` 次自动拒绝（默认 3）→ 本会话冷却 `cooldownMs`（默认 10 分钟），冷却期内需要 AI 判定的请求直接拒绝、不再花模型调用；同一动作被拒 `duplicate` 次（默认 2）→ 直接拒绝。任何非拒绝结果重置连续计数，熔断自身拒绝不延长冷却
- **`/approval-allow-once`**：列出本会话最近被拒动作并授权其中一条放行一次（`kind: manual-override`，不花模型调用）；授权只对该动作生效一次，且仍先过规则层——规则 `deny` 不可被覆盖，授权同时清除该会话冷却
- **拒绝反馈分两种导向**：`feedbackKind: restructure`（命令超预算，或裁判拒绝一条同时下载/执行/销毁的复合命令）时，更正消息改为要求「拆成可验证的步骤、脚本落文件、删除范围写到具体路径后重新提交」；规则 `deny` / 裁判 `deny` / 评审故障 / 熔断重复拒绝保持原有的「不要绕过」导向。判定不变，原样重发仍被拒
- 不变：规则优先级（deny > ask > allow）、证据门槛、`denyFeedback`、`transcript`、审计日志格式与轮转、候选链语义

验证：`node --test` 全绿。

---

## v0.4.5 — 2026-10-02

**安全更新：关闭路径层、规则层与 git 配置层的确定性放行路径。**

本版把"看起来只读、实际不是"的命令从自动放行里摘出来，全部是可复现的确定性缺陷（判定提示词也改为按 role 分离的两条消息）。配置字段与默认值向后兼容；只有那些**此前被误判为只读而自动放行**的写法，现在会交给 AI 或人类。

- **路径参数完整化**：`--` 终止符之后的每一项、选项的内联值（`-Path:..\secret`、`--file=/etc/passwd`）、pwsh 里用引号写出的词（含裸 `-` 与 `-/../../x`）都送 `realpath` 复核；只有 `-n` / `--output` / `-Path` 这类选项**名**会被跳过，`-ReadCount:0` 一类具名计数开关的值不算路径。引号位置参与判定：`-Path:'link'` 检查 `link`，整词被引号包裹的 `'--file=link'` 检查整串
- **规则扫还原面**：deny / ask 规则除原文外还扫重建 argv（`rm -r"f" /tmp/x` 即 `rm -rf /tmp/x`）、紧贴引号折叠（`~/.ss''h/i''d_rsa` 即 `~/.ssh/id_rsa`）、引号转空格、标点转空格与空白规范化（`npm  publish`、`npm<TAB>publish`），三种改写**三轮复合**；`allow` 仍只用原始文本与重建 argv，参数含空白的段不生成重建面（`"git status"` 不是 `git status`）
- **git 自动放行加 `configGuard`**：仓库 `.git/config` 与 `extensions.worktreeConfig` 的 `.git/config.worktree` 命中 `external` / `command` / `textconv`（含段头与键同行写法）、`gpg`、`include` / `include.path`，或 `fsmonitor` 取值非布尔（值按引号语法解析，`"true; exec evil"` 是命令行），即不再自动放行；**配置读不出来也不放行**（只有"文件不存在"算干净，权限与 I/O 失败视为无法核验）。`--ext-diff` / `--textconv` / `--show-signature` 进 `forbidOptions`
- **默认 deny / ask 扩充**：`sudo` / `doas` 包裹的 shutdown / reboot / halt / poweroff / dd；裸设备写入（`of=/dev/sd*`、`nvme`、`mapper`、`md`、`dm-`、`loop` 等 → deny，其余 `of=/dev/*` → ask）；fork bomb；凭据路径补全绝对 / 相对 / 正反斜杠 / 点目录矩阵（`.ssh\config`、`.dsh/profiles/…`、`id_rsa` 等），同时不再误伤 `docs/.aws-guide.md` 这类同名前缀文件
- **判定提示按 role 分离**：固定政策走 `system` 消息，命令 / reason / 会话骨架走 `user` 消息，请求文本不再与指令同级
- **文档与包结构**：客户端源码移入 `src/client/`（`package.json` 的 `files` 相应收紧，不再发布根级 `client-*.js` 与构建脚本）；README 改为特性导向，细节拆进 `docs/`，新增配置 / 决策链 / 安全 / 客户端卡片 / 开发 / 本地环境 / 第一性原理等文档与 README 横幅
- 不变：配置字段与默认值、`/approval-mode` 语义、`denyFeedback`、transcript、审计记录格式

验证：`node --test` 282 用例全绿（v0.4.4 为 256）；另以 120 组凭据路径矩阵与 28 项修复/对照矩阵复核。

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
