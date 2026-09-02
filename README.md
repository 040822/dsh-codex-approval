# dsh-codex-approval

> **仿照 OpenAI Codex CLI 审批模型的 AI 自动审批插件**，为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）带来 Codex 式的智能审批体验。

dsh 原生只有两种审批策略：模式级沙箱（`read-only` / `workspace-write` / `danger-full-access`）和一刀切的 `ask`/`never` 策略——**没有命令级规则，也没有 AI 风险评估**。本插件在 dsh 的 `approval/request` 应答者（answerer）seam 上实现了一个完整的自动审批决策链：

```
规则层（Codex approve-always / reject-always 风格）
  → AI 审判层（Codex 三级风险 + 三级授权 + risk tolerance）
  → 人类兜底（GUI 弹窗）
```

## 仿照 Codex 的什么

| Codex CLI | 本插件 |
|---|---|
| `--approve-always 'Bash(git diff)'` / `--reject-always` | glob 规则（`Bash(git *)` / `reason:*curl*`），动作 `allow` / `ask` / `deny`，安全优先级 **deny > ask > allow** |
| 工具风险分级 `low` / `medium` / `high` | AI 对每次审批请求输出 `risk: low\|medium\|high`（只读=low、有界修改=medium、破坏/泄密/系统级=high） |
| 三级授权 | AI 输出 `authorization: allow\|ask\|deny`——直接放行 / 交人类 / 禁止 |
| `risk_tolerance` 配置 | `riskTolerance: low\|medium\|high`：AI 判 ask 时按容忍度映射（风险 ≤ 容忍度 → 自动放行） |
| `--permission-mode auto` 的"低风险自动、高风险询问" | 默认 `tolerance: medium`：low/medium 自动放行，high 交人类或由 AI 直接拒绝 |

## 决策流程

```
approval/request 到达（toolName + callId + reason）
├─ 1. 参数反查：按 callId 从会话日志恢复完整命令（bash/pwsh 取原始 command）
├─ 2. 规则层（deny > ask > allow，命中即定，0ms）
│     deny → 直接拒绝（AI 无权覆盖）│ allow → 静默放行 │ ask → 交人类
├─ 3. AI 审判层（规则未命中时；默认 opencode-go / deepseek-v4-flash）
│     LLM 裁决 {risk, authorization, reason}
│     allow/deny 直接生效；ask 按 riskTolerance 映射
│     AI 报错/超时/输出非法 → failOpen（默认 ask → 人类）
└─ 4. 兜底：fallback（默认 ask → GUI 弹窗）
```

每次决策写入一行 JSONL 审计日志（默认 `~/.dsh/logs/approval.jsonl`）：工具名、命令预览、reason、判定来源（rule / ai / ai-error / fallback）、**模式（mode）**、风险、AI 理由、耗时。

## 审批模式（v0.2.0）

插件提供一个与 dsh 沙箱模式**正交**的审批模式维度，三种模式按需切换：

| 模式 | 名称 | 行为 | 场景 |
|---|---|---|---|
| 1 | `manual` | **完全旁路**：不决策、不写日志，审批全部交回人类弹窗 | 回归未装插件的原生体验 |
| 2 | `ai`（默认） | 规则 → AI → ask 交人类 | 日常：低风险自动、高风险问人 |
| 3 | `ai-auto` | 规则 → AI → **ask 永不交人类**，按 `mode3OnAsk`（默认 deny）处理 | 全自动操作但又不放心 full access：AI 全权把关，绝不弹窗 |

**运行时切换**（GUI 斜杠命令，作用于当前会话，持久化到 settings）：

```
/approval-mode            显示当前模式（覆盖值 + 生效值）
/approval-mode 3          切换为 ai-auto（也接受 ai-auto / 1 / 2 / manual 等）
/approval-mode default    清除会话覆盖，回落到配置默认
```

**ai-auto 下 ask 的归宿**（`mode3OnAsk`，默认 `deny`）：规则 ask、AI 判 ask 且超容忍度、AI 故障 failOpen=ask、兜底 fallback=ask——全部按此处理，绝不弹窗。⚠️ 若设为 `allow`，AI 无法决定时也会放行高风险操作，**慎用**。

**模式持久化**：会话覆盖存 `~/.dsh/settings.yaml` 的 `dsh-codex-approval` 命名空间（settings 服务不可用时降级为纯内存，重启丢失）。默认模式由配置 `mode` 字段决定。

**与 dsh 沙箱模式的关系**：

| 沙箱模式 | AI 审核是否生效 |
|---|---|
| `read-only` | ✅ 生效——沙箱拒绝写操作，模型可申请升级（`WIDER_MODES` 允许），升级请求照常走审批链 |
| `workspace-write` | ✅ 生效（推荐组合：工作区内自由，越界 AI 把关） |
| `danger-full-access` | ⏸ 不触发——沙箱从不拒绝任何操作，没有升级请求，插件自然空闲 |

**命令多语言**：`/approval-mode` 的返回文案跟随 dsh 设置的语言（`locale.preference`，中/英）。命令 `description` 在启动时按当时语言注册，运行中切换语言后需重启才更新 description（返回文本每次实时跟随）。

**npm publish 默认 ask**：内置规则 `Bash(npm publish*) → ask`——agent 执行 `npm publish` 的升级请求**必定弹窗询问人类**，AI 无权自动放行（`ai` 模式下弹窗；`ai-auto` 模式下按 `mode3OnAsk` 处理，默认拒绝）。`npm unpublish` 无规则，由 AI 默认判定（通常判 high 直接拒绝）。

## 拒绝归因反馈（denyFeedback，v0.3.0）

**问题**：dsh 的沙箱层把一切审批拒绝硬编码为 "the user rejected..."（`dsh-sandbox` 的 `approveEscalation`），插件 AI 拒绝时主 agent 会误以为用户拒绝了——道歉、停下、或盲目重试，而不是带理由去找更安全路径。

**方案**：插件在自身产生拒绝（规则 deny / AI deny / ai-auto 的 mode3 拒绝 / AI 故障 failOpen deny / 兜底 deny）后，把拒绝记录进内存队列；下一次 `agent/pre-step`（模型即将推理）时向消息列表追加一条**更正消息**（`user` 角色 + `source.kind: "plugin"`，机制同 dsh-time-context / dsh-tool-cordis）：

```
[auto-review] The previous action `rm -rf /tmp/x` was denied by the automatic
approval reviewer (source: deterministic rule) — this was NOT a user rejection.
Do not pursue this action via workaround or indirect execution; continue with
a materially safer alternative, or stop and ask the user.
```

- 被拒工具的 `tool/result` 错误与更正消息出现在同一次模型推理中（紧邻），模型可完成正确归因
- 用户手动拒绝（GUI 弹窗）不经过插件 answerer，**不会被标记为自动审批拒绝**
- 模型被拒后立即结束回合时，更正留在队列，**下一回合首步注入**（消息持久化在会话中，重启后不重复注入）
- 每会话未注入队列上限 `denyFeedbackMax`（默认 3，超限丢最旧）

配置：`denyFeedback: true|false`（默认 true）；文案跟随 `locale` 设置（zh/en）。已知边界：源头文案（"the user rejected"）由 dsh 核心生成，本功能通过紧邻更正消息覆盖模型感知，并非源头级修正。

## 安装

```bash
dsh plugin --profile web add dsh-codex-approval
# 重启 dsh web 生效
```

插件只在目标 profile 注册（推荐 web）；qqbot / headless 等 profile 不受影响。

## 配置（~/.dsh/profiles/web/cordis.patch.yml）

```yaml
- id: dsh-codex-approval
  config:
    mode: ai                   # manual | ai | ai-auto（默认 ai）
    mode3OnAsk: deny           # deny | allow（ai-auto 下 ask 的归宿；默认 deny 安全）
    locale: auto               # auto | zh | en（命令文案语言；auto=跟随 dsh 设置的语言偏好）
    rules:
      - match: 'Bash(git status*)'   # 命中即自动通过（Codex approve-always）
        action: allow
      - match: 'Bash(rm -rf /*)'     # 危险命令直接拒绝（Codex reject-always）
        action: deny
      - match: 'reason:*credential*' # 敏感场景强制询问
        action: ask
    ai:
      enabled: true
      provider: opencode-go          # 与主 agent 同一 provider（成本一致）
      model: deepseek-v4-flash       # deepseek-chat 官方 API 已弃用
      riskTolerance: medium          # low | medium | high（仿 Codex risk tolerance）
      maxPromptChars: 2000
      timeoutMs: 15000
      maxTokens: 512                 # 含 reasoning 余量
      failOpen: ask                  # AI 故障兜底：ask | deny | allow
    fallback: ask                    # 无规则命中且 AI 关闭时：ask | deny | allow
    denyFeedback: true               # 拒绝后向主 agent 注入归因更正消息（默认 true）
    denyFeedbackMax: 3               # 未注入拒绝队列上限（1-10）
    transcript: off                  # off | short：AI 审判是否带紧凑会话上下文（默认 off）
    transcriptMaxChars: 4000         # 上下文骨架字符上限（100-16000）
    logFile: ~/.dsh/logs/approval.jsonl
```

不配置即用内置默认：只读命令（git status/diff/log、ls、cat、pwd、which、echo）自动放行，破坏性命令（`rm -rf /`、`rm -rf ~`、`sudo rm`、`shutdown`、`reboot`、`mkfs`）直接拒绝，敏感词（secret/password/credential/token）询问。

## 规则语法

- 匹配对象（任一表面命中即中，大小写不敏感）：
  - `ToolName(args preview)` — 如 `Bash(git status)`（bash/pwsh 为原始命令）
  - `reason:<文本>` — 审批 reason（如沙箱升级的 justification）
- 通配：`*` 任意序列、`?` 单字符
- 优先级：**deny > ask > allow**（与列表顺序无关）；同优先级内按列表顺序取首个

## AI 审判输入/输出

**输入**：固定系统提示（审批员角色 + risk/authorization 定义 + **意图优先规则** + 只输出 JSON 约束）+ `{"toolName", "command", "reason"}`（命令截断 2000 字符）。

开启 `transcript: "short"` 后追加 **Context 块**（紧凑会话骨架，≤`transcriptMaxChars` 字符）——两级窗口：短窗口（最近用户消息 + ≤3 条工具调用 → `[U]/[T]/[R]` 行）+ 长窗口（更早的真实用户消息意图线）+ 模式行 `[M]` + 最近拒绝 `[D]` + 工作区 `[W]`。超长消息头尾保留 + 省略计数（`…〔省略 N 字符〕…`）；plugin 注入消息与流式 chunk 一律不进骨架。**默认 off 时行为与 v0.3.0 完全一致。**

**输出**：`{"risk":"low|medium|high","authorization":"allow|ask|deny","reason":"一句话"}`；解析策略：整体 JSON → ```json``` 代码块 → 平衡花括号扫描；枚举校验失败按 AI 故障处理。

## 会话上下文（transcript，v0.4.0）

`transcript: "off"`（默认）= 零上下文判定（仅命令本体）；`transcript: "short"` = AI 审判带紧凑上下文，可判断"用户明确要求的操作应放行"（意图优先）。实测口径成本：

| 组成 | off | short |
|---|---|---|
| 系统提示 | ~380 token | ~420 token |
| 上下文骨架（≤4000 字符） | — | ~1,600-1,800 token |
| 请求体（实测） | ~100-200 token | 同左 |
| **单次合计** | **~500 token** | **~2,100-2,400 token（≈4 倍）** |

50 次审批的一天会话：off ≈ 25k token，short ≈ 110k token（前缀缓存命中后 ~84k）。绝对量由 `transcriptMaxChars` 硬闸封顶；缓存前缀（系统+模式+长窗口）占比 ~60-70%。实测本会话（5733 事件、含 12891 字符粘贴输出）骨架化后稳定在预算内。

## PowerShell（Windows）规则

默认规则含 `Bash(...)`（Linux/树莓派 toolName=bash 生效）与 `Pwsh(...)`（Windows toolName=pwsh 生效）两族**并存**——工具名大小写不敏感匹配，互不干扰：Windows 上只读命令（git status/diff/log、Get-ChildItem/ls、Get-Content/cat、Get-Location/pwd、Get-Command、Write-Output、Select-Object）自动放行；树莓派继续走 Bash 规则。如需整体替换规则，`cordis.patch.yml` 配 `rules` 即可（覆盖默认）。

## 安全注意事项

- **deny 规则永远最先求值**，AI 无权覆盖显式拒绝
- AI 输出只映射为三种结果之一，不存在注入面；命令文本进 prompt 前截断
- AI 调用有超时上限（默认 15s），失败默认交还人类（fail-open，不会静默全拒）
- 审批审计对（approval/asked + approval/decided）由 dsh 审批服务持久化，插件只追加自己的决策日志
- `danger-full-access` 模式下沙箱不拒绝任何操作，审批请求不会发生，插件自然空闲
- 单次 AI 审批成本约 0.3~0.7 分钱（官方价估算），仅规则未命中时产生

## 成本

| 场景 | 单次 Token | 单次成本（官方高峰价） |
|---|---|---|
| 典型（短命令） | ~400-500 | ≈ 0.003 元 |
| 最坏（命令 2000 字符） | ~1,500 | ≈ 0.007 元 |

## 开发与测试

```bash
node --test        # 55 个单测：规则匹配 / 参数反查 / AI 裁决解析 / 决策流
```

## License

MIT
