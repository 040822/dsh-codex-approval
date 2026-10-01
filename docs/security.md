# 安全模型与边界

本文说明本插件**做了什么**保护、**没做什么**，以及哪些路径需要使用者自己权衡。

## 安全机制

- **deny 规则永远最先求值**，AI 无权覆盖显式拒绝
- **形状闸门**：命令文本不是"单条纯命令"就绝不被 allow 规则放行（复合命令 / 重定向 / 命令替换 / 变量 / 通配 / 控制流全部交 AI 或人类）
- **原文进判**：规则与 AI 看到的是完整命令；截断只用于日志与 UI 预览
- **证据门槛**：参数缺失 / 无法解析 / 命令超预算 → 不问 AI，直接交人类（`ai-auto` 下直接拒绝），审计标 `evidenceIncomplete`。这是"没看到操作"，不是"AI 判定不确定"，因此不受 `mode3OnAsk` 影响
- **统一脱敏**：命令与 reason 在进入 AI prompt、审计日志、拒绝反馈前一律脱敏；插件新建的审计日志为 `0600` 并按 `logMaxBytes` 轮转（**已存在的旧日志权限不会被自动改动**）
- **AI 调用有超时上限**（默认 15s，每个候选各自计时），失败默认交还人类（fail-open，不会静默全拒）
- **取消传播**：审批期间取消会传播给模型链（`signal`），取消的请求审计为 `cancelled`，不会留下过时的 `allowed-once`
- **审计对由宿主持久化**：`approval/asked` + `approval/decided` 由 dsh 审批服务写入，插件只追加自己的决策日志

## 拒绝归因（`denyFeedback`）

**问题**：dsh 的沙箱层把一切审批拒绝硬编码为 "the user rejected..."（`dsh-sandbox` 的 `approveEscalation`）。插件 AI 拒绝时，主 agent 会误以为**你本人**否决了——于是道歉、停下，或盲目重试，而不是带理由去找更安全的路径。

**方案**：插件在自身产生拒绝（规则 deny / AI deny / `ai-auto` 的 mode3 拒绝 / AI 故障 `failOpen=deny` / 兜底 deny）后，把拒绝记录进内存队列；下一次 `agent/pre-step`（模型即将推理）时向消息列表追加一条**更正消息**（`user` 角色 + `source.kind: "plugin"`，机制同 dsh-time-context / dsh-tool-cordis）：

```
[auto-review] The previous action `rm -rf /tmp/x` was denied by the automatic
approval reviewer (source: deterministic rule) — this was NOT a user rejection.
Do not pursue this action via workaround or indirect execution; continue with
a materially safer alternative, or stop and ask the user.
```

- 被拒工具的 `tool/result` 错误与更正消息出现在**同一次模型推理**中（紧邻），模型可完成正确归因
- 用户手动拒绝（GUI 弹窗）不经过插件 answerer，**不会被标记为自动审批拒绝**
- 模型被拒后立即结束回合时，更正留在队列，**下一回合首步注入**（消息持久化在会话中，重启后不重复注入）
- 每会话未注入队列上限 `denyFeedbackMax`（默认 3，超限丢最旧）

配置：`denyFeedback: true|false`（默认 true）；文案跟随 `locale` 设置（zh / en）。**已知边界**：源头文案（"the user rejected"）由 dsh 核心生成，本功能通过紧邻的更正消息覆盖模型感知，并非源头级修正。

## 已知边界（不是安全保证）

- **枚举校验只约束 AI 输出的格式**，不能保证裁判不受提示注入影响。因此固定政策与不可信请求文本分开处理，且 `authorization` 仍要过规则层
- **形状闸门是保守识别器，不是 shell 解析器**。它只回答"这条命令能否信任其 argv"，**不做子命令拆分**；无法覆盖所有间接副作用
- **真正不可绕过的边界是沙箱与宿主工具审批策略**。规则里的 `deny` 是加速拒绝，不是沙箱强制
- **`danger-full-access` 模式下插件自然空闲**：沙箱不拒绝任何操作 → 不产生审批请求 → 插件没有介入点。想让它生效，请保持在 `read-only` 或 `workspace-write`
- **严格 JSON 解析会安全回退**，但完整替换判定提示词会自行承担丢失此约束的风险

## ⚠️ 不要同时装多个审批裁决插件

**本插件不检查权限档位（preset）。** 它只认自己的审批模式（`manual` / `ai` / `ai-auto`），对 `approval/request` 的裁决发生在 `approval/policy = ask` 时，**任何**档位下都一样——`handler` 入口只检查 `cfg.enabled` 与 `mode`，没有任何 `permissionPresets` 判定。（对比官方 `dsh-experimental-auto-review`：它在 `tools/pre-execute` 上先判 `permissionPresets.current(session) !== AUTO_PRESET` 就 `next()`。）

这条差异带来两种真实的冲突形态。

### 1）层叠冲突——上游的「需要人工」被下游 AI 重新裁决

`tools/pre-execute` 是 waterfall，返回 `kind: "ask"` 会触发 `dsh-tools` 的 `approval.request()`；本插件 prepend 在人类答复者之前，因此有权把该审批答成 `allowed-once`，请求就不会到达人工 UI。

官方 Auto review 正是这种上游：它按效果分级（low 直接允许、medium 需当前人类或直接父级明确授权、high 始终拒绝），`medium` 时返回 `ask` 交给审批链。若该档位的 `approval` 策略为 `ask`，而本插件同时处于 `ai` 模式，本插件的 AI 层会**重新裁决**这一请求，可能直接判 allow 放行——官方 review 刚做出的"需要人工授权"判定被静默吃掉，且用户看不到弹窗。

### 2）抢答——同接缝多答者，先应答者独占

所有直接监听 `approval/request` 的插件（`gbthui/dsh-auto-review`、`@quill507/dsh-auto-approval-llm`、`ZhuRuoLing/dsh-command-approve-for-me` 等）与本插件同接缝。waterfall 语义是**第一个返回结果的答者独占决策槽位，后来者收不到该请求**（Cordis `waterfall()` 源码注释："a listener that does not call `next()` vetoes the rest of the chain"）。

启动时用 `{ prepend: true }` 注册的答者被 `unshift` 到监听器数组头部、先被调用；多个插件都 prepend 时，**实际胜负由 bundle 加载顺序决定**（后注册的 prepend 排更前）。被旁路的一方**静默失效——不报错、不告警**。

### 建议

- 同一 profile **只装一个**审批裁决插件
- 与官方 `@deepseek-ai/dsh-experimental-auto-review` **不要并用**：前者的"需要人工"判定可能被后者重新裁决，而本插件的 `denyFeedback` 归因更正只覆盖插件自身产生的拒绝，管不到这种被吃掉的场景
- 已经装了第二个插件时，暂停本插件最省事的方式是 `/approval-mode manual`（完全旁路）或把会话权限档切回 `Workspace Write`，无需卸载

> 验证记录（2026-10-01，DSH 0.2.0-rc.2）：Cordis waterfall 语义与注册顺序已由源码与官方 cordis-plugin-development 文档（"waterfall listeners can rewrite and **depend on registration order**"）确认；本机唯一性问题已实测。**真实双插件抢答尚未在本机复现**（需引入第二个裁决插件并重启），上述胜负结论由源码推导。
