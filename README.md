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

**输入**：固定系统提示（审批员角色 + risk/authorization 定义 + 只输出 JSON 约束）+ `{"toolName", "command", "reason"}`（命令截断 2000 字符，无其他上下文）。

**输出**：`{"risk":"low|medium|high","authorization":"allow|ask|deny","reason":"一句话"}`；解析策略：整体 JSON → ```json``` 代码块 → 平衡花括号扫描；枚举校验失败按 AI 故障处理。

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
