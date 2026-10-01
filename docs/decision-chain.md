# 决策链与规则语法

本文是 `approval/request` 应答者的完整决策语义：请求经过哪几道闸门、规则怎么匹配、AI 审判拿到什么输入、候选链如何推进。

## 决策流程

```
approval/request 到达（toolName + callId + reason）
├─ 1. 参数反查：按 callId 从会话日志恢复**完整**命令（bash/pwsh 取原始 command；不截断）
├─ 2. 形状判定（shell-shape.js，bash/pwsh）：simple（单条纯命令）/ compound（安全分隔符串联）/ opaque（重定向、替换、变量、通配、控制流…）
│     只有 simple 才可能被 allow 规则放行；compound/opaque 一律交规则 ask/deny → AI/人类
├─ 3. 证据门槛：参数缺失或命令超 ai.maxJudgeCommandChars → 标记 evidence-incomplete，**不问 AI**
│      ai → 交人类；ai-auto → 拒绝（mode3OnAsk=allow 也不能放行）
├─ 4. 规则层（deny > ask > allow，命中即定，0ms）
│     deny → 直接拒绝（AI 无权覆盖）│ allow → 静默放行 │ ask → 交人类
├─ 5. AI 审判层（规则未命中时）
│     LLM 裁决 {risk, authorization, reason}——要求**单个**合法 JSON 对象，多裁决视为非法
│     allow/deny 直接生效；ask 按 riskTolerance 映射
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

优先级：**deny > ask > allow**（与列表顺序无关）；同优先级内按列表顺序取首个。

### ② 结构化 argv 前缀（仿 Codex `prefix_rule`）

```yaml
- tool: bash                    # 只匹配该工具（大小写不敏感）
  pattern: [git, status]        # argv 精确前缀，逐项相等
  action: allow
  forbidOptions: [--output]     # 出现这些选项（含 --opt=value / -O<file>）则本规则不命中
  pathGuard: workspace-relative # 所有非选项参数必须是工作区相对路径
```

`pathGuard` 的判定是静态检查 + `realpath` 复核，避免符号链接逃逸。

### 形状闸门（allow 专属，安全关键）

bash/pwsh 的 **allow 规则只在命令被 `shell-shape.js` 判定为 `simple`**（单条纯命令，无重定向、替换、变量、通配、控制流、赋值、换行）时才可能命中。

`git status; rm -rf /tmp/x`、`echo $(touch x)`、`cat /dev/null > /tmp/x`、`Get-ChildItem .; Remove-Item x -Recurse -Force` 都是 compound/opaque，**任何 allow 规则都不会命中它们**。这与 Codex 的立场一致：不能安全拆分时，整条脚本视为一个不透明的调用，前缀规则自然不命中。

`ask` / `deny` 规则不受闸门限制——它们是 fail-safe 那一侧。

> 边界说明：`shell-shape.js` 是**保守识别器**，不是 shell 解析器。它只回答"这条命令能否信任其 argv"，**不做子命令拆分**。真正不可绕过的边界仍是沙箱与宿主工具审批策略；规则里的 deny 是加速拒绝，不是沙箱强制。

## AI 审判输入 / 输出

**输入**：固定系统提示（审批员角色 + risk/authorization 定义 + 意图优先规则 + 只输出 JSON 约束）+ `{"toolName", "command", "reason"}`。命令本体**不截断**（截断只用于审计/UI 预览）；超过 `ai.maxJudgeCommandChars`（默认 8000）时不问 AI，按 evidence-incomplete 处理。命令与 reason 在进入 prompt 前统一脱敏（`redact.js`）。

**输出**：`{"risk":"low|medium|high","authorization":"allow|ask|deny","reason":"一句话"}`。

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

决策记录为一行 JSON。`ai-error` 记录在 LLM 流以 `finish.reason.kind = "error"` 或 `"aborted"` 结束时，保留安全裁剪后的 `finishKind` 与 `failure` 字段：

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
