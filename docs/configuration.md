# 配置参考

全部配置项。配置写在 profile 的 `cordis.patch.yml`（默认 `~/.dsh/profiles/web/cordis.patch.yml`），在 Web 设置卡片里可改的字段见 [Web 配置卡片](client-card.md)。

## 完整示例

```yaml
- id: dsh-codex-approval
  config:
    mode: ai                   # manual | ai | ai-auto（默认 ai）
    mode3OnAsk: deny           # deny | allow（ai-auto 下 ask 的归宿；默认 deny 安全）
    locale: auto               # auto | zh | en（命令文案语言；auto=跟随 dsh 设置的语言偏好）
    rules:
      - tool: bash                  # 结构化 argv 前缀（推荐）：git status / git status --short 命中
        pattern: [git, status]
        action: allow
      - tool: bash                  # 只读命令里带写副作用的选项要单独禁掉
        pattern: [git, diff]
        action: allow
        forbidOptions: [--output, '-O']
      - tool: bash                  # 需要所有路径参数都在工作区内（静态检查 + realpath 复核）
        pattern: [cat]
        action: allow
        pathGuard: workspace-relative
      - match: '*rm -rf /*'         # glob 规则仍可用（危险命令直接拒绝）
        action: deny
      - match: 'reason:*credential*' # 敏感场景强制询问
        action: ask
    ai:
      enabled: true
      provider: cpa-wx301                      # 本机 CLIProxyAPI（Command Code 通道）
      model: command/deepseek/deepseek-v4.1-flash
      fallbacks:                               # 主模型失败时按序尝试（最多 4 项）
        - provider: deepseek-official          # DSH 原生 llm-deepseek (api.deepseek.com)
          model: deepseek-flash
      riskTolerance: medium          # low | medium | high（仿 Codex risk tolerance；越高越宽松）
      maxPromptChars: 2000           # 仅限审计日志/UI 预览长度，不参与决策
      maxJudgeCommandChars: 8000     # 审判命令预算：超限按 evidence-incomplete 处理（200..200000）
      timeoutMs: 15000
      maxTokens: 512                 # 含 reasoning 余量
      failOpen: ask                  # AI 故障兜底：ask | deny | allow
    fallback: ask                    # 无规则命中且 AI 关闭时：ask | deny | allow
    denyFeedback: true               # 拒绝后向主 agent 注入归因更正消息（默认 true）
    denyFeedbackMax: 3               # 未注入拒绝队列上限（1-10）
    transcript: off                  # off | short：AI 审判是否带紧凑会话上下文（默认 off）
    transcriptMaxChars: 4000         # 上下文骨架字符上限（100-16000）
    logFile: ~/.dsh/logs/approval.jsonl
    logMaxBytes: 5000000             # 审计日志超过该字节数轮转为 approval.jsonl.1
```

## 字段说明

### 顶层

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `ai` | 审批模式：`manual` 完全旁路 / `ai` 规则→AI→ask 交人类 / `ai-auto` ask 永不交人类 |
| `mode3OnAsk` | `deny` | `ai-auto` 下 `ask` 的归宿：`deny` \| `allow`。设为 `allow` 时 AI 无法决定也会放行高风险操作，**慎用** |
| `locale` | `auto` | `/approval-mode` 与拒绝反馈文案语言：`auto` \| `zh` \| `en`。`auto` 跟随 dsh 的 `locale.preference` |
| `rules` | 内置默认 | 规则列表，见 [决策链与规则语法](decision-chain.md#规则语法) |
| `fallback` | `ask` | 无规则命中且 AI 关闭时：`ask` \| `deny` \| `allow` |
| `denyFeedback` | `true` | 拒绝后向主 agent 注入归因更正消息 |
| `denyFeedbackMax` | `3` | 每会话未注入拒绝队列上限（1–10，超限丢最旧） |
| `transcript` | `off` | `off` \| `short`：AI 审判是否带紧凑会话上下文 |
| `transcriptMaxChars` | `4000` | 上下文骨架字符上限（100–16000） |
| `logFile` | `~/.dsh/logs/approval.jsonl` | 决策审计日志路径 |
| `logMaxBytes` | `5000000` | 日志超过该字节数轮转为 `<file>.1` |

### `ai` 段

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否启用 AI 审判层 |
| `provider` | `cpa-wx301` | 判定模型 provider |
| `model` | `command/deepseek/deepseek-v4.1-flash` | 判定模型 id |
| `fallbacks` | `[{deepseek-official, deepseek-flash}]` | 有序兜底候选，最多 4 项，按 provider+model 去重 |
| `riskTolerance` | `medium` | AI 判 `ask` 时按容忍度映射：`风险 ≤ 容忍度 → 自动放行` |
| `maxPromptChars` | `2000` | 仅限审计日志 / UI 预览长度，**不参与决策** |
| `maxJudgeCommandChars` | `8000` | 审判命令预算（200–200000）。超限按 `evidence-incomplete` 处理，不问 AI |
| `timeoutMs` | `15000` | **每个候选各自计时**的超时 |
| `maxTokens` | `512` | 判定输出上限（含 reasoning 余量） |
| `failOpen` | `ask` | AI 层全部候选失败时的兜底：`ask` \| `deny` \| `allow` |

## 默认值行为

不配置即用内置默认：

- **自动放行**：只读命令（git status/diff/log、ls、cat（限工作区内路径）、pwd、which、echo），以及 Windows 上的对应 pwsh 只读族
- **直接拒绝**：破坏性命令（`rm -rf /`、`rm -rf ~`、`sudo rm`、`mkfs`、`shutdown`、`reboot`、pwsh 的 `Format-Volume` 等）
- **必须询问**：敏感词（secret / password / credential / token），以及凭据与审批配置路径（`*/.ssh/*`、`*/.aws/*`、`*/.codex/auth.json*`、`*/.dsh/profiles/*`、审计日志本体）
- **`npm publish`**：内置规则 `Bash(npm publish*)` → `ask`，发布升级请求必定弹窗询问人类；`ai-auto` 下按 `mode3OnAsk` 处理（默认拒绝）。`npm unpublish` 无规则，由 AI 判定（通常判 high 直接拒绝）

`rules: []`（显式空数组）= **真的没有规则**，不再回落默认规则——想让每次审批都交给 AI 判定时用它。

## 模型选型建议

判定是一次 `allow` / `ask` / `deny` 的分类，不需要强推理能力。三类常见配置：

1. **默认**：`provider` / `model` 写死本机 CLIProxyAPI 通道，`fallbacks` 指向 DeepSeek 官方 API
2. **同 API 换更快的模型**：只改 `model`
3. **用完全不同的 provider**：`provider` 与 `model` 同时显式配置

> 上游 `opencode-go` 订阅到期后，`cpa-wx301` 上的 `opencode/*` 模型同样因渠道 `auth_unavailable` 不可用。`ai.fallbacks` 因此默认选 DeepSeek 官方 API（`deepseek-official`，即 DSH 原生 `llm-deepseek` 适配器，走 `DEEPSEEK_API_KEY`），与主模型同属 DeepSeek V4.x 家族但路由独立。

## 成本

| 场景 | 单次 Token | 单次成本（官方高峰价） |
|---|---|---|
| 典型（短命令） | ~400–500 | ≈ 0.003 元 |
| 最坏（命令 8000 字符以内） | ~3,500 | ≈ 0.016 元 |

超过 `ai.maxJudgeCommandChars` 的命令不再送模型（按 evidence-incomplete 处理），所以单次成本有硬上限。仅**规则未命中**时才产生 AI 调用。

开启 `transcript: "short"` 会显著抬高成本，见 [决策链与规则语法](decision-chain.md#会话上下文transcript)。
