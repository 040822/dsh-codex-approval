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
| `denialBreaker` | `{consecutive:3, duplicate:2, cooldownMs:600000}` | 拒绝熔断（按会话）：连续 `consecutive` 次自动拒绝 → 冷却 `cooldownMs`；同一动作被拒 `duplicate` 次 → 直接拒绝且不再问模型。`0` 关闭对应项 |
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
| `riskTolerance` | `medium` | **只决定 AI 判 `ask` 时的落点**：`风险 ≤ 容忍度 → 自动放行`。AI 判 `allow` 但超出档位、或高风险且无明确用户授权时，仍会交人工——它不是「自动放行上限」 |
| `maxPromptChars` | `2000` | 仅限审计日志 / UI 预览长度，**不参与决策** |
| `maxJudgeCommandChars` | `8000` | 审判命令预算（200–200000）。超限按 `evidence-incomplete` 处理，不问 AI |
| `timeoutMs` | `15000` | **每个候选各自计时**的超时 |
| `maxTokens` | `512` | 判定输出上限（含 reasoning 余量） |
| `failOpen` | `ask` | AI 层全部候选失败时的兜底：`ask` \| `deny` \| `allow` |
| `hardAskOnUnattended` | `deny` | **红条**（发布、凭据）在 `ai-auto` 下的归宿：`deny` \| `ask`。红条不经过 `mode3OnAsk`，`allow` 不是合法值 |
| `totalBudgetMs` | `30000` | **一次审批的总预算**：覆盖全部候选与补证轮次，单候选仍受 `timeoutMs` 限制但会被剩余预算压低（`0` 关闭） |
| `evidenceFetch` | `read-file` | 裁判按需补证：`off` \| `read-file`（工作区内只读、最多 `evidenceMaxFiles` 个、每个 ≤ `evidenceMaxBytes`；拒凭据文件、二进制与越界路径） |
| `evidenceMaxFiles` | `2` | 单次审批可读取的证据文件数（1–8） |
| `evidenceMaxBytes` | `16384` | 单个证据文件的截断长度（256–512000），超长截断并标注 |

## 默认值行为

不配置即用内置默认：

- **自动放行**：只读命令（git status/diff/log、ls、cat（限工作区内路径）、pwd、which、echo），以及 Windows 上的对应 pwsh 只读族。git 这三条规则还要求仓库 `.git/config` 不含 `diff.external` / textconv driver / `core.fsmonitor`（`configGuard: git-clean`），且命令不带 `--ext-diff` / `--textconv` / `--output` / `-O`；`~`、重定向、命令替换、复合命令一律不放行
- **直接拒绝**：破坏性命令（`rm -rf /`、`rm -rf ~`、`sudo rm`、`mkfs`、`shutdown` / `reboot`（含 `sudo` 前缀）、`sudo dd`、`of=/dev/sd*` 等裸设备写入、fork bomb、pwsh 的 `Format-Volume` / `Stop-Computer` / `Restart-Computer`）
- **必须询问**：敏感词（secret / password / credential / token），以及凭据与审批配置路径（`*/.ssh*`、`*/.aws*`、`*/.codex/auth.json*`、`*/.dsh/profiles*`、`*/.dsh/settings.yaml*`、审计日志本体）——按目录匹配，正斜杠与 Windows 反斜杠两种形态都有，`cp -r ~/.ssh /tmp/` 这类整目录导出同样命中
- **红条（`hardAsk: true`）**：凭据路径（`.ssh` / `.aws` / `.codex/auth.json` / `id_rsa` / `id_ed25519`）与发布命令都是红条。红条是「必须本人签字」：`ai-auto` 下不走 `mode3OnAsk`，按 `hardAskOnUnattended`（默认拒绝）；`.dsh/*` 保持普通 `ask`，因为常用 dsh 修 dsh
- **发布**：npm / pnpm / yarn / bun 的 publish、npm unpublish、twine upload、cargo publish、docker push、gh release create、git push 共 10 组命令 → `ask` + `hardAsk: true`。bash 与 pwsh、裸命令与 `cd x && git push` 这类复合写法都命中

`rules: []`（显式空数组）= **真的没有规则**，不再回落默认规则——想让每次审批都交给 AI 判定时用它。

## 拒绝之后：熔断与一次性放行

- **熔断**（`denialBreaker`）：连续被自动拒绝达到 `consecutive` 次，本会话进入冷却（默认 10 分钟）——冷却期内**需要 AI 判定**的请求直接拒绝，不再花钱问模型；规则命中的请求不受影响（只读命令照旧放行，规则 `deny` 照旧拒绝）。同一动作被拒 `duplicate` 次后也被直接拒绝。任何非拒绝结果（放行或交人工）会把连续计数清零；熔断自身的拒绝不会延长冷却。
- **一次性放行**（`/approval-allow-once`）：`/approval-allow-once` 列出本会话最近被拒的动作（最近在前），`/approval-allow-once 2` 授权第 2 条放行**一次**。授权只对**那一个动作**（同一工具 + 同一命令文本）生效一次，且**仍会先过规则层**——规则 `deny` 不能被授权覆盖；授权同时清除该会话的冷却。授权记录写在内存里，重启后失效。

这两个开关都只影响「要不要为这次判定花钱/要不要直接拒绝」，不会把任何拒绝变成放行依据之外的许可。

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
