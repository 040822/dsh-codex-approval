# 决策链与规则语法

本文是 `approval/request` 应答者的完整决策语义：请求经过哪几道闸门、规则怎么匹配、AI 审判拿到什么输入、候选链如何推进。

## 决策流程

```
approval/request 到达（toolName + callId + reason）
├─ 1. 参数反查：按 callId 从会话日志恢复**完整**命令（bash/pwsh 取原始 command；不截断），
│      同时取出审批接缝不给的执行事实：workdir（本条命令的实际执行目录）、
│      sandbox_permissions + justification（本次请求的提权目标与理由）
├─ 2. 形状判定（shell-shape.js，bash/pwsh）：simple（单条纯命令）/ compound（安全分隔符串联）/ opaque（重定向、替换、变量、通配、控制流…）
│     只有 simple 才可能被 allow 规则放行；compound/opaque 一律交规则 ask/deny → AI/人类
├─ 3. 证据门槛：参数缺失或命令超 ai.maxJudgeCommandChars → 标记 evidence-incomplete，**不问 AI**
│      ai → 交人类；ai-auto → 拒绝（mode3OnAsk=allow 也不能放行）
├─ 4. 规则层（deny > ask > allow，命中即定，0ms）
│     deny → 直接拒绝（AI 无权覆盖）│ allow → 静默放行 │ ask → 交人类
│     标了 hardAsk 的 ask 是**红条**（发布、凭据）：ai-auto 下不走 mode3OnAsk，
│     改由 ai.hardAskOnUnattended 决定（默认 deny）
├─ 4b. 会话级闸门（仅在规则未命中、且证据完整时求值）
│     一次性人工授权（/approval-allow-once）命中 → 直接放行一次（规则 deny 不可能到此）
│     否则熔断冷却中 → 直接拒绝（breaker: cooldown）│ 同动作被拒达阈 → 拒绝（breaker: duplicate-action）
├─ 5. AI 审判层（规则未命中且未被闸门拦截时）
│     LLM 裁决 {risk, authorization, user_authorization, evidence, unknowns, reason}
│     ——要求**单个**合法 JSON 对象，多裁决视为非法
│     判定要求补证（needs）→ 插件按白名单只读抓取（默认最多 2 个文件）→ 带证据再审一次
│     策略层 decidePolicy 把裁决映射成 allow / ask / deny（见下「策略层」）
│     全部候选 + 补证轮次共享 ai.totalBudgetMs（默认 30s），耗尽即按 failOpen 落地
│     主模型失败或未给出可解析判定 → 依次尝试 ai.fallbacks
│     全部候选失败/超时/输出非法 → failOpen（默认 ask → 人类）
└─ 6. 兜底：fallback（默认 ask → GUI 弹窗）
```

每次决策写入一行 JSONL 审计日志（默认 `~/.dsh/logs/approval.jsonl`）：工具名、命令预览、reason、判定来源（`rule` / `ai` / `ai-error` / `fallback`）、生效模式（`mode`）、风险、AI 理由、耗时。

### 与沙箱模式的配合

审批请求从哪来？绝大多数是**沙箱升级请求**：沙箱拒绝了某个操作，模型带 `sandbox_permissions` 与 `justification` 申请一次性加宽。

| 沙箱模式 | AI 审核是否生效 |
|---|---|
| `read-only` | ✅ 生效——沙箱拒绝写操作，模型可申请升级（`WIDER_MODES` 允许），升级请求照常走审批链 |
| `workspace-write` | ✅ 生效（推荐组合：工作区内自由，越界 AI 把关） |
| `danger-full-access` | ⏸ 不触发——沙箱从不拒绝任何操作，没有升级请求，插件自然空闲 |

`read-only` 下 `WIDER_MODES` 允许模型申请加宽到工作区写甚至完全权限，因此 `read-only` 档同样受本插件保护，不是"只读就等于安全"。

## 规则语法

两种形态可混用。

### ① glob（文本匹配）

匹配对象（任一表面命中即中，大小写不敏感）：

- `ToolName(args preview)` — 如 `Bash(git status)`（bash/pwsh 为原始命令）
- `reason:<文本>` — 审批 reason（如沙箱升级的 justification）

通配：`*` 任意序列、`?` 单字符。

**规则匹配字符，shell 匹配 token，两者会在引号或空格拼接处错开。** 因此除原始文本外，规则还会扫几个还原面：

- **裸参数文本**（仅 deny/ask）：去掉 `ToolName(...)` 外壳的参数原文，让模式能锚定操作结尾——`tar -czf x.tgz ~/.aws` 以凭据目录结尾，而带外壳的文本是 `~/.aws)`
- **重建 argv**（仅 `simple`/`compound`）：`git  status`（多一个空格）与 `git status` 同样命中；`rm -r"f" /tmp/x` 与 `rm -rf /tmp/x` 同样命中。若某段的参数自身含空白（`"git status"` 是名字带空格的一个可执行文件），该段**不生成**这个面——失去参数边界的重建文本与命令并不等价
- **折叠紧贴引号 + 规范化空白**（仅 deny/ask）：删掉与相邻字符粘连的引号字面量（`~/.ss''h/i''d_rsa` → `~/.ssh/id_rsa`），并把连续空白/制表符折成单空格（`npm<TAB>publish 2>log` → `npm publish 2>log`）。独立成参数的引号块（`echo 'rm -rf /'`）不折叠——它只是打印文本，不执行

这些面只**增加**匹配候选，不会让原本命中的规则失效。

优先级：**deny > ask > allow**（与列表顺序无关）；同优先级内按列表顺序取首个。

`ask` 规则可以再标 `hardAsk: true`（文本与结构化规则都支持），把它升级成**红条**：这是一条「必须本人签字」的询问，`ai-auto` 下不走 `mode3OnAsk`，而由 `ai.hardAskOnUnattended` 决定（默认拒绝）。默认规则里发布命令与凭据路径都标了红条；`.dsh/*` 不标（要常用 dsh 修 dsh）。

### ② 结构化 argv 前缀（仿 Codex `prefix_rule`）

```yaml
- tool: bash                    # 只匹配该工具（大小写不敏感）
  pattern: [git, status]        # argv 精确前缀，逐项相等
  action: allow
  forbidOptions: [--output]     # 出现这些选项（含 --opt=value / -O<file>）则本规则不命中
  pathGuard: workspace-relative # 所有非选项参数必须是工作区相对路径
  configGuard: git-clean        # 仓库 git 配置里没有可执行外部程序的名字才命中
```

`pathGuard` 的判定是静态检查 + `realpath` 复核，避免符号链接逃逸。"路径参数"包括 `--` 终止符之后的每一项（`cat -- -x` 的 `-x` 是路径，不是选项），也包括内联在选项里的值（`-Path:..\secret`、`--file=/etc/passwd`）——PowerShell 的参数名与值可以用空格或冒号分隔，两种写法等价。**不以 `-` 开头的不一定是路径、以 `-` 开头的也不一定是选项**：只有形如 `-n` / `--output` / `-Path` 的选项**名**会被跳过，`'-/../../x'` 这种带引号的参数值、裸 `-` 都会照常送检；内联值里只有具名计数开关（`-ReadCount:`/`-TotalCount:`/`-Tail:` + 数字或布尔）不算路径。引号的位置同样有语义：`-Path:'link'` 里引号紧跟选项名与分隔符，真正的值是 `link`；`'--file=link'` 整词被引号包裹，整串就是路径——两者分别按各自的值去送 realpath。

`configGuard: "git-clean"` 读取 `<工作区>/.git/config` 与 `.git/config.worktree`（`extensions.worktreeConfig` 开启时的第二份配置），命中任一条就不放行：`external` / `command` / `textconv` 键（段头独占一行或与键同行的写法都算）、`gpg`（`gpg.program`，签名校验时执行）、`[include]` / `[includeIf]` / `include.path`（被包含的文件读不到，无法核验）、`fsmonitor` 的值不是 `true`/`false`/`0`（非布尔即路径或命令行；值按引号语法解析——`"false"` 是布尔，`"true; exec evil"` 是命令行）。**读不出来就不放行**：只有 `ENOENT`/`ENOTDIR` 才算"没有配置"，权限或 I/O 失败一律视为无法核验。这些键让一条只读命令**无需任何开关**就执行别处指定的程序；`.git` 是 worktree/submodule 的指针文件时同样不放行（配置在读不到的地方）。用户级 `~/.gitconfig` 不在检查范围：那是使用者自己的环境，不是请求能影响的东西。

### 形状闸门（allow 专属，安全关键）

bash/pwsh 的 **allow 规则只在命令被 `shell-shape.js` 判定为 `simple`**（单条纯命令，无重定向、替换、变量、通配、控制流、赋值、换行）时才可能命中。

`git status; rm -rf /tmp/x`、`echo $(touch x)`、`cat /dev/null > /tmp/x`、`Get-ChildItem .; Remove-Item x -Recurse -Force` 都是 compound/opaque，**任何 allow 规则都不会命中它们**。这与 Codex 的立场一致：不能安全拆分时，整条脚本视为一个不透明的调用，前缀规则自然不命中。

`ask` / `deny` 规则不受闸门限制——它们是 fail-safe 那一侧。

**只读命令也可能执行程序**：`git diff` / `git log` 会按仓库配置调用外部命令。默认规则用两道闸：显式开关（`--ext-diff` / `--textconv` / `--output` / `-O` 进 `forbidOptions`）与仓库配置（`configGuard`）。`core.pager` 只在有终端时启用（dsh 下是管道，普通 log/diff 不会起 pager），故不单独设闸。

> 边界说明：`shell-shape.js` 是**保守识别器**，不是 shell 解析器。它只回答"这条命令能否信任其 argv"，**不做子命令拆分**。真正不可绕过的边界仍是沙箱与宿主工具审批策略；规则里的 deny 是加速拒绝，不是沙箱强制。

## 策略层（`decidePolicy`）

裁判只给三条判断（风险、它自己的处理意见、用户授权强度），**放行与否由程序按固定规则算**；命中的分支名会写进审计的 `policy` 字段，所以事后能回答「这次为什么自动放行」。求值顺序（先命中先返回）：

| 分支（`policy`） | 条件 | 结果 |
|---|---|---|
| `judge-deny` | 裁判判 deny | deny（任何容忍度都一样） |
| `high-risk-insufficient-authorization` | 风险 high，且用户授权不是 strong | 交人工（**容忍度管不了它**） |
| `judge-allow-above-tolerance` | 裁判判 allow，但风险高于容忍度、授权不是 strong | 交人工 |
| `judge-allow` | 裁判判 allow，且在容忍度内（或授权 strong） | 放行 |
| `judge-ask` | 裁判判 ask：风险 ≤ 容忍度 → 放行；否则交人工 | 两种落点 |
| `authorization-unknown` | 裁判判 ask、超出容忍度、且没给授权字段 | 交人工（审计能看出是"没给字段"） |

三档容忍度在 `ai` 模式下的落点：

| 容忍度 | 自动放行 | 交人工 |
|---|---|---|
| `low` | 裁判 allow 且风险 low；裁判 ask 且风险 low | 其余，含一切 high |
| `medium`（默认） | 裁判 allow 且风险 ≤ medium（或授权 strong）；裁判 ask 且风险 ≤ medium | 高风险、超出档位的 allow |
| `high` | 裁判 allow 且风险 ≤ high（或授权 strong）；裁判 ask 且风险 ≤ high | 高风险且无 strong 授权 |

容忍度**不是**「自动放行上限」：它决定裁判判 `ask` 时的落点，而裁判判 `allow` 时还要看风险档位与用户授权。`ai-auto` 下最终仍落到 `ask` 的动作，再按来源分流：证据不足 → 拒绝；红条 → `ai.hardAskOnUnattended`；其余 → `mode3OnAsk`。

用户授权强度（`user_authorization`）由裁判给出：`strong` = 用户在本会话里用自己的话要求了这条动作或这个确切目标；`weak` = 用户要求过相近的事，但目标、范围或副作用不同；`none` = 没有用户请求覆盖它。agent 自己写的 reason 与提权理由**永远不算**用户授权；字段缺失时按「不是 strong」处理。

## AI 审判输入 / 输出

**输入**：一条 `system` 消息（固定政策：审批员角色 + 风险/授权定义 + 执行事实说明 + 补证规则 + 只输出 JSON 约束）+ 一条 `user` 消息（请求 JSON，必要时再附 `Evidence:` 与 `Context:` 块）。两者分属不同 role，命令文本无法冒充指令层级。命令本体**不截断**（截断只用于审计/UI 预览）；超过 `ai.maxJudgeCommandChars`（默认 8000）时不问 AI，按 evidence-incomplete 处理。命令、reason 与提权理由在进入 prompt 前统一脱敏（`redact.js`）。

请求 JSON 里除 `toolName` / `command` / `reason`，还可能带执行事实：`cwd`（会话工作区）、`workdir`（本条命令的实际目录）、`escalation.to`（本次请求的提权目标）与 `escalation.justification`（提权理由）。后两者是**不可信证据**：它们由 agent 自己写，只用于判断，不构成用户授权。

**输出**：`{"risk":"low|medium|high","authorization":"allow|ask|deny","user_authorization":"none|weak|strong","evidence":["…"],"unknowns":["…"],"reason":"一句话"}`。`evidence` 与 `unknowns` 是短列表，用来记录它依据了什么、以及它承认没看到什么。

**按需补证**：裁判可在回复里加 `"needs":[{"type":"read-file","path":"<工作区相对路径>","why":"…"}]`（默认最多 2 条），请求读取会改变结论的文件——`bash scripts/deploy.sh` 的效果就藏在脚本里。插件按白名单抓取：realpath 复核后必须落在工作区内、拒凭据文件（`.ssh` / `.aws` / `.codex/auth.json` / `.dsh/profiles` / `.dsh/settings.yaml` / `.env` / 私钥 / `.npmrc` 等）、拒二进制、超长截断并标注；抓不到的文件连同原因记进 `evidenceRefused`，并在第二轮告知裁判。带证据的第二次判定是**最后一轮**（提示词不再提供补证入口），两轮共享同一次审批的时间预算。

解析策略：整串 JSON，或"恰好一个**判决形状**的平衡对象"（允许前后散文/代码围栏）。出现两个及以上裁决、判决被包在别的对象里、或枚举非法 → 该候选失败。**不接受"取第一个对象"**：模型先说 allow 再说 deny 时不会被解读成 allow。

`ai-auto` 模式使用禁用 `ask` 的提示词变体——模型必须在 allow 与 deny 之间自行决定，因为此时没有人类可问。

### 候选链的推进条件

审判模型是一条**有序候选链**：先试 `provider` / `model`，再依次试 `fallbacks` 每一项，按 provider+model 去重。**一个候选只有给出可解析的判定才算答对**：

| 情况 | 是否推进到下一候选 |
|---|---|
| provider 层失败（AUTH / 额度 / 上游 5xx / 连接 / 超时） | 是 |
| 空回复（一个 `text-delta` 都没吐） | 是 |
| 有文本但没有唯一的 `{risk, authorization, reason}` | 是 |
| 给出可解析判定 | 否（胜出） |

调用方取消（`signal` 已 abort）时不会再花下一次调用；同一个候选**不重试**——判定位于审批关键路径，多一次模型调用就是用户多付的延迟。

全部候选都失败时，按**主模型**的失败信息记 `ai-error`（它才是配置意图），并附带 `judgeAttempts` / `judgeTried`。走兜底时，成功记录会带 `judgeModel`（实际作答的模型）、`judgeFallbackFrom`（被跳过的主模型）与 `judgeAttempts`。

> 候选链只在**候选未给出可解析判定**时推进，不会因为"换个模型看法不同"而产出判定。唯一的门槛就是能否解析出唯一的 `{risk, authorization, reason}`。

## 拒绝之后：熔断与一次性人工放行

自动拒绝本身是决策，不是死锁。两条恢复路径：

| 机制 | 触发 | 行为 |
|---|---|---|
| `denialBreaker.duplicate` | 同一动作（`actionKeyOf` 的哈希：工具 + 已脱敏全文）被拒达阈值 | 该动作直接拒绝，不再问模型；别的动作不受影响 |
| `denialBreaker.consecutive` | 连续自动拒绝达阈值 | 本会话冷却 `cooldownMs`：需要 AI 判定的请求直接拒绝（`breaker: cooldown`）；规则命中照旧 |
| `/approval-allow-once <编号>` | 人工授权列表里的一条 | 该动作下一次直接放行（`kind: manual-override`，不花模型调用），用掉即失效；**仍先过规则层**，规则 `deny` 无法被它覆盖 |
| 任何非拒绝结果 | 放行或交人工 | 连续计数清零；熔断自身的拒绝不延长冷却 |

重置路径：冷却到期自动恢复；`/approval-allow-once` 授权时顺带清冷却；切换审批模式或用设置改配置不重置计数（计数只由决策结果驱动）。

## 会话上下文（transcript）

`transcript: "off"`（默认）= 零上下文判定（仅命令本体）；`transcript: "short"` = AI 审判带紧凑上下文，可判断"用户明确要求的操作应放行"（意图优先）。

开启后追加 **Context 块**（紧凑会话骨架，≤ `transcriptMaxChars` 字符）——两级窗口：

- 短窗口：**最近** ≤3 条工具调用 + 各自按 `callId` 关联的结果状态行（`[T]` / `[R]` 行）
- 长窗口：更早的真实用户消息意图线
- 模式行 `[M]` + 最近拒绝 `[D]` + 工作区 `[W]`
- **最近的用户消息作为意图锚点渲染在最后一行**（受预算保护）

`[R]` 只带成功/失败状态与失败文本（≤80 字符），**成功的 stdout 一律不喂给模型**（原始工具输出是间接注入面）；超长消息头尾保留 + 省略计数（`…〔省略 N 字符〕…`）；plugin 注入消息与流式分片一律不进骨架。

实测口径成本：

| 组成 | off | short |
|---|---|---|
| 系统提示 | ~380 token | ~420 token |
| 上下文骨架（≤4000 字符） | — | ~1,600–1,800 token |
| 请求体（实测） | ~100–200 token | 同左 |
| **单次合计** | **~500 token** | **~2,100–2,400 token（≈4 倍）** |

50 次审批的一天会话：`off` ≈ 25k token，`short` ≈ 110k token（前缀缓存命中后 ~84k）。绝对量由 `transcriptMaxChars` 硬闸封顶；缓存前缀（系统 + 模式 + 长窗口）占比 ~60–70%。

## PowerShell（Windows）规则

默认规则含 `Bash(...)` 与 `Pwsh(...)` 两族**并存**——工具名大小写不敏感，结构化规则只匹配自己的 `tool` 字段，互不干扰：

- Windows 上只读命令自动放行：git status/diff/log、Get-ChildItem/ls、Get-Content/cat（限工作区内路径）、Get-Location/pwd、Get-Command、Write-Output、Select-Object
- 树莓派/Linux 继续走 `Bash` 规则

pwsh 的形状判定比 bash 更严格（`;` / `|` / `$()` / 反引号 / 数组运算符一律 opaque），因此 PowerShell 链式命令不会被放行。

## 审计记录格式

决策记录为一行 JSON。熔断与授权相关字段：`kind: "breaker"` 附 `breaker`（`cooldown` / `duplicate-action`）与 `breakerUntil`；人工授权放行是 `kind: "manual-override"` 附 `manualOverride: true`；预算耗尽时 `ai-error` 带 `budgetExhausted: true`。除判定本身，还会带：`policy`（命中的策略分支）、`userAuthorization`、`aiEvidence` / `aiUnknowns`（裁判引用的证据与它承认没看到的点）、`cwd` / `workdir` / `escalation`（执行事实）、`evidenceFetched` / `evidenceRefused` / `evidenceRounds`（补证轮次与结果）、`hardAsk`（红条命中）。`ai-error` 记录在 LLM 流以 `finish.reason.kind = "error"` 或 `"aborted"` 结束时，保留安全裁剪后的 `finishKind` 与 `failure` 字段：

```json
{"kind":"ai-error","finishKind":"error","failure":{"code":"TIMEOUT","message":"upstream request timed out"},"error":"judge stream finished with error [TIMEOUT]: upstream request timed out"}
```

`failure.message`、`failure.code` 与 `requestId` 有长度上限，并会脱敏 Bearer / API key / token / password / secret 以及 URL 敏感查询参数。

常见 `failure.code` 的排查方向：

| code | 方向 |
|---|---|
| `AUTH` | 鉴权 / 密钥 |
| `RATE_LIMIT` / `QUOTA_EXCEEDED` | 限流 / 额度 |
| `SERVER` | 上游 5xx |
| `TIMEOUT` | 超时 |
| `TRANSPORT` | 网络 / 连接 / 流中断 |
| `CONTEXT_WINDOW_EXCEEDED` | 上下文超限 |

这些字段只增强诊断，**不改变** `failOpen`、`mode3OnAsk` 或人工审批策略。

模型**没有任何可解析判定**时，`ai-error` 记录按原因区分两条 `error` 文案：

| 字段 | 含义 |
|---|---|
| `error` | `unparseable judge output (empty reply)`：一个 text-delta 都没吐；`unparseable judge output (no verdict)`：有文本但没有唯一的 `{risk, authorization, reason}` 对象 |
| `rawOutput` | 模型原文，脱敏后截断到 500 字符（空回复时为空串） |
| `textChars` | 该候选实际收到的字符数（空回复为 `0`） |
| `endedWithoutFinish` | `true` 表示流在**没有** `finish` 分片的情况下结束（`AbortSignal` 掐断或连接被丢），用来区分「provider 明确回了空」与「流被打断」 |

例如一条空回复记录：

```json
{"kind":"ai-error","toolName":"pwsh","action":"ask","outcome":"pass","error":"unparseable judge output (empty reply)","rawOutput":"","textChars":0,"endedWithoutFinish":true,"judgeAttempts":2,"judgeTried":["cpa-wx301/…","deepseek-official/deepseek-flash"]}
```
