# dsh-codex-approval

**仿照 OpenAI Codex CLI 审批模型的 AI 自动审批插件**，为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）带来 Codex 式的智能审批。

中文 | [更新日志](docs/changelog.md)

---

`dsh-codex-approval` 在 dsh 的 `approval/request` 应答者（answerer）接缝上实现一条完整的自动审批决策链：**确定性规则**先过滤，**AI 风险审判**接管规则没覆盖的部分，**人类弹窗**做最终兜底。

```
规则层（Codex approve-always / reject-always 风格）
  → AI 审判层（Codex 三级风险 + 三级授权 + risk tolerance）
  → 人类兜底（GUI 弹窗）
```

## 为什么需要它

原生 dsh 只有两种审批手段：模式级沙箱（`read-only` / `workspace-write` / `danger-full-access`）和一刀切的 `ask` / `never` 策略。结果是**要么每次越界都弹窗打断你，要么彻底放开权限**——中间没有"低风险自动放行、高风险才问我"这一档。

本插件补上这一档。

| 能力 | 原生 dsh | 本插件 |
|---|---|---|
| 命令级规则（allow / ask / deny） | 无 | glob 规则 + 结构化 argv 前缀规则，`deny > ask > allow` |
| 风险分级 | 无 | AI 输出 `low` / `medium` / `high` |
| 授权分级 | 无 | AI 输出 `allow` / `ask` / `deny` |
| 风险容忍度 | 无 | `riskTolerance` 把 AI 的 `ask` 按容忍度映射成放行或询问 |
| 越界操作的处置 | 每次弹窗或彻底放开 | 规则 → AI → 人类，三级递进 |
| 复合命令的安全判定 | 无 | 形状闸门：非"单条纯命令"一律不进 allow |
| 拒绝的归因 | 一律报成"用户拒绝" | 注入更正消息，说明这是自动审批拒绝 |
| 可视化配置 | — | Web 设置卡片选模型、编兜底链、调容忍度 |

## 功能特性

### 规则层：确定性放行与拒绝

Codex `--approve-always` / `--reject-always` 的等价物。规则命中即刻定论、零延迟：

- **两种规则形态**：`Bash(git status)` 风格的 glob，或 `{tool: bash, pattern: [git, status]}` 风格的结构化 argv 前缀（仿 Codex `prefix_rule`）
- **三个动作**：`allow` / `ask` / `deny`，安全优先级 **deny > ask > allow**（与列表顺序无关）
- **细粒度约束**：`forbidOptions` 排除带写副作用的选项（如 `git diff --output`）、`pathGuard` 要求所有路径参数落在工作区内（静态检查 + `realpath` 复核）
- **形状闸门**：`allow` 规则只对"单条纯命令"生效。含重定向、命令替换、变量、通配、控制流的复合命令一律不命中——与 Codex 同立场：无法安全拆分时，整条脚本视为不透明调用
- **内置默认**：只读命令自动放行、破坏性命令直接拒绝、凭据与敏感词强制询问；`npm publish` 必定弹窗

规则语法详见 [决策链与规则语法](docs/decision-chain.md#规则语法)。

### AI 审判层：像 Codex 那样分级放行

规则没命中的请求交给 LLM 裁决，它会同时给出**风险等级**与**授权建议**，再由你的风险容忍度决定最终动作：

- **三级风险**：只读 = `low`、有界修改 = `medium`、破坏/泄密/系统级 = `high`
- **三级授权**：`allow` 直接放行、`ask` 交人类、`deny` 禁止
- **风险容忍度映射**：默认 `medium`——AI 判 `ask` 时，风险 ≤ 容忍度就自动放行，超了就交人类
- **有序候选链**：主模型失败时按序尝试兜底候选（最多 4 个），一个候选只有给出可解析判定才算答对
- **意图优先**：开启会话上下文后，AI 能识别"这是用户明确要求的操作"并据此放行
- **失败不静默**：全部候选失败、超时、输出非法 → 按 `failOpen` 兜底（默认交人类）

### 审批模式：三档自主度，随时切换

一个与 dsh 沙箱模式**正交**的维度，用 `/approval-mode` 命令随时切换：

| 模式 | 行为 | 适合 |
|---|---|---|
| `manual` | **完全旁路**，审批全部交回人类弹窗 | 回归未装插件的原生体验 |
| `ai`（默认） | 规则 → AI → `ask` 交人类 | 日常：低风险自动、高风险问人 |
| `ai-auto` | 规则 → AI → **`ask` 永不交人类** | 无人值守：AI 全权把关，绝不弹窗 |

```
/approval-mode            显示当前模式
/approval-mode 3          切换为 ai-auto
/approval-mode default    清除会话覆盖
```

`ai` 模式适合交互式开发；`ai-auto` 适合让 agent 长时间自主运行而不被弹窗打断。

### 不需要人类看的拒绝，就不该假装是人类拒绝

dsh 的沙箱层把所有审批拒绝硬编码成 "the user rejected..."。当拒绝来自自动审批时，主 agent 会误以为是你本人否决了——于是道歉、停下，或换个更隐蔽的路径重试。

`denyFeedback` 在拒绝后向模型注入一条更正消息，明确说明**这不是用户拒绝**、给出拒绝来源与理由，并要求它转向更安全的方案而不是绕路。

### Web 配置卡片

在 **设置 → 插件 → 插件配置** 里可视化调整：主模型（按 provider 分组、不可用项标红置底）、兜底候选链（增删 + 调序）、风险容忍度、`failOpen`、`mode3OnAsk`、超时、输出上限、拒绝反馈开关。改动保存即 live 生效。

## 按场景选型

| 你的情况 | 建议 |
|---|---|
| 日常开发，不想每次越界都点确认，但危险操作必须经过我 | 用默认 `ai` 模式，保持 `workspace-write` 沙箱 |
| 让 agent 长时间无人值守跑任务，绝不希望它停下来等人 | 切 `ai-auto` 模式 |
| 只想验证插件是否生效，或临时完全关掉自动审批 | 切 `manual` 模式（等价于没装插件） |
| 常用命令每次都过 AI，想省 token 和延迟 | 把该命令写成 `allow` 规则，走零延迟规则层 |
| 某类命令永远不能执行 | 写成 `deny` 规则（AI 无权覆盖） |
| 想让 AI 判断带上下文（例如识别"用户刚才明确要求过这个操作"） | 开启 `transcript: short` |
| 判定模型所在路由挂了 | 配置 `ai.fallbacks` 候选链，或在卡片里直接换模型 |

## 快速上手

### 安装

```bash
dsh plugin --profile web add dsh-codex-approval
# 重启 dsh web 生效
```

插件只在目标 profile 注册（推荐 `web`）；`qqbot` / `headless` 等 profile 不受影响。

### 三步用起来

1. 重启 `dsh web`，在会话输入框的权限选择器里确认处于 `read-only` 或 `workspace-write`
2. 在会话里执行 `/approval-mode` 确认当前模式（默认 `ai`）
3. 正常干活即可——低风险越界操作会被自动放行，高风险会照常弹窗

### 配置

默认配置开箱可用。要改判定模型、加规则，编辑 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-codex-approval
  config:
    mode: ai
    rules:
      - tool: bash
        pattern: [git, status]
        action: allow
      - match: '*rm -rf /*'
        action: deny
    ai:
      riskTolerance: medium
      fallbacks:
        - provider: deepseek-official
          model: deepseek-flash
```

完整字段见 [配置参考](docs/configuration.md)。

### 验证与卸载

验证：执行 `/approval-mode` 应显示当前模式；决策会实时写入 `~/.dsh/logs/approval.jsonl`。

卸载：

```bash
dsh plugin --profile web remove dsh-codex-approval
```

## 兼容性

| 维度 | 支持 |
|---|---|
| DSH 版本 | 0.1.0-rc.6 / 0.1.2-rc.1 / 0.1.5-rc.1 / 0.2.0-rc.2（均声明兼容） |
| 会话 API | 同时兼容旧版 `session.events` 与新版 `snapshotEvents()` / `ownEvents()` |
| 权限档位 | 在 `read-only` 与 `workspace-write` 下生效；`danger-full-access` 下自然空闲 |
| 平台 | Linux / Raspberry Pi（bash 规则族）与 Windows（pwsh 规则族）并存 |
| Node.js | >= 22.19 |

> `danger-full-access` 下沙箱不拒绝任何操作，因此不产生审批请求，插件没有介入点。想让它生效请保持在 `workspace-write`。

## 常见问题

**插件装了没反应？**
确认权限档位不是 `danger-full-access`——那一档没有任何审批请求。另外确认已**重启** `dsh web` 进程，仅刷新页面不加载新插件。

**设置卡片看不到？**
卡片在 **设置 → 插件 → 插件配置**，key 为 `dsh-codex-approval-config`。看不到时先确认 Host 已加载新代码并刷新页面；排查细节见 [Web 配置卡片](docs/client-card.md#web-卡片排查)。

**为什么某个操作用 AI 判了而没走规则？**
`allow` 规则只对"单条纯命令"生效。含 `;` `|` `>` `$()` 变量或通配的命令是复合/不透明命令，任何 allow 规则都不会命中——这是刻意的安全设计。需要放行这类命令时，请改用更窄的写法或接受 AI 判定。

**怎么临时完全关掉自动审批？**
`/approval-mode manual`（当前会话），或在配置里设 `mode: manual`。也可把权限档切回 `Workspace Write`。

**AI 判定总是失败 / 报 ai-error？**
检查 `~/.dsh/logs/approval.jsonl` 里的 `failure.code`：`AUTH` 是密钥、`RATE_LIMIT` / `QUOTA_EXCEEDED` 是额度、`TIMEOUT` 是超时。候选链会在 provider 失败或候选答不出可解析判定时自动推进到下一个候选。字段含义见 [决策链与规则语法](docs/decision-chain.md#审计记录格式)。

**开了 `transcript: short` 之后成本涨了？**
这是预期的——上下文骨架让单次判定从约 500 token 涨到约 2,100–2,400 token（约 4 倍）。用 `transcriptMaxChars` 收紧预算，或在不需要意图优先时保持默认 `off`。

**能不能同时装别的审批插件？**
**不要。** 同一 profile 只装一个审批裁决插件，否则会静默冲突（先应答者独占决策槽位，或上游的"需要人工"被下游 AI 重新裁决）。详见 [安全模型与边界](docs/security.md#-不要同时装多个审批裁决插件)。

## 已知限制

- **形状闸门是保守识别器，不是 shell 解析器**：它只回答"这条命令能否信任其 argv"，不做子命令拆分，无法覆盖所有间接副作用
- **拒绝的源头文案无法修改**：`denyFeedback` 通过紧邻的更正消息覆盖模型感知，并非源头级修正
- **`danger-full-access` 下完全空闲**：那一档没有审批请求可介入
- **AI 判定不是安全保证**：枚举校验只约束输出格式，不能保证裁判免受提示注入影响；真正不可绕过的边界仍是沙箱与宿主审批策略
- **同一 profile 只能装一个审批裁决插件**（见上方常见问题）

## 开发

```bash
node --test              # 规则、Session API、transcript、拒绝反馈、AI 裁决、兜底链、模型选择器与浏览器半边冒烟测试
npm run build:client     # 改 src/client/* 后重建 lib/client.js
```

## 文档

| 文档 | 内容 |
|---|---|
| [决策链与规则语法](docs/decision-chain.md) | 完整决策流程、规则语法、AI 审判输入输出、候选链推进条件、审计格式 |
| [配置参考](docs/configuration.md) | 全部配置字段、默认值行为、模型选型与成本 |
| [安全模型与边界](docs/security.md) | 安全机制、已知边界、多插件共存风险 |
| [Web 配置卡片](docs/client-card.md) | 卡片能力、外观约定、模型可用性、排查与构建 |
| [本地部署环境说明](docs/dev-environment.md) | 特定部署的 provider 通道补丁依赖与判定模型默认值由来 |
| [更新日志](docs/changelog.md) | 版本历史 |

## License

MIT
