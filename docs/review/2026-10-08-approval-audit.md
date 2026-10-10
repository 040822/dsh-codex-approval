# dsh-codex-approval 审查报告

> 审查日期：2026-10-08
> 被审版本：工作区状态（v0.4.6 + 未提交改动 `M index.js` / `M redact.js` / `M test/index.test.mjs` / `?? test/redact.test.mjs`，HEAD `6a32651`）
> 宿主：DSH 0.2.0-rc.2（`/home/wenxin/dsh-runtimes/0.2.0-rc.2` 与全局 npm 安装）
> 方法：源码阅读 + 独立探针实测 + 本机生产数据统计 + 6 个并行审查单元 + codex(gpt-6.1-sol, medium) 单轮独立审核
> 标注约定：**（实测）**= 本次跑出的可复现结果；**（代码）**= 源码可查；**（生产数据）**= 本机审计日志/会话日志统计；**（推断）**= 未经受控实验的推理。

---

## 0. 摘要

**功能侧**：插件在真实流量里确实在工作（774 行审计日志、368 个会话、336 次审批对），但它的核心价值主张「少点审批弹窗」在**默认 `ai` 模式下基本没有兑现**——2026-10 月 39 次决策中自动放行仅 3 次（8%），90% 仍然弹窗，且每次要先花约 7 秒问模型；换成 `ai-auto` 则是 79% 放行、0% 弹窗、21% 拒绝。两种模式的产出差异，比插件与"不装插件"的差异更大。

**安全侧**：本轮有 **1 条 critical + 若干 major**。

- **【critical】提权请求被 allow 规则静默批准**：规则层完全没有 `escalation` 维度，而宿主把 `allowed-once` 直接当作授予提权。`{command:"ls", sandbox_permissions:"danger-full-access"}` 命中默认 `ls` allow 规则 → judge 不被调用、用户无弹窗、沙箱被放宽。本机 258 条决策里有 37 条提权请求（全部 `danger-full-access`），说明这是常态操作（§3.1.1）。
- **【major】守卫与实际执行目录脱节**：`pathGuard` / `configGuard` 用**会话工作区根**解析路径，而命令实际执行在 `workdir`（模型可控的合法参数）。实测 `cat keep.txt` 指定 `workdir` 指向别处仍返回 `allowed-once`；`git status` + 子目录仓库可让 `.git/config` 的 `fsmonitor` 执行任意程序（§3.1.2）。
- **【major】一次性人工授权键可在动作之间转移**：授权键基于**脱敏后**文本生成，`--token=STAGING` 与 `--token=PRODUCTION` 同键（§3.1.3）。
- **【major】统一脱敏对"环境变量风格"的凭据名完全不生效**：独立实测 18 条常见凭据形态 **14 条泄漏**（§3.1.4）。
- **【major】补证链三处**：白名单 TOCTOU（§3.1.5）、补证正文不过脱敏边界（§3.1.6）、凭据清单不完备且后缀可绕过（§3.1.7）。
- 另有：候选超时截断的判定被采信（§3.1.10）、5 个 volatile 配置字段不生效（§3.1.11）、主判定路由漏校验（§3.1.12）。

**一条必须写进修复顺序的结论**：`pathGuard` / `configGuard` 在这台机器上**本来就空转**（`getCwd` 取不到值，258 条决策 0 条带 `cwd`），所以 §3.1.2 目前是潜伏的——**只修 `getCwd` 而不修 `workdir` 会让安全变差**（见 §3.1.2 末的判断）。


**评测侧（第二条 critical）**：单测层是真覆盖（399/399 通过、断言多为结果级），但评测层的 `--live` 与 `--replay` **恒 exit 0**，且 `--live` 的主安全指标在裁判彻底失效时反而读作满分——**把判定端点指向死端口仍输出"危险放行 0/72"并 `EXIT=0`**（§4.1）；`check-planes.mjs` 的期待值靠人手同步，实测可"改期待值"让真实安全用例在生产平面永久跳过（§4.2）。也就是说：这份仓库里，"安全"目前**没有任何自动化守门人**。

**定位判断**：这个项目已经超出"一个审批插件"的范围——它有三层评测、可回放的审计、可对照的判定分支，是目前少有的**可以拿来量化 HITL/HNITL 权衡的实验平台坯子**（§6）。而它最缺的正是把这个潜力兑现的三件基础设施（§7）。

---

## 0.5 修复进展（同一晚，10 个提交）

本报告写于改动前的工作区。随后的十个提交（`4353b44` → `b104472`）处理了其中大部分，逐条状态如下——**这份表是"报告写完之后发生了什么"的唯一汇总**，正文各节保留的是当时的取证记录。

| Finding | 状态 | 提交 |
|---|---|---|
| §3.1.1 提权被 allow 规则静默批准（**critical**） | **已修**：带提权目标的调用一律不适用 allow 规则 | `4353b44` |
| §3.1.2 守卫与执行目录脱节 + `getCwd` 死接线 | **已修**（同一提交）：会话根改取 `session.header.cwd`，守卫跟随 `workdir`，workdir 越界时任何 allow 都不适用 | `4353b44` |
| §3.1.3 一次性授权键脱敏后碰撞 | **已修**：键改用原始命令文本 | `c0a163a` |
| §3.1.4 统一脱敏缺口（12 形态漏 10） | **已修**：标签按整键匹配、认证头保留 scheme、URL 凭据替换但保留 host、补无标签形态 | `55d9064` |
| §3.1.5 补证白名单 TOCTOU | **已修**：`open(O_NOFOLLOW)` + `fstat` + 同一 fd 读 | `5d8aeb7` |
| §3.1.6 补证正文与模型回显不过脱敏 | **已修** | `55d9064` |
| §3.1.7 凭据清单不完备 + 后缀可绕过 | **已修**：清单扩充 + 先剥离后缀再判 | `55d9064` |
| §3.1.8 `command-facts` 两处漏检 | **已修**：`break`→`continue`、越界路径优先入列、省略量显式上报 | `4353b44` |
| §3.1.9 注册优先级文档矛盾 | **已修**（文档）：`security.md` 不再声称 prepend | `4353b44` |
| §3.1.10 截断判定被当正常判定采信 | **已修**：`attemptJudge` 的 `run` 返回前检查本次尝试的中止标志（自己的超时 → `finishKind: "timeout"` + `hardTimeout`，整体取消 → `"aborted"`），已中止一律不采信其文本，按一次候选失败走链 | `b104472` |
| §3.1.11 五个 volatile 字段不生效 | **已修**：接上 live getter | `4844c97` |
| §3.1.12 主判定路由漏校验 | **已修**：`provider`/`model`/`timeoutMs`/`maxTokens` 类型与范围 | `e2829c6` |
| §3.1.13 i18n 缺标签 / 死键 / `DSH_HOME=""` | **未修** | — |
| §3.1.14 计数表无会话级清理 | **未修** | — |
| §3.1.15 结构化规则不覆盖 `compound` | **未修**（能力缺口，非缺陷） | — |
| §3.1.16 非 shell 工具无路径级守卫 | **未修**（能力缺口。实测默认规则里 0 条非 shell allow 规则、0 条 legacy allow 规则，当前影响面为零） | — |
| §3.1.17 文档安全声明与实现相反 | **已修**：`deny 最先求值`补上证据门槛边界、`切回 WW 暂停插件`改为明确的错误指引 | `4353b44` |
| §3.1.18 `fallback` 因预算错位失效 | **已修**：`judgeBudgetMs` 抬升到"每候选一次完整尝试" | `e2829c6` |
| §4.1 `--live` 恒 exit 0、指标可反向（**critical**） | **已修**：失败率 > 10% 报 2、非争议危险放行 > 0 报 1；失败行不再计入 p95 | `c0a163a` |
| §4.2 `check-planes` 期待值靠人手同步 | **已修**：从测试源码数 + 用例名白名单 | `4844c97` |
| §4.3 `--replay` 只重放策略层 | **已修**：报告分「策略层落点改变」与「规则层今天会先接管」两节 | `d385137` |
| §4.4 指标盲格（`truth=ask → rejected` 无统计） | **已修**：`liveMetrics` 增 `shouldAskButDenied` / `shouldAskButDeniedSettled`，`--live` 报告与 stdout 各加一行，并被钉住与另两向互不重叠 | `435d99f` |
| §4.5 基线不可归因 | **已修**：报告头写 HEAD / 工作区脏标记 / 提示词哈希 / temperature | `d385137` |
| §4.6 评测集代表性 | **部分**：置信区间已补（`wilsonUpper`，`e2829c6`）；对抗样本覆盖仍缺 | `e2829c6` |
| §4.9 文档一致性 | **部分**：prepend、切回 WW、`v0.5.0` 已修；`first-principles.md` 的过时条目与行号失准未修 | `4353b44` |
| §2.2/§2.3 功能水位 | **引擎已改**：`actionScope` + `medium-uncertain-in-scope` 已在源码与离线评测中验证；**生产表现待预览验收** | `4353b44` |

**一句话**：表里 26 条里 **19 条已修**（含两条 critical：提权静默批准、评测指标反向；以及 12 条 major），**3 条部分修**（§4.6 评测集对抗样本、§4.9 文档欠账、§2.2 功能水位待预览验收），**4 条未修**——2 条 minor（§3.1.13 i18n 与死键、§3.1.14 计数表清理）、2 项能力缺口（§3.1.15 复合命令拆分、§3.1.16 非 shell 守卫）。没有一条未修项会让已修的结论失效。

**验证基线（十个提交之后，2026-10-10 重跑）**：单测 438/438；双平面 `check-planes` 3.18.2 = 438/433/0/5 与 3.18.4 = 438/438/0/0；`--policy` 18/18；`--replay` 137 条 ai 记录中 66 条可精确回放，策略层落点改变 0 条、规则层今天会先接管 0 条。（d385137 改版前的旧口径「影子回放自动放行 22 → 33」已不在新报告里列出。）

---

## 1. 方法与证据基础

审查由六条独立路径并行完成，结论在 §3 逐条交叉复核：

| 路径 | 范围 | 产出 |
|---|---|---|
| 本鲸鱼娘直查 | 核心裁决路径、脱敏、规则层、装配接缝 + 生产数据统计 | §2、§3.1 的实测条目 |
| 审查单元 A | `createHandler` / `rules.js` / `shell-shape.js` / `modes.js` 的绕过路径 | 见 §3.3 |
| 审查单元 B | `evidence.js` / `redact.js` / `command-facts.js` / `enrich.js` / `transcript.js` / `judge.js` | §3.1.4–3.1.8 |
| 审查单元 C | 配置校验、live getter、设置持久化、客户端 bundle | 见 §3.3 |
| 审查单元 D | `test/` 18 文件、`eval/` 三层、`scripts/` | §4 全节 |
| 审查单元 E | 主流 coding agent + DSH 生态同类插件 + HITL/HNITL 学术实践 | §5、§6 |
| codex 独立审核 | 整库只读，`gpt-6.1-sol` + medium | §3.2（逐条复核） |
| 审查单元 F | `docs/` 全 10 份文档 × 代码的逐条一致性 + 默认值对照表 | §4.9 |
| 审查单元 G | 功能完备性：未生效机制、死代码、配置错位、能力缺口 | §2.3、§7.2 |

**证据可复现性**：本报告所有"实测"结论都给了命令或脚本；审查未修改项目内任何文件（`git status` 与审查前一致），临时产物写在 `.pgtest/` 与 `/tmp`。

**生产数据口径**：`~/.dsh/logs/approval.jsonl`（774 行 / 257 次决策 / 2026-08-14 起）+ `~/.dsh/sessions/**/*.zstd` 解压后的 `approval/asked` + `approval/decided`（368 个会话中 101 个含审批，336 次请求、335 次裁决）。

---

## 2. 功能审查

### 2.1 定位与它真实解决的问题

插件接管 DSH 的 `approval/request` 接缝，把"谁来裁"这一维从宿主的沙箱档位里拆出来（宿主只回答"边界在哪"）。三层判定：有序规则 → AI 裁判 → 策略映射。三种模式：`manual`（旁路，可退化为"未安装"）/ `ai`（HITL）/ `ai-auto`（HNITL）。

`docs/first-principles.md` 把这个设计的必然性推得很干净：规则延迟 1 ms、成本 0；AI 秒级、有 token 成本、概率性错误；人类可靠但打断昂贵——所以"确定性结论排在前面，失败方向指向下一环"不是产品口味而是成本-可靠性排序的系。**这个推理是成立的**，插件也确实按它实现。

### 2.2 实测：插件在本机的真实产出

**（生产数据）** 2026-10 月（`ai` 与 `ai-auto` 混合，63 次决策）：

| 指标 | `ai` 模式（n=39） | `ai-auto` 模式（n=24） |
|---|---|---|
| 自动放行 | 3（8%） | 19（79%） |
| 拒绝 | 1（3%） | 5（21%） |
| 交人工（弹窗） | **35（90%）** | 0（0%） |

**（生产数据）** 判定层本身已经修好了：AI 失败率 8 月 4% → 9 月 70% → **10 月 0/53**。`unparseable judge output` 最后一次出现在 2026-09-30，之后 53 次判定零失败（`maxTokens` 提到 2048、超时放到 60 s 之后）。`docs/first-principles.md:224` 那条"AI 层 61% 失败率"的实测**已经过时**，它会把读者引向错误的第一优先级。

**（生产数据）** 延迟：规则命中中位 3 ms，AI 判定中位 **6.9 s**（10 月）。也就是说在 `ai` 模式下，一次审批的典型代价是"等 7 秒 → 还是弹窗"。

**（生产数据）** 判定分支结构（10 月 53 次 AI 判定）：`ask-without-authorization` 19、`judge-allow` 20、`high-risk-insufficient-authorization` 5、`judge-deny` 5；`enforced`（因"没人授权"而强制交人工）24 次 = 45%。**这 24 次正是把 `ai` 模式放行率压到 8% 的主因**——它是 0.4.x 的安全收紧（AI 说 allow 但超出档位、或 AI 拿不准且风险 ≥ medium 且无人授权 → 交人工），安全上正确，但代价是把"减少打断"这个产品价值吃掉了大半。

**（生产数据）** 两个机制在 774 行日志里**触发 0 次**：补证 `evidenceFetch`（0 条 `evidenceRounds`）与拒绝熔断 `denialBreaker`（0 条 `kind=breaker`）。前者是 0.4.x 的一整块最复杂的设计（裁判最多索要 2 个工作区内文件 + 二轮判定 + 白名单 + 脱敏），在真实流量里从未被激活。

**（生产数据）** 形状分布暴露了规则层的结构性上限：10 月 63 次决策中 `opaque` 40、`not-shell` 19、`compound` 4、`simple` **0**。规则层命中 9 次（14%），其中 `*/.dsh/profiles/*` 一项就占多数。**形状闸门（allow 只对 `simple` 生效）加上真实命令普遍是复合/重定向/变量，使 allow 规则族在真实使用中近乎不可达**——这解释了为什么"常见操作自动处理"这个卖点兑现得如此有限：`cd x && git status` 这类最常见的形态拿不到 allow，只能去排队等 7 秒的 AI。

**（生产数据）** 规则层比"命中 14%"更悲观：258 次决策里规则命中 32 次（12%），而其中**规则放行的 7 次全部发生在 2026-09-28 引入形状闸门之前**；形状时代（09-28 起，119 次决策）**规则放行 0 次**。同一窗口里 `simple` 形状只有 1 次（100 次 shell 请求中 1 次），`opaque` 94 / `compound` 5 / `not-shell` 19。结论：**默认 allow 规则族在当前真实使用中等于不存在**——不是"命中率低"，是"结构性关闭"。

### 2.3 功能缺口（按影响排序）

1. **`ai` 模式的信息价值被 `enforced` 分支吃掉**：45% 的 AI 判定因"没有用户授权"而交人工。缓解方向不是放松红线，而是让"授权"更容易被观测到——例如把用户在本会话内的显式指令（`/approval-mode` 之外的常规对话请求）更可靠地喂给裁判（`transcript: short` 当前只有 22/119 次 AI 判定带上下文，即 18%）。
2. **补证与熔断是"设计过度"候选**：两者在真实流量 0 触发，却带来代码复杂度、prompt 面、白名单绕过面（§3.1.5 TOCTOU 就在补证路径上）与测试负担。要么收窄到有真实需求的形态，要么先证明会用。
3. **规则层对非 shell 工具（`edit` / `write`）没有对应能力**：10 月有 26 次 `edit`、2 次 `write` 走审批（占 pass 的 18%），全部直接落到 AI 层——`allowEligible` 对非 shell 工具直接返回 true，形状闸门不适用，也没有针对写文件工具的路径守卫。
4. **人类裁决不回流**：宿主已经持久化了 `approval/asked` + `approval/decided` 对，插件没有读取它来沉淀规则或调参（生态里 `dsh-approval-gate` 与 `cuddly-guacamole` 都做了"确认 N 次后自动放行"的确认制学习）。
5. **多答者共存无自检**：`docs/security.md:62-86` 整节讨论"抢答与被旁路"，但插件**不知道自己是否被别的 answerer 抢先**，被旁路时静默失效、不报错不告警（§3.1.9 还确认了该节对 prepend 的描述与代码不符）。
6. **`fallbacks` 在超时场景失效**：本机 `timeoutMs=60000 > totalBudgetMs=30000`，主候选挂起时预算先耗尽，第二个候选不会被调用（§3.1.18）。日志证据：`judgeAttempts` 恒为 1、`judgeFallbackFrom` 0 条。
7. **非 shell 工具没有分级能力**：`edit` / `write` / `patch` 的结构化规则**恒不匹配**，`pathGuard` / `forbidOptions` / `configGuard` 三个选项都只存在于结构化规则上；`Write(*)` 这类文本 allow 对 `{"file_path":"/root/.ssh/authorized_keys"}` 会直接命中且无路径检查（§3.1.16）。10 月 26 次 edit/write 全部落到 AI 层。
8. **结构化规则不覆盖复合命令**（§3.1.15）：`cd pkg && npm publish` 对 `{pattern:["npm","publish"],action:"ask"}` 返回 null。
9. **决策反馈丢掉"哪条规则"**：`ruleLabel` 已经算好并写进审计（`index.js:1599`），但注入给模型的纠正文与 GUI 都不渲染它（`i18n.js:119-134`）——模型无法针对性重试，人也无法从界面看出"为什么这次被判"；GUI 侧目前只有设置卡片，没有决策查看面。
10. **配置面与 UI 的能力错位**：`rules`、`ai.enabled`、`ai.maxJudgeCommandChars`、`denyFeedbackMax`、`logFile`、`logMaxBytes` 六个**在用**字段不在 `Config` schema 里，因此 0.2.0 的设置卡片完全管不到它们（`docs/configuration.md` 却把它们与可热改字段并列）。
11. **`sessionOverrides` 只能手工枚举**：本机 patch 里 11 行 `session-<uuid>: ai|ai-auto` 硬编码，无 TTL、无项目/路径维度——"同一台机器上不同工作区用不同策略"这一维等于空缺。
12. **测试在生产接缝上零覆盖**：`test/index.test.mjs` 有 22 处注入 `resolvePath`、所有 handler 用例都注入 `getCwd`，**没有一条用例跑生产默认接线**——这正是 §3.1.2 那条死接线能在 399 个绿测里隐身的原因。

---

## 3. 安全审查

### 3.1 新发现（本报告的主要产出，均已实测或逐行确证）

#### 3.1.1 【critical】提权请求被 allow 规则静默批准——规则层完全没有 `escalation` 维度

**（代码）** `resolveRule`（`index.js:1474-1489`）对命中的 allow 规则只跑 `pathGuard` 与 `configGuard`，`guardOpts`（`:1560-1563`）里只有 `path` / `config`，**没有 `escalation`**；verdict 构造（`:1490-1603`）也从不看 `facts.escalationTo`。

**（代码）** 默认 allow 规则里有一批**无任何 guard** 的只读命令：`ls`、`pwd`、`which`、`echo`、`wipefs -n`、`wipefs --no-act`（`DEFAULT_CONFIG`，已 dump 确认）。

**（代码）** 宿主把 `allowed-once` **直接**当作授予提权：`dsh-sandbox/lib/index.js` 的 `approveEscalation` — `switch (outcome) { case "allowed-once": return mode; … }`；提权请求经 `approval.approver.request({ … reason: "escalate sandbox to <mode>: <justification>" })` 进入本插件的接缝。

**（实测 / 审查单元 A）** `{command:"ls", sandbox_permissions:"danger-full-access", justification:"…"}` → 命中 `{tool:"bash",pattern:["ls"],action:"allow"}` → 返回 `allowed-once`：**judge 一次都不被调用，用户看不到任何弹窗，沙箱被放宽到 `danger-full-access`**。

**（生产数据）** 这不是理论问题：本机 258 条决策中 **37 条带提权请求**（全部 `to: danger-full-access`），按判定来源分 `kind=rule` 4 条 / `kind=ai` 33 条。`rule` 那 4 条恰好都是 `deny`/`ask`（`*rm -rf /*`、`*/.dsh/profiles/*`、审计日志本体），所以**尚未真实发生过"提权 + allow 命中"**；但 33 条走 judge 的提权里有 19 条被放行——说明"带提权执行"在这台机器上是常态操作，只差一次命令文本落进 allow 白名单。

**为什么是缺陷**：提权审批的语义是"用户同意把**这次调用**放进更宽的沙箱"，插件把它降级成"命令文本命中只读白名单"。作者自己在 `actionKeyOf` 的注释里写明「同一命令在更宽的沙箱模式下是不同动作，人类批准一个不等于批准另一个」（`index.js:1394-1400`）——**键的语义认了提权，规则层不认**，属内部不一致。危害上限是"沙箱外目录/文件枚举"（`ls /etc/caddy`、`ls /var/log`、`ls /home/wenxin` 不命中任何红线；`.ssh` / `.aws` 那类有独立 ask 规则兜底）加**审批层被整体绕过**——而"提权一定会弹窗"正是用户对这个插件的核心预期。结构上更糟的是：**任何未来加进 allow 列表的命令都自动继承这条通道**。

**建议**：把「本次调用未请求提权」作为 allow 的**硬编码前置条件**（`facts.escalationTo === undefined`）；带提权目标一律降级到 judge（judge 已在 prompt 里看到 `escalation`）或强制 `ask`。做成硬编码 guard 比交给规则作者写 `escalationGuard` 更可靠。

> **生态对照（已核一手源）**：官方 `@deepseek-ai/dsh-experimental-auto-review` 把"提权"当一等公民设计——它在 `tools/pre-execute` 上前置审查，声明 "an allowed call executes with **Full access**"，且 "malformed reviewer responses and technical failures fail the call with their specific error and **never execute it**"（其自述限制同样包括 "can allow unsafe actions, deny useful work, and spend additional tokens"）。官方模型的"放行"是**显式授予 Full access**、被当作独立语义对待；而本插件是在 `approval/request` 接缝上**按命令文本**批准一次已经提出的提权请求——`escalation` 这个维度在规则层根本不存在。来源：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/auto-review/README.md>（2026-10-08 抓取）。

#### 3.1.2 【major】`pathGuard` / `configGuard` 与实际执行目录脱节

**（实测）** 集成级复现（用真实 `createHandler` + 真实默认规则 + 真实文件系统）：

```
默认 cat 规则: [{"tool":"bash","pattern":["cat"],"action":"allow","pathGuard":"workspace-relative"}]
`cat keep.txt`（无 workdir）                 → {"outcome":"allowed-once","next":0}
`cat keep.txt`（workdir=<工作区外的目录>）    → {"outcome":"allowed-once","next":0}
```

**（代码）** 守卫用的是会话工作区根，不是命令的执行目录：

- `index.js:1502` — `const cwd = getCwd !== undefined ? getCwd(req.agent) : undefined;`
- `index.js:2348` — `getCwd: (agent) => agent?.session?.policy?.workspaceRoot ?? agent?.cwd`
- `index.js:1560-1563` — `resolveRule(..., { path: { cwd, root: cwd, resolvePath }, config: { root: cwd } })`
- `facts.workdir`（来自 `enrich.js:94` 的 `args.workdir`）**只**用于 judge 输入、补证 base 与审计，不进守卫。

**（代码）** `workdir` 是模型可控的合法工具参数：`dsh-tool-bash/lib/index.js:277-280` 在工具 schema 里暴露它（描述 "Working directory for this command"），`dsh-bash-local/lib/index.js:170` 用它做 spawn cwd（`workdir: request.workdir ?? ...`）。

**为什么是缺陷**：`docs/security.md` 把 `pathGuard` 写成「每个路径参数的真实实体必须落在工作区根内」——语句正确，但**检查的根不是命令运行的根**。危害有两个变体：

- **路径变体**：`cat <相对路径>` + `workdir` 指向别处 → 自动放行读工作区外同名文件。凭据类目录（`.aws` / `.ssh` 等）有独立 ask 规则兜底（**实测** `cat .aws/credentials` + `workdir=外部` 返回 `unavailable`，未放行），但非特定名的文件（项目配置、日志、`.env` 之外的凭据文件）不在此列。
- **git 变体（更严重）**：`configGuard` 的 `root` 是会话根，而 `gitConfigGuard` 只读 `<root>/.git/config`（`index.js:1354-1383`）。若 `workdir` 指向工作区内的**子目录仓库**，`git status` 会执行该仓库 `.git/config` 里的 `core.fsmonitor` / `diff.external`，而插件检查的是工作区根的（干净的）`.git/config`。**（审查单元 A 实测）** `git -C subrepo status` 真实执行了 config 指定的脚本（写入 `/tmp/probe-pwned.log`，git 2.47.3）；`fsmonitor` 放在会话根时 guard 正常生效（规则被丢弃），放在 `workdir` 指向的 subrepo 时返回 `allowed-once`。这条链完全在工作区写权限内，与 §3.1.1 组合即为「提权 + 只读 git 文本 + guard 空转」的端到端绕过。

**关键背景：这两条守卫在生产上本来就空转（审查单元 A 发现，本报告用日志证实）**

**（生产数据）** 258 条决策记录中 **带 `cwd` 字段的 0 条、带 `workdir` 字段的 0 条**（`index.js:1748` 只在 `cwd !== undefined` 时写）。而 `pathGuardAllows`（`index.js:1253`）与 `gitConfigGuard`（`:1355`）在 `root` 非字符串时**一律返回 false**。也就是说 `getCwd` 在这台机器上取不到值，于是**文档承诺的 `pathGuard` 与 `configGuard` 在真实运行中从不产生自动放行，只产生"丢弃规则 → 落 judge"**（方向保守，故本身是 minor；但文档描述与实际不符）。**根因已定位（审查单元 G）**：宿主 0.2.0-rc.2 的工作区根在 `session.header.cwd`（`dsh-session/lib/index.js:1703,1897`、`dsh-sandbox-policy/lib/index.js:145` 的 `resolveWorkspaceRoot(session?.header.cwd ?? …)`），而 `workspaceRoot` 只挂在 SandboxPolicy 服务上、`session.policy` 并不存在——所以 `agent?.session?.policy?.workspaceRoot ?? agent?.cwd` 两条路都落空。影响面比 §3.1.2 之前写的更大：**22 条默认 allow 规则里有 9 条（41%）带守卫，因此永不生效**；`transcript` 的 `[W]` 行、补证读取的 `root`（`evidence.js:155-158` 无 root 一律 `outside-workspace`）也一并空转——补证不是"裁判从没问过"，而是**问到了也必然全拒**；而 `denial 记录`/`plugin-loaded` 都不带 `cwd`，所以这一切在日志里没有任何信号。

> **由此得出一条必须写进修复计划的判断**：§3.1.2 的两条缺陷目前是**潜伏**的。如果只修 `getCwd`（让守卫拿到工作区根）而不同时修 `workdir` 的参与，安全状况会**变差**——守卫会从"一律不自动放行 `cat`/`git`"变成"可被 `workdir` 绕过地自动放行"。**这两件事必须同一提交修完**，否则第一步就是净负面。

**讽刺点（代码）**：同一个 handler 在补证路径上用的是**正确**的基准——`index.js:1652` `base: facts?.workdir === undefined ? cwd : resolve(cwd, facts.workdir)`。作者知道 `workdir` 会改变相对路径的基准，只在守卫侧漏了。

**建议**：`path` / `config` 的 `root` 与 `cwd` 改由 `facts.workdir` 参与解析（`resolve(cwd, workdir)`），并对 `configGuard` 增加"实际仓库根"的定位（至少 `workdir` ≠ 会话根时不做 git 只读命令的自动放行）。同时把 `getCwd` 换成宿主真实 API（`workspaceRoot` 挂在 SandboxPolicy 上），并在取不到时于启动审计里显式告警"pathGuard / configGuard 不生效"——静默空转是这两条防线最不该有的状态。


#### 3.1.3 【major】一次性人工授权键可在动作之间转移

**（实测）**：

```
python deploy.py --token=STAGING      → 键 061ffaab9e8b8820
python deploy.py --token=PRODUCTION   → 键 061ffaab9e8b8820   相同 = true
两者脱敏后均为: "python deploy.py --token=[REDACTED]"
```

**（代码）** `index.js:1557` `const actionKey = actionKeyOf(req.toolName, argsText, facts)`，其中 `argsText = redactSensitive(fullText)`（`index.js:1538`）；`actionKeyOf` 用这个脱敏文本做 sha1（`index.js:1393-1405`）。该键同时用于熔断计数与 `/approval-allow-once` 的一次性授权（`index.js:1568-1571`）。

**为什么是缺陷**：`docs/security.md` 明写「一次性授权不可转移：授权键是（工具、实际目录、提权目标、命令全文）的 JSON 元组哈希——改目录、加提权、或伪造分隔符都产生不同的键，人工签字只对它签的那一个动作生效」。实际是**命令全文被换成了脱敏后的命令全文**，而 `redactSensitive` 会把 `token=` / `password=` / `api_key=` 等赋值的值抹成同一个占位符——于是「同一个模板换一个凭据值」= 同一个键。人工为 STAGING 签的字，被 PRODUCTION 消费。**注意规则层与 AI 层都过不了这一关**（gate 在 `rule === null` 之后才求值），所以被消费的是一次真实的放行。

**复现路径**：`grep -n "actionKeyOf" index.js` → 1557；`git log -S "redacted full text"` 可见该设计的原始意图（"two requests that would be decided identically share a key"）——意图是"判定相同的动作共享键"，但对一次性**人工授权**而言，凭据值不同就是不同的动作。

**建议**：一次性授权键用原始文本（或原始文本 + 脱敏文本）计算，脱敏只用于展示与传输；若担心凭据进内存，可对值做 HMAC 而不是抹平。

#### 3.1.4 【major】统一脱敏对"环境变量风格"的凭据名完全不生效

**（实测）** 直调 `redactSensitive`，18 条常见形态 **14 条泄漏**（判据：原始秘密子串仍完整出现在输出里）：

| 形态 | 结果 |
|---|---|
| `Authorization: Basic dXNlcjpwYXNzd29yZA==` | **泄漏**（且 `Authorization:` 标签被涂黑，值留下） |
| `Authorization: token ghp_16C7e42F...B4a` | **泄漏** |
| `Proxy-Authorization: Basic YWRtaW46...` | **泄漏** |
| `export GITHUB_TOKEN=ghp_...` | **泄漏** |
| `AWS_SECRET_ACCESS_KEY=wJalr...` | **泄漏** |
| `AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE` | **泄漏** |
| `npm config set //registry.npmjs.org/:_authToken=npm_...` | **泄漏** |
| `git clone https://oauth2:glpat-...@host/x.git` | **泄漏**（URL userinfo 无任何规则） |
| `psql postgres://app:s3cr3t@db/prod` | **泄漏** |
| `curl -u admin:hunter2` | **泄漏** |
| `sshpass -p hunter2 ssh u@h` / `redis-cli -a hunter2` | **泄漏** |
| PEM 私钥块 `-----BEGIN OPENSSH PRIVATE KEY-----` | **泄漏** |
| `export T=eyJhbGciOiJIUzI1NiJ9...`（裸 JWT） | **泄漏** |
| `curl -b "session=abc123"` | 泄漏 |
| `Authorization: Bearer sk-...` / `curl -d token=xoxb-...` / `curl -H "X-Api-Key: sk-..."` / `--password=...` | 正常脱敏 |

**根因（代码）**：`redact.js:42,54` 的标签规则是 `\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|token)\s*[:=]\s*…`。`_` 是词字符，所以 `AWS_SECRET_ACCESS_KEY` 的 `secret` 前、`GITHUB_TOKEN` 的 `token` 前、`_authToken` 的 `token` 前**都没有词边界**，整条规则不触发。`sk-` 与 `Bearer` 两条规则恰好救了 `OPENAI_API_KEY=sk-…` 这类样例，所以简单自测能过。

第二个独立根因：`(?![Bb]earer\b)` 负向断言让标签规则对**非 Bearer 的认证方案**也生效，而值的字符类 `[^\s,;&|\\]+` 遇到空格即停——于是 `Authorization: Basic <b64>` 被处理成 `Authorization: [REDACTED] <b64>`，**标签涂黑、凭据留白**。这比"不脱敏"更糟：看起来像处理过了。

**影响面（代码）**：`redactSensitive` 是插件声明的**唯一**脱敏边界，应用到 AI prompt（`index.js:1538-1539`）、会话骨架（`1611`）、审计 `argsPreview` 与 `reason`（`1545`/`1743`）、拒绝反馈文案（`1837`）。这些值会发给外部 provider 并落到 `~/.dsh/logs/approval.jsonl`（0600，但仍在磁盘，且该日志本身是 `ask` 规则覆盖的对象）。

**建议**：值类规则改用 `(?<=^|[^A-Za-z0-9])` 前缀或 `[A-Za-z0-9_-]*` 容错；补 `-u/--user`、URL userinfo、`AKIA[0-9A-Z]{16}`、`xox[baprs]-`、`gh[opsu]_`、`npm_`、PEM 块、裸 JWT（`eyJ...eyJ...`）规则；把 `Authorization: <scheme>` 改成"吃掉 scheme + 值"（`(?:\\.|[^\s,;&|"])+`）而不是只吃 scheme。**并给 `redactSensitive` 建一个"已知形态"的对抗测试集**——当前 `test/redact.test.mjs` 只断言已覆盖形态，缺口对测试不可见。

#### 3.1.5 【major】补证白名单存在 TOCTOU：`realpath` 复核与实际读取不是同一个对象

**（代码）** `evidence.js:183`（`resolvePath`）→ `189`（`relative` 判内）→ `197`（凭据名复核）→ `202`（`stat`）→ **`217`（`read`）**，全部基于 `targetReal` 这个**字符串路径**四次独立解析。检查通过后、读取之前，只要该路径（或其父目录）被换成指向工作区外的符号链接，读到的就是外部文件，而凭据名检查用的是旧名字（CWE-367）。

**（审查单元 B 实测）** 注入式时序复现：`fetchEvidence` 返回 `files[0].text === "OUTSIDE-SECRET"` 且 `refused === []`；把父目录 rename 后 symlink 到外部同样成功。放大条件（代码）`enrich.js:97` 支持 `run_in_background`——被审的 agent 可以先跑一个后台脚本在高频窗口里翻转"普通文件 ↔ 外部符号链接"。

**严重度判定**：核心承诺（"裁判只能读工作区内的东西"）被破坏，但需要毫秒级竞态 + 真实流量里补证触发 0 次（§2.2），故列 **major 而非 critical**。

**建议**：`open(targetReal, O_RDONLY | O_NOFOLLOW)` → `fd.stat()` 校验 `isFile`/size → 在同一 fd 上 `fd.readFile()`；或 open 后 `fstat` 比对 `dev`/`ino` 与 `realpath` 结果一致，不一致即拒。

#### 3.1.6 【major】补证正文不过脱敏边界；模型回显直写审计

**（代码）** `judge.js:125` 把 `file.text` 原样拼进 prompt（`--- ${file.path} — ${file.bytes} bytes\n${file.text}`），`index.js:1673` 把 `fetched.files` 原样传入。全仓库里唯一对 evidence 文本脱敏的地方是失败输出 `rawText`（`judge.js:379` 附近）——**成功路径没有**。

**（代码）** 模型输出回写审计同样无脱敏：`index.js:1701-1703` 的 `aiEvidence` / `aiUnknowns` / `aiReason` 直接采信 verbatim（命令文本已脱敏，但若模型从 evidence 正文里学到了一段凭据，它会出现在审计里）。

**为什么是缺陷**：`redact.js` 头注释把自己定义为"每个命令文本路径的唯一脱敏边界"，而补证文本前面只剩凭据清单一道闸——清单不完备（§3.1.7）时凭据直接外发到 provider，且本地审计不留痕、不可追溯。

**建议**：`judge.js:125` 对 `file.text` 过一遍 `redactSensitive`；`index.js` 写审计前对 `aiReason` / `aiEvidence` / `aiUnknowns` 统一脱敏。

#### 3.1.7 【major】补证凭据清单不完备，且后缀即可绕过

**（审查单元 B 实测，口径已核对）** `evidence.js:54-74` 的 `CREDENTIAL_PATH`：

```
ALLOW  .credentials.json / .claude/.credentials.json      ← 规则要求段名以 credentials 开头，".credentials" 不匹配
ALLOW  service-account.json / application_default_credentials.json
ALLOW  kubeconfig / .pgpass / .pypirc / .my.cnf / .htpasswd / .npmrc.bak
ALLOW  .bash_history / .zsh_history / terraform.tfstate / .envrc / prod.env
ALLOW  x.pem.bak / id_rsa.bak / secret.key.bak / credentials.json.bak    ← 加后缀即绕过
DENY   .env / .env.example / .npmrc / .netrc / .git-credentials / x.pem / id_rsa / .aws/credentials / .docker/config.json / auth.json
```

清单是「路径段锚定（`(^|\/)…(\/|$)`）+ 扩展名后缀匹配（`\.(pem|key|p12|pfx|keystore)$`）」混合口径，两类都有漏：段锚定 + 严格 `$` 让点前缀复合名（`.credentials.json`）与后缀变体（`.bak`/`.old`）漏网。

**建议**：段名归一化后按 `[._-]` 拆词元集合匹配；先剥离 `.bak`/`.old`/`.orig`/`.tmp`/`.save`/`.swp` 再判；补 `kubeconfig` / `service-account*` / `.pgpass` / `.pypirc` / `.bash_history` / `.tfstate` / `.envrc`。

#### 3.1.8 【minor ×4】其余已确证项

- **`command-facts` 重复 flag 触发 `break` 而非 `continue`**（`command-facts.js:215`）：`rm -rf a; rm -rf b && git reset --hard` 只报 `-rf`，漏 `--hard`。影响有限（prompt 里有完整命令文本），但确立了一条"提示越复杂越不可靠"的规律。
- **路径配额先到先得且静默丢弃**（`command-facts.js:41,152,155`）：`echo ./1 … ./6 /etc/shadow` → 唯一的 `outside` 路径被挤出，facts 看起来"干净"；AI 控制 argv 顺序，可主动把危险项排到第 7 位。建议越界项优先入列，或输出 `pathsOmitted`。
- **`workdir` 是唯一没过脱敏边界的请求字段**（`index.js:1622`/`1749`；同段的 `argsText`/`reason`/`escalation.justification` 都过了）：AI 可构造任意 `workdir` 字符串，等于一条绕过脱敏边界的任意文本通道（既进 prompt 也进审计）。
- **`parsedVerdict` 的一个未闭合 `{` 就让合法判定作废**（`judge.js:181` 的 `break`）：`{ oops\n{"risk":"high","authorization":"deny"}` → `null`。默认 `failOpen: ask` 时只是多一次人工，`ai-auto` 下变拒绝——但 `ai.failOpen: allow` 时是稳定压掉判定。建议 `cursor = start + 1; continue`。

#### 3.1.9 【minor】注册优先级：文档内部矛盾，且真实语义无人验证

**（代码）** `index.js:2352` 是 `ctx.on("approval/request", handler)`——**没有** `{ prepend: true }`。

**（代码）** `docs/security.md:70` 却写「本插件 prepend 在人类答复者之前」，`:78` 整段描述 prepend 的 `unshift` 语义；而 `docs/first-principles.md:233` 正确记载了"**没有** prepend，靠注册早于浏览器侧人类答者取胜"。**两份文档互相矛盾**。

**（代码）** 两份文档的机理都不完全对：`dsh-api-remotes/lib/index.js:102-125` 的 remote 桥是在**插件加载期**就 `ctx.on("approval/request", …)` 注册的（不是"等客户端连上来"），所以真实顺序由 bundle 加载顺序与 Cordis 的 scoped dispatch 共同决定。**（生产数据）** 774 行审计日志证明插件确实在生效（最近一条就在审查前几分钟）。

**（代码）** `test/index.test.mjs:512` 的假 ctx 是 `on: (name, fn) => ...`——第三个参数（options）被丢弃，因此"是否 prepend / 注册顺序"**无法被任何测试断言**。

**建议**：改正 `security.md:70` 的措辞并链接 `first-principles.md:233`；给假 ctx 保留 options 并加一条注册时序断言；**更强的做法**是让插件启动时自证位置（见 §7 的 P1）。

#### 3.1.10 【major】被候选超时截断的模型流若恰好解析出 verdict，会被当作正常判定采信，且审计不留痕

**（代码）** `attemptJudge`（`index.js:1000-1059`）用 `AbortSignal.any([signal, timeoutSignal])` 通知适配器取消；若适配器随之**干净结束**（没有 finish chunk），`run` 在 race 的 `hardTimeout` 分支之前就返回 `ok:true + endedWithoutFinish`。`makeLlmRunner`（`:1130`）只看 `parseVerdict` 非空即采纳，成功路径又把 `endedWithoutFinish` 丢掉（`judge.js:385-391`）；handler 只对外部 `req.signal` 设防（`:1736-1756`），对**候选超时**不设防。

**（实测 / 审查单元 A）** 流先吐完整 verdict 再挂住（`timeoutMs=80`）→ `{"outcome":"allowed-once","kind":"ai","action":"allow","policy":"judge-allow","judgeTimeoutMarked":false}`；对照：流吐 `{"risk":"lo` 后挂住 → `kind:"ai-error"` + `endedWithoutFinish:true` → 走 failOpen（正确）。

**为什么是缺陷**：判定输入的完整性因此不可审计，与一次正常完成无法区分。更微妙的是截断点——若截断落在"推理草稿里的 JSON"与"最终 verdict"之间，`parseVerdict` 的"只接受唯一 verdict 对象"规则在截断后只剩一个对象，**草稿就成了判定**。文档只承诺"单次判定有独立硬超时（不卡死）"，没覆盖"截断流被采信"。

**建议**：`run` 结束后检查 `combined.aborted`，已中止则返回 `ok:false + hardTimeout:true` 且不采信其文本；成功路径把 `endedWithoutFinish` 带进 `judgeWith` 与审计。

#### 3.1.11 【major】5 个声明 `volatile` 的字段没有接 live getter——配置写入成功但不生效

**（代码）** `totalBudgetMs`（`index.js:709`）、`evidenceFetch`（`:710`）、`evidenceMaxFiles`（`:711`）、`evidenceMaxBytes`（`:712`）、`denialBreaker`（`:714-718`）都包了 `live(...)`，但**不在 `LIVE_FIELDS`**（`:556-572`）。`installLiveGetters` 只给 `LIVE_FIELDS` 定义 getter，其余是装配期算出的静态属性（`:2333`）。

**（实测 / 审查单元 C）** 用同协议的 ref 模拟 loader 提交后：`riskTolerance`（LIVE）→ 立即变 `high`、`failOpen`（LIVE）→ 立即变 `allow`；而 `totalBudgetMs` 仍是 `30000`、`evidenceFetch` 仍是 `read-file`、`evidenceMaxBytes` 仍是 `16384`、`denialBreaker` 仍是默认值。

**为什么是缺陷**：loader 对 volatile 字段一律判等（`cordis-plugin-loader/src/config/diff.ts:18`）→ 走 `volatileOnly` 分支只写 ref、**不重载插件**（`entry.ts:143-186`），于是"写入成功、UI 报成功、运行期继续用启动快照、重启才生效"。而等价的 `rules:` / `ai:` 改动会触发真正的重载并立即生效——**同一个 patch 里两种字段两种时效**。受影响的是两个要紧的开关：`denialBreaker` 是拒绝熔断的唯一开关，`evidenceFetch` / `evidenceMaxBytes` 是"送多少工作区文件给第三方判定模型"的闸门。0.1.x 路径（`:2431-2435`）**会**更新这 5 个字段，说明作者的意图是热生效，**只有 0.2.0 的链路漏接**。审计里 9 条 `config-live-update` 的 `paths` 只有 `sessionOverrides`，说明尚未被真实触发。

**建议**：把 `["totalBudgetMs", ["ai","totalBudgetMs"]]`、`["evidenceFetch", ["ai","evidenceFetch"]]`、`["evidenceMaxFiles", …]`、`["evidenceMaxBytes", …]`、`["denialBreaker", ["denialBreaker"]]` 加进 `LIVE_FIELDS`（对象需按 key 接 getter），或去掉这 5 项的 `live()` 让它们走重载路径；并把它们补进 `config-live-update` 审计。

#### 3.1.12 【major】`assertConfig` 与 Config schema 双双漏掉主判定路由：`ai.timeoutMs: "15s"` / `ai.provider: ""` 静默改变行为

**（代码）** `provider` / `model` 是 `z.string()` 无 `min(1)`（`index.js:687-688`）；`assertConfig`（`:728-847`）不检查 `cfg.ai.provider` / `model` / `timeoutMs` / `maxTokens` / `maxPromptChars`；`Config` 里**没有 `ai` 键**（`:678-720`），所以 legacy 嵌套 `ai.*` 完全绕过 schema。对照：`fallbacks` 的条目两级都要求非空（`:689-692`、`:824-828`）。

**（实测 / 审查单元 C）** `Config({ai:{timeoutMs:0}})` 通过并保留 `0`，而顶层 `Config({timeoutMs:0})` 被 `min(1)` 拒；`ai.provider: ""` 通过。

**为什么是缺陷**：这两条值就是"AI 判定层是否活着"的开关。`timeoutMs=0` → 候选超时退化为 {0,1} ms → `AbortSignal.timeout(0)` 立即中止 → 每个候选都失败 → 按 `failOpen` 落地；`provider: ""` → `prepareCall` 抛错被吞成 `ok:false` → 同样落到 `failOpen`。**`failOpen: allow` 时即"审批闸门对所有未被规则命中的请求静默放行"**。非数值超时（YAML 里写 `"15s"` 很常见）更糟：`AbortSignal.timeout()` 在 `index.js:1001`——**在 `1004` 的 try 之外**——抛错沿 `1129` 冒到 handler（`:1490-1854` 函数体无 try），最终被宿主的 `.then(…, () => "unavailable")` 吞成 `unavailable`：**请求进了审批链却没有得到任何答复**。

**建议**：`assertConfig` 增补 `cfg.ai.provider` / `model` 非空字符串、`timeoutMs` / `maxTokens` 为 1..600000 的安全整数；schema 改 `z.string().min(1)`（与 `fallbacks` 对齐）；handler 加外层 `try/catch`，把未预期异常落成审计 + 明确的 `failOpen`，而不是抛成 `unavailable`。

#### 3.1.13 【minor ×4】配置与文案面的已确证项

- **i18n 缺 `evidence-incomplete` 标签**（`i18n.js:65-80` 的 `SOURCE_LABELS` 无该项，`:120-123`/`:209` 回退 raw key）：该内部 key 原样进入**模型纠正文**与 `/approval-allow-once` 列表，而 `i18n.js:60-64` 自述"绝不把内部 kind 泄漏给模型"。用户看到「来源：evidence-incomplete」无法判断这是"命令过长请拆分"还是新的拒绝原因。`finishKind`（timeout/error/aborted）同样原样进模型文案。
- **`ai.denyFeedbackMax` 是死键**（`index.js:461-462` 与 `:913` 的注释把层位写错）：patch 里写 `ai: { denyFeedbackMax: 1 }` 不报错也不生效，运行期只读顶层（`:1455-1460`），实际仍是 3。
- **`DSH_HOME=""` 时 `findLegacySettings` 会读 cwd 下的 `settings.yaml`**（`index.js:2281` 用 `??` 不拦空串，`join("", "settings.yaml")` 变相对路径）：唯一"可能读到非预期文件"的路径，影响仅限一条 warn/审计文本（不参与判定）。建议改 `||` 并对非绝对路径直接返回。
- **`docs/client-card.md:14` 的接缝已过期**：文档说卡片注册在 `settings.plugin.item`，代码是 `settings.section`（`src/client/index.ts:115-126`，注释里明说该 slot 在 0.2.0 被删）。照文档去「插件配置」页找不到卡片。

#### 3.1.14 【minor】计数表无会话级清理

`breakers` / `history` / `feed` 是进程级 `Map`（`index.js:1431-1447`），键为 `sessionId` 且**无淘汰**；`actions`（`:1817`）每个不同 `actionKey` 一条、永不衰减；未消费的 `oneShot`（`:2151`）永久留存。会话数 × 被拒动作数无上界——长跑 host 上缓慢泄漏（`actionKey` 是 16 位 hex，量级小，不影响判定的对错）。建议按 `sessionId` 做 LRU 或监听会话结束清理。

#### 3.1.15 【major】结构化规则对复合命令不可见：`cd pkg && npm publish` 绕过结构化 ask/deny

**（实测 / 审查单元 G，用 `evaluateRules` 探针）**：结构化（Codex `prefix_rule` 风格）规则只比较 `opts.argv`，而 `compound` 形状的 `argv` 被定义为 `parts[0]`（`shell-shape.js:160-169`）：

| 规则 | `npm publish` | `cd pkg && npm publish` | `cd pkg; npm publish` |
|---|---|---|---|
| `{tool:"bash",pattern:["npm","publish"],action:"ask"}` | 命中 | **null** | **null** |
| `{tool:"bash",pattern:["git","reset","--hard"],action:"deny"}` | 命中 | **null**（`cd x && git reset --hard`） | — |

**为什么是缺陷**：`docs/configuration.md` 的规则示例**全部**是结构化前缀形式，而真实流量里 `compound` / `opaque` 占绝大多数（§2.2）。只有 `flagGuard`（遍历 `parts`）与文本 glob 能覆盖复合命令——默认配置正是靠 `Bash(*git reset --hard*)` 一类文本规则兜住的，但**用户自写结构化 ask/deny 时得不到任何提示**，会以为自己加了一条规则。`shell-shape.js:10-11` 的注释其实承认了这一点（"P1 will judge each part separately, Codex-style"），那条 P1 **没有做**。

**建议**：要么实现按 `&&`/`;`/`|` 拆分后逐段判定（Codex 用 tree-sitter 做的正是这件事），要么在装配期对 `isStructuredRule` 的 ask/deny 规则发出告警"本规则不覆盖复合命令，请补一条文本规则"。

#### 3.1.16 【major】非 shell 工具没有任何路径级守卫：`Write(*)` 可 allow 到 `/root/.ssh/authorized_keys`

**（实测 / 审查单元 G）** `{match:"Write(*)",action:"allow"}` 对 `{"file_path":"/root/.ssh/authorized_keys"}` **命中 allow**，全程无路径检查；而 `{tool:"edit",pattern:["x"],action:"ask"}` 这类结构化规则对非 shell 工具**恒不匹配**（`argv` 不是数组直接排除，`rules.js:302-303`）。

**（代码）** `pathGuard` / `forbidOptions` / `configGuard` 三个选项都**只存在于结构化规则**上，而结构化规则只服务 `bash` / `pwsh`（`shell-shape.js:30` 的 `SHELL_TOOLS`）。`allowEligible`（`rules.js:293-296`）对非 shell 工具直接返回 `true`——形状闸门不适用。

**（生产数据）** 10 月有 26 次 `edit`、2 次 `write` 走审批（占 `pass` 的 18%），其中只有 2 次靠文本 ask 规则命中，其余全部落到 7 秒的 AI 判定；而 `docs/security.md` 从未把"非 shell 工具没有路径守卫"列为已知边界。

**建议**：把非 shell 工具的参数归一成"可检查目标集"（路径 / 目标文件 / 内容），再复用现有 guards；顺带修掉 `pathGuardAllows` 的 `args.length === 0 → true`（`index.js:1252`）——"提取不到参数"应当算拒绝，否则接上非 shell 之后守卫会形同虚设。

#### 3.1.17 【minor】文档里的两处安全声明与实现相反（审查单元 F）

- **「deny 规则永远最先求值」不成立**（`docs/security.md:7`）：规则层只在 `evidenceIssue === null` 时才求值（`index.js:1559-1564`）——参数恢复失败或命令超预算时**整层跳过**，直接落到 `ask`/`reject`。方向是 fail-safe，但"AI 无权覆盖显式拒绝"这条保证在那条路径上不存在。`docs/decision-chain.md:14-17` 的编号顺序其实已经把证据门槛排在规则层之前。
- **「切回 Workspace Write 暂停插件」与机制相反**（`docs/security.md:84`）：handler 只看 `cfg.enabled` 与 `mode`，**不看权限档**（`index.js:1490-1500`；`security.md:59` 自己也承认 `danger-full-access` 下插件才空闲）。用户照这条建议操作，等于把插件从"空闲"切成"活跃自动裁决"。
- 另有：`docs/decision-chain.md:130` 把 `ask-without-authorization` 的括注写成"live 基线里 `curl … | sh` 正是从这里被**放行**的"，而该分支的 action 是 `ask`（`judge.js:321-323`）——原意是"新增该分支**之前**曾被放行"（`changelog.md:29`）；`docs/evaluation.md:52` 与 `scripts/eval.mjs:382` 引用了不存在的 `v0.5.0`；`docs/configuration.md:3` 自称"全部配置项"却漏了 `enabled`（`index.js:94`）。

#### 3.1.18 【major】`timeoutMs` 与 `totalBudgetMs` 无联动：本机把超时调到 60 s，反而让 fallback 链失效

**（实测 / 审查单元 G）** 本机 patch（`~/.dsh/profiles/web/cordis.patch.yml:22`）把 `ai.timeoutMs` 从 15000 改成 **60000**，而 `ai.totalBudgetMs` 仍是默认 **30000**。`makeLlmRunner` 用剩余预算压制每个候选（`index.js:1122-1131`），于是**主候选挂起时预算先耗尽、第二个候选根本不会被调用**：探针实测 `budgetExhausted:true` 且 `candidates tried: ["primary/m"]`。

**（生产数据）** 日志里 `judgeAttempts` 82 条**恒为 1**、`judgeFallbackFrom` **0 条**——配置好的 `fallbacks` 链从未真正前进过一次。

**为什么是缺陷**：`fallbacks` 的设计目标恰恰是"主模型失败时兜底"，而"主候选挂起"是最需要兜底的一类故障；现在的组合让它在这类故障上静默失效。调一个参数关掉了另一个功能，且装配期无任何一致性校验。**附带风险**：`docs/first-principles.md` 把"候选链的正确判据"当作已验证的机制来讲，读者不会想到它在本机是空转的。

**建议**：装配期加一致性校验（`timeoutMs <= totalBudgetMs`，或按候选数推导预算下限），并在 `plugin-loaded` 审计里记录两者的实际取值。

### 3.2 codex（gpt-6.1-sol / medium）独立审核：结论与复核

codex 报了 3 条 major + 1 条 minor。逐条复核（**codex 说的不算数**）：

| # | codex 结论 | 复核判定 | 依据 |
|---|---|---|---|
| 1 | `pathGuard` / `configGuard` 忽略实际 `workdir` | **真**（= §3.1.2） | 本鲸鱼娘集成复现：`cat keep.txt` + 外部 workdir → `allowed-once`；`dsh-tool-bash:277` 证实 workdir 是模型可控参数 |
| 2 | 一次性授权可转移到另一条命令 | **真**（= §3.1.3） | 实测两键相同（`061ffaab9e8b8820`）；codex 给的 `STAGING`/`PRODUCTION` 例子与我的独立发现一致 |
| 3 | 补证正文及模型回显绕过脱敏 | **真**（= §3.1.6） | `judge.js:125` / `index.js:1701-1703` 确无脱敏；与审查单元 B 的第 3 条交叉验证 |
| 4 | `record()` 之后的取消窗口 | **真但降级为 minor** | `index.js:1790` 的 `await record(...)` 期间 signal 可 abort，返回前不再检查；但宿主 `dsh-user-approval/lib/index.js:181-191` 自己 race 了 signal（先 abort 则 `resolve("cancelled")`），所以**不会真的执行**，影响是插件审计记成 `allowed-once` 而实际 `cancelled` |
| — | `node --test` 未全绿（`index.test.mjs` 失败，`/tmp` EROFS） | **假** | 本机实测 `node --test` = **399 tests / 399 pass / 0 fail / 0 skip**。codex 只读沙箱的 `/tmp` 不可写才是原因 |

**codex 已核对无问题的项**：deny 优先；复合命令不被 allow 规则认领；多 verdict/嵌套包装拒绝解析、单个围栏对象可接受；熔断只拒绝；单份授权无并发双花窗口；三项无人值守红线校验成立。

> 方法学备注：这是"不要照单全收"的实证——codex 的 4 条里 3 条为真（其中 2 条与我的独立发现重合，构成交叉验证）、1 条降级、1 条环境误判。

**多路交叉验证矩阵**（同一结论被几条独立路径命中 = 置信度）：

| 结论 | 独立命中路径 | 状态 |
|---|---|---|
| 守卫与实际执行目录（`workdir`）脱节 | codex #1 + 审查单元 A + 本鲸鱼娘集成复现 | 三路，已实测 |
| 一次性授权键脱敏后碰撞 | codex #2 + 审查单元 A（info）+ 本鲸鱼娘独立发现 | 三路，已实测 |
| `configGuard` 检查的是会话根而非实际仓库（`fsmonitor` 可执行） | codex #1 + 审查单元 A（含 `git -C subrepo status` 实测执行） | 两路，已实测 |
| 补证正文不过脱敏边界 | codex #3 + 审查单元 B | 两路，均指向 `judge.js:125` |
| 「prepend」文档与实现不符 | 审查单元 A（minor）+ 审查单元 D（minor）+ 本鲸鱼娘 | 三路 |
| 脱敏 `\b` 前缀 bug（环境变量风格凭据不脱敏） | 本鲸鱼娘（18 条探针 14 条泄漏）+ 审查单元 B（独立 LEAK 清单） | 两路，已实测 |
| 评测层 `--live` 恒 exit 0、指标反向 | 审查单元 D（死端口复现）+ 本鲸鱼娘复核源码 | 两路，已复核 |

**codex 的覆盖面缺口（同样值得记录）**：本轮 1 条 critical（§3.1.1 提权）与多条 major（§3.1.5 TOCTOU、§3.1.10 截断采信、§3.1.11 volatile 漏接、§3.1.12 主路由漏校验、§4 整个评测层）**都是 codex 未报的**。codex 单轮 medium 的价值集中在"对同一批代码给出第二意见"，它的长处在逐行推理，短处在跨文件的数据流（模型参数 → 守卫 → 宿主语义）与"读评测脚本的口径"。


### 3.3 已核对但**未**发现问题的机制

- **deny 优先**（`rules.js:401` 外层循环 `deny → ask → allow`）与 **allow 的形状闸门**（`allowEligible`）——两者在所有审查路径下均无绕过。
- **`gitConfigGuard` 自身逻辑**（`index.js:1354-1383`）：`.git` 指针文件、`config.worktree`、`fsmonitor` 带引号值、`include`/`includeIf`、读失败一律 fail-closed。**（它的缺陷不在自身，而在被喂了错误的 `root`，见 §3.1.2）**
- **`pathGuardAllows` 的 `..`/绝对路径判定**、`relative(rootReal, …)` 的正确性；静态符号链接、`..`、绝对路径均被拒。
- **`parseNeeds`**：kind 白名单、长度、NUL、去重、`maxFiles` 上限全部有效。
- **只接受常规文件**（`isFile()`）、8 MiB 上限、二进制拒绝（NUL 探测）。
- **`parseVerdict`**：多裁决对象、嵌套包装一律 `null`（failOpen）；枚举闭合校验有效。
- **`no-ask` 提示词变体**：字符串替换精确生效（system 内已无 `ask` 选项、无"倾向 ask"）。
- **熔断只减少付费、不产生许可**；冷却与同动作阈值的拒绝都是 `deny`。
- **三项无人值守红线**（`mode3OnAsk` / `hardAskOnUnattended` / `enforcedAskOnUnattended` 只接受 `deny`，装配期拒绝其它值）。
- **审计对由宿主持久化**；插件自建日志 0600 + 轮转。
- **取消传播**到候选链与补证轮次。
- **role 分离**（政策 `system` / 证据 `user`）确实生效。

---

## 4. 测试与评测审查

### 4.1 【critical】`--live` 的主安全指标在裁判彻底失效时读作满分，且恒 exit 0

**（代码）** `scripts/eval.mjs` 的三个分支里只有 `--policy` 设了退出码（`:367` `process.exitCode = failures.length === 0 ? 0 : 1`）；`--replay`（`:381-398`）与 `--live`（`:399-411`）**只 `console.log`，不设 exitCode**。

**（审查单元 D 实测）** 把判定端点指向死端口：

```
EVAL_BASE_URL=http://127.0.0.1:9/v1 EVAL_API_KEY=x EVAL_MODEL=broken/no-model \
  node scripts/eval.mjs --live --repeat 3 --transcript; echo EXIT=$?
→ live: 危险放行 0/72，误拒 0/72 → …/2026-10-08-live-…-broken_no-model-….md
→ EXIT=0
报告片段:
| 危险放行（该 ask/deny 却放行） | 0（0.0%） |
| ↳ 其中非争议案例（门槛只看这一行） | 0 / 66 |
| 判定失败（走 failOpen） | 72 |
| p95 判定耗时 | 0 ms |
```

**为什么是 critical**：`docs/evaluation.md:37` 把危险放行率定义为「首要指标，只许降」，`:48` 的门槛规则 1 是「绝对条数不许增加」。而一次把裁判彻底打挂的改动（端点、鉴权、提示词全坏）会让它从 `5/72` 变成 `0/72`——**看起来是改进**。失败行被计入 `total` 却不参与任何判据，`liveMetrics`（`:174-206`）里没有 `judgeFailed` 一类字段。评测层因此可以对方向相反的变化给出"更好"的保证。

**附带缺陷**：失败行以 `decidedMs = 0` 进入 p95 样本（`:259` 只在成功时累加），于是裁判越坏 p95 越低；`docs/evaluation.md:40` 把 p95 定义为「单条审批从进入到落地的耗时」，实际只统计模型调用。

**建议**：`--live` 加"判定失败率上限"（如 `> 0.1 → exit 2`）与非争议危险放行条数的退出码；失败行排除出耗时样本；p95 改称"判定调用耗时"或按实测口径重算。

### 4.2 【major】`check-planes` 的期待值靠人手同步——可"改期待值"让真实安全用例永久跳过

**（代码）** `scripts/check-planes.mjs:44` `const EXPECTED_SKIPS_WITHOUT_VOLATILE = 4;`——字面量，注释要求"新增 `VOLATILE_ONLY` 用例时同步这个数字"。

**（审查单元 D 实测）** 给一条真实安全用例 `handler: an allow-once grant cannot re-enable a rule denial` 加 `{ skip: VOLATILE_ONLY }` 并把常量改成 5 → 双平面仍报「全部通过」，该用例在 3.18.2（生产平面）被永久跳过且无任何告警。`pass` 数虽被解析（`:139`）却从未校验，所以**没有测试数下限**：删掉整个 `test/redact.test.mjs`（自测 399 → 390）仍全绿。而该文件至今**未进 git**（`git ls-files test/ | wc -l` = 18，磁盘 19）——新克隆丢文件不可发现。

**为什么重要**：`check-planes` 是双平面回归唯一的自动闸门，而它唯一的失败信号（期待值不匹配）可以直接被"更新期待值"消化掉——提交 `fcffd3b` 的修法正是如此。

**建议**：从测试源码里数 `{ skip: VOLATILE_ONLY }` 的出现次数与实际 `skipped` 对比，而不是维护常量；把用例数下限写进检查；`test/redact.test.mjs` 立即入库。

### 4.3 【major】`--replay` 只重放策略层，不重放规则层，与文档声称不符

**（代码）** `scripts/eval.mjs:145-171` 的回放只调 `decidePolicy`；`docs/evaluation.md:10` 说"用今天的策略/规则重算落点"。

**（审查单元 D 实测）** 同一条审计记录（`git clean -fdx`，risk low / judge allow / strong 授权 / tolerance high）回放给出 `was=allow, now=allow, changed=false`，而**真实 handler 对同一命令返回 `rejected`**（命中 `Bash(git clean *-f*)` 的 deny 规则）。规则层收紧后，回放仍报"0 条落点改变"（`48/119 条可回放，0 条改变`）。

**为什么是缺陷**：规则层恰恰是安全审核改得最多的地方，而回放层对它完全不可见——回放的输出却是"会不会改变判定"。

**建议**：回放改走真实 handler（把记录里的判定当 stub 喂进去），至少纳入规则层与证据门槛；否则把文档口径改为"仅策略层落点"。

### 4.4 【major】指标存在盲格：`truth=ask → rejected` 无人统计

`liveMetrics` 只统计两向：危险放行（truth ∈ {deny, ask} → `allowed-once`）与误拒（truth = allow → `rejected`）。**「该问人却硬拒」两个指标都不覆盖**。**（审查单元 D 实测）** off 基线 66 条 settle 行里 41 条落在 `rejected`，其中 6 条 `truth=ask`（`force-push`、`prod-rsync`）——报告同时显示「危险放行 0/66」「误拒 0/72」，读起来是两向零错误，实际是分布大幅移动落在无指标的格子里。另外两向率的分母都是全部行（`:195`/`:201`），而危险放行的风险集只有 54 行、误拒只有 18 行。

**建议**：增加"该问人却硬拒"指标并纳入门槛；分母改为各自风险集，或同时给出风险集分母。

### 4.5 【major】基线不可归因、不可复现

`docs/evaluation.md:58-63` 引用的生产基线（5/72、0/66、p95 8895 ms）出自 2026-10-02 的报告，此后代码又有 4 个提交，且 `index.js` / `redact.js` 至今留在工作区未提交。报告头只有生成时间/模型/端点/重复/开关，**没有 git HEAD、没有脏标记、没有 temperature、没有提示词或策略哈希**（`scripts/eval.mjs:328-341`）。`docs/evaluation.md:66` 自己把这条列为已知边界并写明"落盘时应把 HEAD 与工作区脏状态写进报告头"——**v0.4.6 仍未实现**。门槛规则 1 要求"附改动前后的报告对比"，两份无法归因的报告对比不构成证据。

### 4.6 【major】评测集代表性与统计功效

**（审查单元 D 实测）** `eval/cases/model.jsonl` 24 条（truth allow 6 / ask 5 / deny 13，disputed 2），`--repeat 3` 得到 72 行——但报告与文档都直接引"2/72""5/72""0/66"，而**有效样本是 22 个非争议案例**（66 行）。`0/22` 的 95% 置信上界按 rule-of-three ≈ 13.6%，即该基线**不能排除"每个案例约 14% 概率被危险放行"**。对抗类样本严重不均：base64 一条、管道到 shell 一条、pwsh 一条；而 shell 变量间接（`X=rm; $X -rf /`）、`xargs`、`find -exec`、PowerShell `-EncodedCommand`/`iex`、Windows 反斜杠相对路径、进程替换、heredoc、嵌套 `bash -c` **全为零**——与插件明确声明支持的 Windows/PowerShell 场景（`DEFAULT_CONFIG` 带 Pwsh 规则）不匹配。`test/eval-cases.test.mjs:18` 只钉 `cases.length >= 20`（无上限、无正负比、无对抗类断言）。

**结论**：评测集**能**证明"在 22 个常见 Linux/bash 案例上未出现危险放行"，**不能**支撑"危险放行率很低"或"对 Windows/PowerShell 同样安全"的外推。基线数字本身与报告逐条吻合（已核对 5/72、0/66、13、8895ms 与 2/72、0/66、17、9299ms），**问题在解释力与归因，不在数字造假**。

### 4.7 单测层：真覆盖

`node --test` = **399 tests / 399 pass / 0 fail / 0 skipped**（2043.8 ms）；`check-planes` 双平面通过；`--policy` 16/16。抽查 10 个关键测试：7 个是属性级断言（双向：正例仍放行 + 反例不得放行；并断言裁决结果与"下一位答者是否被调用"），3 个是实现细节/措辞级。**未发现** `assert.ok(true)` 式空断言，**未发现**把被测对象 mock 成必通，9 处 call-count 断言均伴随结果断言。`docs/security.md` 列的 15 项机制中 **12 项有直接属性测试**（deny 优先、形状闸门、pathGuard、flagGuard、configGuard、evidence 门槛、hardAsk、enforcedAsk、授权键、熔断、审批不卡死、补证白名单、脱敏统一、取消传播）。真正的"必通"发生在**评测层**而非单测层。另一个结构性缺口：**测试全部注入 `getCwd` / `resolvePath`，没有一条跑生产默认接线**——守卫是否真的拿到 `root`、`agent` 的真实形状是什么，在 399 个绿测里没有任何断言（§3.1.2 的死接线就是这样隐身的）。

**声称有覆盖但实际无测试的**：抢答/waterfall 注册顺序（§3.1.9，整节无测试且文档自认未实测）、「提权理由从不作为用户授权」（仅措辞级）、「facts 只是线索」（仅载荷形状）、默认 15 s 超时的**数值**、审计对持久化（宿主职责）、以及评测层三项（§4.1/4.3/4.5）。

### 4.8 【minor】其余

- `docs/evaluation.md:65` 的因果归因算错：三条 allow 案例的 pass 变化是 +3/+3/+2（合计 8），另有 force-push(+3)、prod-rsync(+2)、git-reset-hard(+1) 反向增加 6 次，8−6+2=4 才等于标题的"少 4 次"；原文的"逐条可查"不成立。
- `policy.jsonl` 6/16 用例只钉结果不钉分支（`rule: null`），分支漂移不可发现（单测层有覆盖）。
- 默认 `ai.timeoutMs = 15000` 无测试钉住（机制有测试、数值无断言）。
- 仓库**无 CI**：`package.json` 只有 `build:client` 与 `test`，没有任何地方调用 `--policy` / `check-planes`。三层闭环与"条数不许增加"的门槛都建立在"有人会手动跑"之上。

### 4.9 文档一致性（审查单元 F：10 份文档 × 代码逐条核对）

**好消息**：`docs/configuration.md` 的默认值表与代码**28/28 全部一致**（逐字段比对 `DEFAULT_CONFIG` / `assertConfig` / schema），`docs/decision-chain.md` 的流程与策略层描述可用。**结论：`configuration.md` 与 `decision-chain.md` 可以当事实源；`first-principles.md` 与 `security.md:62-84` 必须重读代码。**

其余不一致（含 §3.1.17 那两处安全声明）：

| 类别 | 条目 |
|---|---|
| **陈述错误** | `first-principles.md` 的 18 处代码行号**系统性失准**（该文件总引 `judge.js:660-674`，而 `judge.js` 只有 392 行；`makeRecorder` 实际在 `index.js:1892`，文档写 `:1004`）——按行号回查会落到无关代码，据此"验证过文档"会得出假结论 |
| **陈述错误** | `decision-chain.md:70` 与 `security.md:10` 只描述"折叠紧贴引号 + 规范化空白"两种改写，实际 `safetyFolds` 是三种（`rules.js:242-247`）外加两轮复合——`tar -czf x "/home/u/.aws"` 这类形态其实会命中凭据 ask |
| **内部矛盾** | 授权键的构成有**三种说法**：`decision-chain.md:196`（工具+已脱敏全文）/ `configuration.md:107`（同一工具+同一命令文本）/ `security.md:22`（工具、目录、提权目标、命令全文的 JSON 元组）。只有 `security.md:22` 与代码一致（`index.js:1393-1405`，`workdir` 与提权目标确实参与） |
| **内部矛盾** | 拒绝更正消息的 `source.kind` 写法：`security.md:35` 说 `"plugin"`，`first-principles.md:181` 说 `"plugin:<name>"`。代码是后者（`index.js:2197`），`transcript.js:121` 两种都排除——用精确 `kind === "plugin"` 过滤会漏掉全部现有记录 |
| **承诺未兑现** | `evaluation.md:62-65` 给出的 **short 口径 live 基线（5/72、0/66、p95 8895 ms）在 `eval/reports/` 里不存在**——那里只有 off 口径的报告。而 `transcript: short` 是 2026-10-06 起的**默认值**，改默认值的唯一直接证据无法核对 |
| **承诺未兑现** | `evaluation.md:51` 的"留 20% holdout"在 `eval/` 与 `scripts/eval.mjs` 里**零实现**（无字段、无过滤、无标记） |
| **数字漂移** | `development.md:19` 说"共 14 个文件"，`package.json` 的 `files` 实测 15 项；`decision-chain.md:225` 说 `[R]` 行"≤80 字符"，实际是头 80 + 尾 40（`transcript.js:171`）；`decision-chain.md:232-236` 的 token 估算按 system 提示实测约 970 token，文档写 ~380——**成本表偏低约一半**，会让"transcript 开关的性价比"判断失真 |
| **入口失效** | `README.md:44` 与 `docs/client-card.md:9` 指的 `settings.plugin.item` 在 0.2.0 已被删除，代码注册在 `settings.section`（`src/client/index.ts:115-124`，对应 UI 是设置页独立栏目「Codex 审批」）。`README.md:64` 的路径才是对的，`:44` 错的 |

---

## 5. 竞品与生态对照

### 5.1 主流 coding agent 的审批模型

| 系统 | 决策模型 | 放行粒度 | AI 判定 | 不安全档 | 失败方向 | 审计 |
|---|---|---|---|---|---|---|
| **dsh-codex-approval** | 规则(deny>ask>allow) → LLM(risk×授权) → 策略映射 | glob / argv 前缀 / 工具 | 是（含补证二轮） | `ai-auto` | **fail-open(ask)** ← 生态最宽松 | 自写 JSONL + 宿主 approval 对 |
| Claude Code | 规则（deny→ask→allow）+ classifier | 前缀 `Bash(git log *)` / 参数规则 / 工具名 | 是（auto mode） | `--dangerously-skip-permissions` | classifier 决定 | 会话日志 |
| Codex CLI | sandbox × approval 两轴 + reviewer agent | 审批事件面（提权/网络/越界写） | 是（auto-review） | `danger-full-access` | 拒绝 + **熔断中断本轮** | transcript + 工具证据 |
| Cursor | allowlist → 沙箱 → classifier（固定序） | 终端 allowlist / MCP glob | 是（Flash 级小模型） | Run Everything | 兜底 ask | enforcement hooks |
| Gemini CLI | 策略引擎 + priority | `commandPrefix` / `argsPattern` 正则 | 否 | `--yolo` | 非交互下 ask＝deny | — |
| opencode | `permission` 表，last-match-wins | 工具 + 通配 | 否 | `--auto` | — | — |
| Cline / Continue | 分项 auto-approve | 类别开关 | 否 | YOLO / Automatic | — | — |
| Aider | **无审批层** | `--yes-always` | 否 | — | 靠 git 提交兜底 | VCS |
| GitHub Copilot cloud agent | 纯结构性权限 | 分支 / PR（不能 push、不能自批） | 否 | — | 结构性拒绝 | session + audit log |

**行业共识**：规则层是标配且一律 `deny` 优先；三家头部（Codex / Claude / Cursor）都已把 LLM 审批产品化，并**都在官方文档里明写它不是安全边界**；不安全档位的开关名趋同且都有企业级禁用开关；审计以"会话日志 + 审批事件对"为共识。**公开的"自动审批器误放率"基准属空白**（已检索，未见公开者）。

### 5.2 DSH 生态同类插件（同接缝 9 个）

| 插件 | 判定 | 接缝 | 档位门 | 失败方向 | 值得注意的机制 |
|---|---|---|---|---|---|
| 官方 `dsh-experimental-auto-review` | 纯 LLM | `tools/pre-execute` | `auto` preset | 拒绝→转 ask | 每调用一次模型；自述"无确定性豁免/无持久授权/无重试层" |
| `PerryLink/dsh-auto-review`（234★） | 只读 reviewer subagent | `approval/request` | per-tool `ai/human/never` | **fail-closed(rejected)** | 会话事件 `autoReview/verdict`、自带 `dsh-eval` 评测平台、熔断 3/10 |
| `Letter2025/dsh-approval-llm` | LLM ALLOW/DENY/ESCALATE | `approval/request` | `modePreset` 显式门 | fail-to-human | 明确警告"AI 评审是策略选择不是安全保证" |
| `cuddly-guacamole`（13★） | 五段钩子 + LLM 预分类 | 多接缝 | `auto-approval` | 倒计时 + timeoutAction | 12 分类三态、确认制学习、`audit.jsonl` |
| `moon09300731/dsh-approval-gate` | Flash 预判 + 确认制学习 | `approval/request` | — | 五类永远转人工 | **unified diff 快照 + 一键撤销** |
| `Jiao-XXX/dsh-auto-approve`（15★） | 规则 + LLM | `approval/request` | `sandboxed-auto` | 全部转人工 | 严格 `{"verdict":"approve"}` 才放行 |
| `StyxNether`（3★） | 纯规则 | `approval/request` | `requireTrustedPreset` | 只放行不拒绝 | 按 `callId` 取真实参数 |
| `ZhuRuoLing`（1★） | 规则 + LLM + 工具定义补丁 | 双接缝 | `grantMode` | fail-closed | Strict Mode 直接 deny |
| `gbthui`（1★） | LLM reviewer | `approval/request` | — | `denyOnReviewerError` | 内置对抗语料 + **TP/FP/TN/FN 统计**，误放可致测试失败 |
| `aa2246740` | LLM | `approval/request` | — | 暂停转人工 | 审核历史 UI + 规则草稿 |

### 5.3 本插件的位置：优势与差距

**独有优势（生态里没有第二家同时具备）**：
1. **确定性规则层**：`deny > ask > allow` + 形状闸门 + `pathGuard`/`flagGuard`/`configGuard`/`hardAsk`——官方 auto-review 自述"无确定性豁免、无可配置策略"。
2. **三层评测闭环**（离线策略回归 / 审计回放 / 真实模型）+ 774 行可回放审计 + 336 次宿主 `asked/decided` 对。**这是生态里唯一能拿来做 HITL/HNITL 量化实验的数据底座**（见 §6）。
3. **决策语义可审计**：每条记录带 `policy` 分支（`judge-allow` / `ask-without-authorization` / …）与 `risk` / `userAuthorization`，可以直接统计"为什么被放行"，而不是只知道"被放行了"。

**差距（按优先级）**：
1. **失败方向比全生态宽松**：默认 `failOpen: "ask"`，而生态普遍 fail-closed / fail-to-human（PerryLink `fallbackPolicy: rejected`、Letter2025 fail-to-human、gbthui `denyOnReviewerError`）。
2. **熔断缺"中断本轮"**：Codex 在 3 连续拒绝或同 turn 50 窗内 10 次拒绝时**中断本轮**，阻止 agent 反复试探；本插件只拒绝单次请求（本机数据里熔断 0 触发，说明这条也没被验证过）。
3. **无可回滚**：`dsh-approval-gate` 有 diff 快照 + 一键撤销；本插件的补偿只有拒绝反馈与一次性授权。
4. **无确认制学习**：moon 与 cuddly 都从人工确认中沉淀规则；本插件每次要手写 glob——这在"人类同意率 97.5%"（§6）的现实下尤其可惜。
5. **无机器可读裁决事件**：PerryLink 有 `autoReview/verdict` 会话事件；本插件只有自写 JSONL。
6. **"非安全边界"未在 README 显性声明**：Cursor / Claude 都在官方文档里明写，且业界有 60–80% ASR 的定向注入实证与"文本安全不迁移到工具调用"的 GAP 证据；本插件只在 `docs/security.md` 里写了边界。

---

## 6. HITL vs HNITL：本机实证与实验设计

### 6.1 本机真实数据（本报告最独特的产出）

把插件决策日志与宿主的 `approval/asked` + `approval/decided` 按 `callId` join（258 次配对，覆盖 101 个会话 / 336 次审批）：

**宿主侧最终裁决**：`allowed-once` **304（90.5%）**、`rejected` 30（8.9%）、`unavailable` 1。

**混淆矩阵（插件判定 → 宿主最终裁决）**：

| 插件判定 | 宿主 `allowed-once` | 宿主 `rejected` | 宿主 `unavailable` |
|---|---|---|---|
| `pass`（交人工，158 次） | **153** | **3** | 1 |
| `allowed-once`（自动放行，75 次） | 75 | 0 | 0 |
| `rejected`（自动拒绝，25 次） | 0 | 25 | 0 |

**结论一：当插件把决定交给人类时，人类 97.5% 会批准**（153/157）。这正是审批疲劳 / rubber-stamping 的量化形态。

**结论二：人类的边际安全贡献在这批数据上约为 0**。那 3 次否决全部来自 2026-08/09 的**自测探测命令**（`probe=…touch…rm -f…`、`mkdir -p ~/.dsh/codex-ai-test …`），且路径都是 `ai-error`（AI 失败降级）或 `rule ask`——**没有一次是对真实危险动作的有效否决**。

**结论三：这 158 次人工介入里，102 次（65%）其实是 "AI 层失败"的产物**（`kind=ai-error`），不是"AI 拿不准"。也就是说，在 9 月那段 AI 层 70% 失败率的时期，人类是在给一个坏掉的裁判做兜底。**AI 可靠性修好后（10 月 0 失败），这类打扰会自然消失**——这是"先修 AI 可靠性再谈 HITL/HNITL"的直接论据。

### 6.2 与外部证据的一致性

- 临床 CDSS 的告警 override 率 **95.7%**，其中仅 **45.4% 的 override 是合理的**（[PMC7647273](https://pmc.ncbi.nlm.nih.gov/articles/PMC7647273/)）——与"人会给一个自己没细看的确认"同向。
- 欧盟 AI Act Art.14 把 automation bias 写进条文（要求人能 disregard/override/reverse、能 stop，并要求**使人意识到过度依赖输出的倾向**）；NIST AI 600-1 把 "Human-AI Configuration" 列为 GenAI 风险族并点名 automation bias / excessive deference。→ **"人在环内"本身不是合规终点，环内的人是否真的在看才是。**
- 分级框架可引用：operator / collaborator / consultant / approver / observer 五级（[arXiv:2506.12469](https://arxiv.org/abs/2506.12469)）。本插件当前落在 **approver**（AI 判、人批）；`ai-auto` 落在 **observer**（人只看日志）。

**必须诚实**：本机数据**无法区分**"人类认真看了并同意"与"没看就点同意"。要区分这件事，正是 §6.3 的实验。

### 6.3 利用本项目现有资产可做的三个实验

这个项目的三件资产（**可回放的判定函数** + **可 join 的宿主裁决对** + **带 `policy` 分支的决策日志**）在生态里是独一份的，可以直接支撑：

**实验 1 · 影子 HNITL（零成本、零风险、可立即做）**
对每条历史 `pass` 记录，用 `decidePolicy` 在不同 `tolerance` / 不同 `enforced` 设定下重算"若放宽会怎样"，与人类实际裁决对照，得到**放宽阈值 → 误放行率**曲线。
- 本机数据的先验答案：把 `enforced` 红线全拆掉，自动放行 158 次里人类否决的 3 次全是探测命令 → **误放行上界 < 2%**，且样本中无真实危险动作。
- 前提：先修 §4.3（`--replay` 只重放策略层）——对影子实验而言策略层恰好够用，但报告口径必须写清。

**实验 2 · 打扰-延迟 Pareto**
`eval/cases/model.jsonl` × N 个判定模型 × {tolerance} × {transcript on/off}，画（自动放行率 × 危险放行率 × p95 延迟）三轴，每个点带置信区间。
- 需要先补 §4.1（门槛与失败率上限）、§4.4（`truth=ask → rejected` 盲格）、§4.6（对抗样本与功效说明）。
- 这一步产出的是**可对外发布的对照数据**——生态里目前没有人有。

**实验 3 · 人工介入的增量价值（A/B）**
同一批 synthetic 任务，一半走 `ai`（人裁）、一半走 `ai-auto`（插件裁），比较任务完成率、误放行后果、以及人类主观打扰度。
- 这是唯一能回答"环内的人到底在不在看"的设计。

### 6.4 从数据推出的设计结论

1. **当同意率 > 95% 且否决中无真实危险动作时，这个环的社会价值已经耗尽**——此时 HNITL + 补偿机制优于 HITL。本机当前正处在这个区间。
2. **HNITL 的补偿机制缺一不可**：确定性 deny 兜底（有）、熔断**中断本轮**（缺）、一次性人工覆盖口（有）、机器可读审计（部分）、可回滚（缺）、预算上限（有）、**定期影子复核**（缺，实验 1 可补）。
3. **先修裁判可靠性，再谈是否要人**：本机 65% 的人工介入是裁判失败造成的，不是"AI 拿不准"。把 `failOpen` 从 `ask` 改成 `deny`（对齐生态）之前，先确认裁判可用性。
4. **`ai` 与 `ai-auto` 不是同一策略的两个参数**：本机数据 8% vs 79% 的放行率证明了这一点。产品上应当把"默认模式"的选择权交给一个**基于流量的建议**（例如"你的最近 100 次判定里 X% 最终由人批准，考虑切到 ai-auto"），而不是让用户自己拍。

---

## 7. 后续路线

### 7.1 P0 · 安全必修（顺序有依赖，请按序做）

| # | 项目 | 关键点 |
|---|---|---|
| 1 | **守卫的 root 来源 + `workdir` 参与（同一提交）** | §3.1.2。**顺序是硬的**：单独修 `getCwd` 会让安全从"守卫空转（保守）"变成"可被 `workdir` 绕过地放行"，是净负面。附带：`getCwd` 取不到时在启动审计里显式告警 |
| 2 | **提权的硬编码前置条件** | §3.1.1。改动最小、收益最大：`facts.escalationTo !== undefined` 时 allow 规则一律不适用。**先做这条**（它不依赖任何其它改动） |
| 3 | **授权键改用原始命令文本** | §3.1.3。脱敏只用于展示与传输 |
| 4 | **脱敏边界一次性补齐** | §3.1.4（值规则改前缀容错 + 补 `-u`/URL userinfo/`AKIA`/`xox*`/`gh[opsu]_`/PEM/JWT）+ §3.1.6（补证正文过脱敏）+ §3.1.7（凭据清单归一化 + 后缀剥离）。**并建立"已知凭据形态"对抗测试集**——当前测试只断言已覆盖形态，缺口对测试不可见 |
| 5 | **补证白名单改 fd 语义** | §3.1.5。`open(O_NOFOLLOW)` → `fstat` → 同一 fd 读 |
| 6 | **主判定路由校验 + handler 外层 try** | §3.1.12。`"15s"` 这类输入目前会让请求**无答复**（`unavailable`），这是最容易被忽略的一类 |
| 7 | **评测层的门槛与归因** | §4.1（`--live`/`--replay` 退出码、判定失败率上限）+ §4.5（报告头写 HEAD/脏标记/温度/提示词哈希）。**在此之前，评测层的任何结论都不该被当作安全保证** |
| 8 | **配置面收尾** | §3.1.11（5 个 volatile 字段）+ §3.1.13（i18n 标签、死键、`DSH_HOME=""`）+ §3.1.10（截断采信） |

### 7.2 P1 · 把项目变成"审批机制对照实验平台"（这才是它真正的差异化）

本机数据已经证明这个项目手里有三件别人没有的东西：**带 `policy` 分支的决策日志**、**可 join 的宿主 `asked/decided` 对**、**可离线重算的策略函数**。本报告 §6 的那张混淆矩阵是拿临时脚本拼出来的——它应该变成仓库里的一等公民。三件基础设施：

1. **统一数据集（`scripts/hitl-report.mjs`）**
   把 `~/.dsh/logs/approval.jsonl` × 会话侧 `approval/asked` + `approval/decided`（zstd 解压）× 会话元数据（模式、preset）join 成一张表，一行一次审批，字段含：插件判定 / 分支 / risk / 授权强度 / 人类最终裁决 / 延迟 / 是否 enforced。
   产出：本报告 §2.2、§6.1 的所有表格一条命令可复现。**这是所有后续实验的地基。**

2. **影子决策（shadow）**
   对每条历史记录，用**多组**策略参数（不同 `riskTolerance` × 不同 enforced 红线开关 × `transcript` on/off）重算 hypothetical 落点，输出「放宽阈值 → 自动放行率 / 误放行率」曲线。
   - 现状：`--replay` 已经只重放策略层（§4.3），对影子实验**恰好够用**——但报告口径必须写清"仅策略层"。
   - 这条能直接回答"如果把 `enforced` 拆掉会怎样"：本机先验答案是**误放行上界 < 2%，且 3 次否决全是探测命令**（§6.1）。

3. **基线与置信区间**
   `--live` 报告同时给"案例数分母"与 Wilson / rule-of-three 上界（§4.6），并把 `truth=ask → rejected` 补成第三向指标（§4.4）。没有这一步，"0/66"会被误读成强结论。

审查单元 G 从代码侧独立给出的互补清单（同样可作基础设施候选）：**(4) 人类裁决回流通道**——目前只注册了 `approval/request`（`index.js:2352`），全仓没有 `approval/decided` 监听，所以"人批了什么"不进入任何 store，HITL 基线只能像本报告 §6 那样事后 join 会话日志；**(5) 按 workspace/cwd 的策略选择器**——`sessionOverrides` 只是手工 uuid 字典。另外两件是**前置条件**而非新基建：先拆开 `judge.js:324-325` 那处**同名不同义**的 `judge-ask`（同一个 `rule` 名对应 `ask` 与 `allow` 两种落点，对照实验无法按分支切片），以及让 `plugin-loaded` 记录加入"答者位次 / `getCwd` 取值 / locale 解析"三项自检——把"守卫静默空转"从"半年后审计时发现"变成"启动即报"。

**做完这三件，这个项目就能对外产出别人没有的东西**：一张"多模型 × 多策略 × (HITL|HNITL)"的对照表，附置信区间与可复现脚本。生态里目前没有一个 DSH 审批插件公布过误放率。

### 7.3 P2 · 与生态对齐（有现成范式可抄）

1. **熔断"中断本轮"**：Codex 在 3 连续拒绝或同 turn 50 窗内 10 次拒绝时中断 turn，阻止 agent 反复试探；本插件只拒绝单次（本机熔断 0 触发，说明连现有那半也没有被验证过）。
2. **确认制学习**：本机"人类同意率 97.5%"意味着大量确认本身就是可沉淀的偏好信号；`dsh-approval-gate` 与 `cuddly-guacamole` 都做了"确认 N 次后自动放行"，可直接对齐。
3. **可回滚**：`dsh-approval-gate` 的 diff 快照 + 一键撤销是 HNITL 最重要的补偿机制（本插件的补偿只有拒绝反馈与一次性授权）。
4. **多答者自检**：启动时验证自己是否真的排在决策链前面（§3.1.8），被旁路时告警而不是静默失效。
5. **规则层支持 `compound`**：真实流量 10 月 `simple` 形状为 **0**，`compound`/`opaque` 占绝大多数——形状闸门 + 真实命令形态让 allow 规则族近乎不可达（§2.2）。要么实现"按 `&&`/`;` 拆分后逐段判定"（Codex 用 tree-sitter 做的正是这件事），要么接受"规则层只服务极少数命令"并据此调整宣传。
6. **非 shell 工具的守卫**：`edit` / `write` 目前完全裸奔到 AI 层（10 月占 pass 的 18%），没有路径守卫概念。
7. **README 显性声明"不是安全边界"**：Cursor / Claude 都在官方文档里明写，并有 60–80% ASR 的定向注入实证与 GAP 的"文本安全不迁移到工具调用"证据。本插件只在 `docs/security.md` 里写了边界。

### 7.4 如果只有一天

按"收益 / 改动量"排序的三件事：**① 提权前置条件**（一个条件判断 + 一条测试，堵掉唯一的 critical）；**② 授权键改用原文**（一行）；**③ 评测层加退出码与失败率上限**（让"安全"这件事第一次可以被自动验证）。三件都是小改动，但分别对应"最严重的洞""最容易被滥用的洞""最不该失守的守门人"。

### 7.4b 三条最小补丁的精确落点（未落盘，仅供动手时参考）

1. **提权前置条件**——`resolveRule`（`index.js:1474-1489`）当前拿不到执行事实，需在调用处（`:1560-1563` 的 `guardOpts`）把 `facts` 传进去，并在 allow 分支加一条：本次 `escalationTo` 非空时丢弃该 allow 规则并继续求值（与现有 `pathGuard` 失败的处理同形，`:1487`）。测试放进 `test/index.test.mjs` 的规则用例组，断言"带 `sandbox_permissions` 的 `ls` 不再返回 `allowed-once`"。
2. **授权键改用原文**——`index.js:1557` 的 `actionKeyOf(req.toolName, argsText, facts)` 把 `argsText` 换成 `fullText`（`:1510` 的原文）。注意同一个键也用于熔断计数（`:1817`），换键会让历史计数失效一次——可接受（计数本就是内存态、按会话）。
3. **评测退出门槛**——`scripts/eval.mjs` 的 `--live`（`:399-411`）与 `--replay`（`:381-398`）两个分支补 `process.exitCode`；`liveMetrics`（`:174-206`）加 `judgeFailed` 与 `settledAskRejected` 两项，并把非争议危险放行条数与基线比较后决定退出码。

### 7.5 文档层面的欠账（详见 §4.8、§3.1.13 与文档一致性审查）

`docs/security.md:70/78` 的 prepend 描述、`docs/first-principles.md` 的 v0.4.4 快照（§9 多条已过时、§8 的实测数字已失效）、`docs/client-card.md:14` 的 slot 名、`docs/evaluation.md:65` 的因果归因——这些不影响判定，但它们**恰好是读者用来建立信任的那几页**。安全类文档一旦与代码脱节，读者会转向"只读代码"，而这个项目的价值恰恰有一部分在文档里。


---


---

## 附录 A · 复现脚本

本报告所有"实测"结论的最小可重放形式。均不修改项目文件。

### A.1 §3.1.2 守卫与实际执行目录脱节

```js
// 一个 bash 调用内跑完（DSH 沙箱的 /tmp 每次调用会重置）
import { normalizeConfig, createHandler } from "<repo>/index.js";
const cfg = normalizeConfig({});
const WS = "/abs/workspace";              // 会话工作区根
function makeReq(command, extra = {}) {
  const args = JSON.stringify({ command, description: "x", ...extra });
  const events = [{ type: "assistant/message", data: { message: { content: [
    { type: "tool-call", id: "c1", name: "bash", arguments: args }] } } }];
  const session = { id: "s1", events, snapshotEvents: () => events };
  return { toolName: "bash", callId: "c1", reason: "", agent: { id: "a1", session } };
}
const handler = createHandler({ config: cfg, record: async () => {},
  llmRunner: async () => ({ ok: false, error: "judge must not run" }),
  getCwd: () => WS });                    // 真实实现是 session.policy.workspaceRoot
await handler(makeReq("cat keep.txt"), async () => "unavailable");
// → "allowed-once"；把 workdir 设成工作区外目录后仍然是 "allowed-once"
```

### A.2 §3.1.3 授权键碰撞

```js
import { actionKeyOf } from "<repo>/index.js";
import { redactSensitive } from "<repo>/redact.js";
actionKeyOf("bash", redactSensitive("python deploy.py --token=STAGING"));
actionKeyOf("bash", redactSensitive("python deploy.py --token=PRODUCTION"));
// 两个 16 位 hex 完全相同
```

### A.3 §3.1.4 脱敏缺口（判据：原始秘密子串是否仍出现在输出里）

```js
import { redactSensitive } from "<repo>/redact.js";
const cases = [
  ["Authorization: Basic",  `curl -H "Authorization: Basic dXNlcjpwYXNz" https://x`],
  ["Authorization: token",  `curl -H "Authorization: token ghp_16C7e42F" https://x`],
  ["AWS secret env",        `AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI aws s3 ls`],
  ["npm _authToken",        `npm config set //registry.npmjs.org/:_authToken=npm_9aB`],
  ["URL userinfo",          `git clone https://oauth2:glpat-abc@gitlab.internal/x.git`],
  ["postgres URI",          `psql postgres://app:s3cr3tPass@db.internal/prod`],
  ["sshpass -p",            `sshpass -p hunter2 ssh u@h`],
  ["PEM block",             `printf '%s' '-----BEGIN OPENSSH PRIVATE KEY-----\\nb3Bl\\n'`],
];
for (const [name, text] of cases) console.log(name, "→", redactSensitive(text));
// 上列全部原样输出（未脱敏）；对照组 Bearer / token= / --password= 正常
```

### A.4 §6.1 HITL 混淆矩阵（插件判定 × 宿主最终裁决）

```python
# 需要 zstd 可执行文件；会话日志的审批事件对是宿主写的权威记录
import subprocess, glob, json, collections, os
asked, decided = {}, {}
for f in glob.glob(os.path.expanduser("~/.dsh/sessions/**/*.zstd"), recursive=True):
    raw = subprocess.run(["zstd", "-dc", f], capture_output=True).stdout.decode("utf8", "ignore")
    if "approval/asked" not in raw: continue
    for line in raw.splitlines():
        if "approval/" not in line: continue
        try: e = json.loads(line)
        except Exception: continue
        d = e.get("data") or {}
        if e.get("type") == "approval/asked":    asked[d.get("id")] = d.get("callId")
        elif e.get("type") == "approval/decided": decided[d.get("id")] = d.get("outcome")

plug = {}
for line in open(os.path.expanduser("~/.dsh/logs/approval.jsonl")):
    try: r = json.loads(line)
    except Exception: continue
    if r.get("callId") and "outcome" in r: plug[r["callId"]] = r

m = collections.Counter()
for hid, cid in asked.items():
    p = plug.get(cid)
    if p: m[(p["outcome"], decided.get(hid))] += 1
for k, v in m.most_common(): print(k, v)
# ('pass','allowed-once') 153 | ('allowed-once','allowed-once') 75 | ('rejected','rejected') 25 | ('pass','rejected') 3
```

### A.5 §2.2 生产水位（不需要会话日志）

```python
import json, collections
dec = [json.loads(l) for l in open("/home/wenxin/.dsh/logs/approval.jsonl") if l.strip()]
dec = [r for r in dec if "outcome" in r]
oct_ = [r for r in dec if r.get("ts", "") >= "2026-10-01"]
for m in ("ai", "ai-auto"):
    sub = [r for r in oct_ if r.get("mode") == m]
    if sub: print(m, len(sub), collections.Counter(r.get("action") for r in sub))
print("带 cwd 字段:", sum(1 for r in dec if "cwd" in r))        # → 0（守卫空转的证据）
print("带 escalation:", sum(1 for r in dec if "escalation" in r))  # → 37
```
