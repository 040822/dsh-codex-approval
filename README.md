# dsh-codex-approval

> **仿照 OpenAI Codex CLI 审批模型的 AI 自动审批插件**，为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）带来 Codex 式的智能审批体验。

dsh 原生只有两种审批策略：模式级沙箱（`read-only` / `workspace-write` / `danger-full-access`）和一刀切的 `ask`/`never` 策略——**没有命令级规则，也没有 AI 风险评估**。本插件在 dsh 的 `approval/request` 应答者（answerer）seam 上实现了一个完整的自动审批决策链：

> 兼容声明：`0.4.1` 同时兼容旧版 DSH 的 `session.events` 与新版 DSH 的 `snapshotEvents()` / `ownEvents()` Session API。

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
├─ 3. AI 审判层（规则未命中时；默认 cpa-wx301 / command/deepseek/deepseek-v4.1-flash）
│     LLM 裁决 {risk, authorization, reason}
│     allow/deny 直接生效；ask 按 riskTolerance 映射
│     主模型失败 → 依次尝试 ai.fallbacks（默认 deepseek-official / deepseek-flash）
│     全部候选失败/超时/输出非法 → failOpen（默认 ask → 人类）
└─ 4. 兜底：fallback（默认 ask → GUI 弹窗）
```

> 默认审判模型原为 `opencode-go / deepseek-v4-flash`。OpenCode Go 订阅到期后该路由返回
> `401 CreditsError`，会让 AI 审判层整体退化到 `failOpen`；现在默认改走本机 CLIProxyAPI
> （`cpa-wx301`）的 Command Code 通道，并以 DeepSeek 官方 API（`deepseek-official`）作为兜底。

每次决策写入一行 JSONL 审计日志（默认 `~/.dsh/logs/approval.jsonl`）：工具名、命令预览、reason、判定来源（rule / ai / ai-error / fallback）、**模式（mode）**、风险、AI 理由、耗时。

当 LLM stream 以 `finish.reason.kind = "error"` 或 `"aborted"` 结束时，`ai-error` 记录还会保留安全裁剪后的 `finishKind` 和 `failure` 字段，并把错误摘要带入 `error` 字段。例如：

```json
{"kind":"ai-error","finishKind":"error","failure":{"code":"TIMEOUT","message":"upstream request timed out"},"error":"judge stream finished with error [TIMEOUT]: upstream request timed out"}
```

`failure.message`、`failure.code` 和 `requestId` 有长度上限，并会脱敏 Bearer/API key/token/password/secret 以及 URL 敏感查询参数；不会把凭据原文写入审计日志或拒绝反馈。常见 code 的排查方向：`AUTH`（鉴权/密钥）、`RATE_LIMIT` 或 `QUOTA_EXCEEDED`（限流/额度）、`SERVER`（上游 5xx）、`TIMEOUT`（超时）、`TRANSPORT`（网络/连接/流中断）、`CONTEXT_WINDOW_EXCEEDED`（上下文超限）。这些字段只增强诊断，不改变 `failOpen`、`mode3OnAsk` 或人工审批策略。

## Web 配置与模型可用性

**卡片在哪**：Web UI → **设置 → 插件 → 插件配置**（英文 `Settings → Plugins → Plugin configuration`）。该标签页按 settings namespace 列出可配置插件，本插件的卡片由自身浏览器半边注册在 `settings.plugin.item` slot 上，key 为 `dsh-codex-approval-config`。看不到卡片时先确认 Host 已加载新代码并刷新页面（见下方构建与重启说明）。

**卡片长什么样**：与内置插件卡片一致——`<ul>` 里的 `<li>` 卡片（`.5px` 边框、16px 圆角、`bg-layer-3`／展开后 `bg-layer-2`），可折叠 header（名称 + 描述 + 未保存 Tag + 箭头）、body 表单、footer 的「放弃 / 保存」。样式取值逐条抄自内置的 `PluginCard.module.css` 与 `fields.module.css`（边框、圆角、14/16px 内边距、15px/600 标题、13px 描述、34px 控件高、focus 用 `--dsw-alias-brand-primary` 描边），并作用域在 `dsh-ca-` 前缀下，通过 `data-plugin-css` 约定的 `<style>` 注入（`client-card-style.js`，测试见 `test/client-card-style.test.mjs`）。图标、`Tag`、`Switch` 来自 shell 静态表模块 `@deepseek-ai/dsh-client-ui-primitives`。卡片默认折叠，与其它插件卡片行为一致。

卡片里可以配置：**主模型**（下拉，按 provider 分组，可用项在前、不可用项标 `⚠` 并置底）、**兜底候选**（最多 4 项，可增删、可上下移动调序）、风险容忍度、`failOpen`、`mode3OnAsk`、超时、最大输出 token、拒绝反馈开关。改动后 header 出现「未保存」Tag 并启用「保存 / 放弃」；保存经 settings revision fence 写入并在 Host 侧 live 生效。

可用性来自 `session.modelCatalog()`：`failures` 里的 provider 显示具体失败原因（如 401 额度），不在 `routableProviders` 里的 provider 标注“不可路由”；两种都**仍可选**，只是标红置底，避免冷却中的路由被藏起来。当前配置的 provider 若不在目录中，下拉会保留一个“（不在模型目录中）”项，防止静默改值。

配置变更通过 settings revision fence 保存，并在 Host 侧 live 更新运行时配置；正在进行的 judge 调用不会被中途替换。真实 provider failure 仍以审批日志中的脱敏 `failure.code/message` 为准；API key 不存入该 namespace。

审判模型是一条**有序候选链**：先试 `provider`/`model`，失败（AUTH/额度/上游 5xx/连接/超时）再依次试 `fallbacks` 里的每一项，按 provider+model 去重。第一个给出回复的候选胜出；全部失败时按**主模型**的失败信息记 `ai-error`（它才是配置意图），并附带 `judgeAttempts`/`judgeTried`。走兜底时成功记录会带 `judgeModel`（实际作答的模型）、`judgeFallbackFrom`（被跳过的主模型）与 `judgeAttempts`。候选链也读同一个 settings namespace 的 `fallbacks` 字段（最多 4 项），修改同样 live 生效；调用方取消（`signal` 已 abort）时不会再花下一次调用。

注意：链只在**provider 层失败**时推进。"模型答了但输出无法解析成 `{risk, authorization, reason}`" 仍按原逻辑走 `failOpen`，不会静默换模型。

上游 `opencode-go` 订阅到期后，`cpa-wx301` 上的 `opencode/*` 模型同样因渠道 `auth_unavailable` 不可用；`ai.fallbacks` 因此默认选 DeepSeek 官方 API（`deepseek-official`，即 DSH 原生 `llm-deepseek` 适配器，走 `DEEPSEEK_API_KEY`），与主模型同属 DeepSeek V4.x 家族但路由独立。

当前 DSH 0.1.2-rc.1 的 `dsh-llm-pi-ai` 安装产物还需要应用工作区中的 `patches/dsh-llm-pi-ai-opencode-session.patch`，让 `opencode-go` 请求把每个会话的 `sessionId` 映射为动态 `x-opencode-session`。该补丁不会影响其他 provider；全局 npm/npx 重装后需要重新应用。

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
      provider: cpa-wx301                      # 本机 CLIProxyAPI（Command Code 通道）
      model: command/deepseek/deepseek-v4.1-flash
      fallbacks:                               # 主模型失败时按序尝试（最多 4 项）
        - provider: deepseek-official          # DSH 原生 llm-deepseek（api.deepseek.com）
          model: deepseek-flash
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
- AI 调用有超时上限（默认 15s，**每个候选各自计时**），失败默认交还人类（fail-open，不会静默全拒）
- 审判候选链只在 provider 层失败时推进；候选全部失败才落到 `failOpen`
- 审批审计对（approval/asked + approval/decided）由 dsh 审批服务持久化，插件只追加自己的决策日志
- `danger-full-access` 模式下沙箱不拒绝任何操作，审批请求不会发生，插件自然空闲
- 单次 AI 审批成本约 0.3~0.7 分钱（官方价估算），仅规则未命中时产生

## 成本

| 场景 | 单次 Token | 单次成本（官方高峰价） |
|---|---|---|
| 典型（短命令） | ~400-500 | ≈ 0.003 元 |
| 最坏（命令 2000 字符） | ~1,500 | ≈ 0.007 元 |

## 版本适配记录（DSH 0.1.5-rc.1）

三处与 0.1.2 不同的地方，都会表现为"设置卡片不见了 / 改了不生效 / 卡片崩了"：

1. **`settings.register()` 返回 owner scope**。0.1.5 里它是 `register(ns, schema, options) → { get, watch, update, replace }`，**服务级没有 `watch`**。旧写法 `settings.watch(...)` 会抛 `TypeError`，又因为包在 try/catch 里，表现为"配置改了要重启才生效"甚至静默失效。现在走返回的 scope，并兼容旧的服务级形状（见 `installConfigSettings` 与 `test/config-settings.test.mjs`）。
2. **客户端 `dsh.client.inject` 要写模块提供者，不是服务名**。`slots` 服务由 `@deepseek-ai/dsh-client-ui-renderer` 的客户端半边提供，模块图里并不存在 `@deepseek-ai/dsh-client-ui-slots` 这一行；写错会导致卡片永不注册，于是"插件配置"标签页里看不到本卡片（该标签页只列出**既注册了卡片、又被 Host 认领**的 namespace）。
3. **`remote.session` 是点号服务名，必须在 cordis `inject` 里显式声明**（DSH 自带的设置面板声明的是 `["slots","locale","remote","remote.credentials","remote.session","settingsScope"]`）。只声明 `remote` 会抛 `cannot get property "remote.session" without inject`；而且 slot 卡片是在**标签页的 fiber** 里渲染的，在那里碰这个代理会直接 `slot entry crashed in 'settings.plugin.item'`，整张卡片消失。所以本插件在自己的 fiber 里把 `modelCatalog()` 解析成普通函数再交给卡片（`client-remote.js`，测试见 `test/client-remote.test.mjs`）。

自查：重启后在浏览器控制台执行

```js
JSON.stringify(window.__DSH_BOOT__).includes('dsh-codex-approval')   // true = 客户端半边已在模块图里
```

插件自身也会把启动证据写进审批日志 `~/.dsh/logs/approval.jsonl`：`{"event":"config-settings","ok":true,"scope":"owner-scope","namespace":"dsh-codex-approval-config",...}` 表示 Host 侧 namespace 注册成功；`ok:false` 会带 `error` 说明原因。

## 开发与测试

```bash
node --test              # 规则、Session API、transcript、deny feedback、AI 裁决、兜底链、模型选择器与浏览器半边冒烟测试
npm run build:client     # 重新构建 lib/client.js（esbuild 经 npx 获取；改 src/client/* 后必须重建）
```

浏览器半边是 esbuild 的 CJS bundle，外面包一层 DSH 的 `window.__ModuleLoader__.load({ id, factory })` 加载壳（`scripts/build-client.mjs` 生成）。React 与 `@deepseek-ai/*` 均为 external，由 Host 的模块加载器提供。`test/client-bundle.test.mjs` 用假加载器 + 极简 React stub 真实渲染卡片，因此改完前端后 `node --test` 能发现产物损坏或渲染异常。

## License

MIT
