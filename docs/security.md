# 安全模型与边界

本文说明本插件**做了什么**保护、**没做什么**，以及哪些路径需要使用者自己权衡。

## 安全机制

- **deny 规则永远最先求值**，AI 无权覆盖显式拒绝
- **形状闸门**：命令文本不是"单条纯命令"就绝不被 allow 规则放行（复合命令 / 重定向 / 命令替换 / 变量 / 通配 / 控制流全部交 AI 或人类）
- **路径参数完整**：`--` 终止符之后的每一项、以及内联在选项里的值（`-Path:..\secret` / `--file=/etc/passwd`）都算路径参数，不能靠"看起来像选项"躲过 `pathGuard`
- **规则扫还原面**：除原始文本外还匹配"裸参数文本"、"重建 argv"与（deny/ask 专用的）"折叠紧贴引号 + 规范化空白"，`npm  publish`、`rm -r"f" /tmp/x`、`npm<TAB>publish 2>log` 与它们的常规写法同样命中（见[决策链与规则语法](decision-chain.md#规则语法)）
- **删除的判据在 argv 上，不在拼写上**：`flagGuard: "recursive-delete"` 把短选项打包拆开（`-rvf` → `r`/`v`/`f`）再找递归开关，所以 `rm -rf` / `rm -fr` / `rm -r -f` / `rm -rvf` / `rm --recursive --force` / `cd pkg && rm -rvf dist` 命中同一条规则，pwsh 的 `Remove-Item -Recurse` 亦然——换个字母顺序、换个路径前缀都绕不过去。它只加严格性（标在 `allow` 上、或与 `pathGuard` 等同用会在装配期报错），opaque 命令没有 argv，由旁边的字面规则兜住
- **deny 只落在「人类在场也改变不了结果」的形态上**：整体状态删除（`git clean -fdx`、`kubectl delete pvc`、`rclone purge`、`wipefs -a`）是 `deny`，而形式相同、后果不同的日常形态由 `caseSensitive`（`git branch -D` vs `-d`）与 `unless`（`git restore` vs `--staged`）从 deny 里摘出去，回到 AI 判定——`deny` 是 `/approval-allow-once` 也解不开的机器独断，不该覆盖人天天要做的事
- **`configGuard`**：`git diff` / `git log` / `git status` 的自动放行要求仓库 `.git/config`（以及 `extensions.worktreeConfig` 下的 `.git/config.worktree`）里没有 `external` / `command` / `textconv` 键、没有 `gpg` 配置、没有 `[include]` / `include.path`、且 `fsmonitor` 值只为布尔 —— 这些让一条只读命令无需任何开关就执行别处指定的程序（或被包含文件里的同名键）。**配置读不出来就不放行**：只有"不存在"算干净，权限/I-O 失败视为无法核验；`.git` 是 worktree/submodule 指针文件时同样不放行。用户级 `~/.gitconfig` 不在检查范围（属使用者自己的环境）
- **固定政策与证据分属两条消息**：判定提示是 `system` 消息，命令 / reason / 会话骨架 / 补证内容是 `user` 消息——请求文本无法冒充指令层级
- **判定能看到结构化的命令线索**：越界路径、网络目标主机、破坏性选项由 `command-facts.js` 从命令**文本**解析后交给裁判（`facts`），提示词标明它们只是线索、不是核验结果——"看不到的仍是未知"这条不因线索而放松
- **执行事实进判定**：`workdir`（本条命令的实际执行目录）与本次请求的提权目标 / 理由随请求进入判定与审计；提权理由是 agent 自己写的，属不可信证据，**从不作为用户授权**
- **红条不受无人值守开关影响**：`hardAsk` 规则（发布、凭据）在 `ai-auto` 下由 `ai.hardAskOnUnattended` 决定，而它**写死 `deny`、不接受配置**；`hardAsk` 只能标在 `ask` 规则上，标到 `allow` 上在装配期就报错（否则它会读成「人类已确认」，与原意相反）
- **「没有用户授权」同样不受无人值守开关影响**：高风险且用户未明确要求的动作、AI 放行但超出档位的动作、以及 **AI 自己拿不准（ask）且风险 ≥ medium 又没人授权**的动作，在 `ai-auto` 下由 `ai.enforcedAskOnUnattended` 决定，同样**写死 `deny`、不接受配置**；`mode3OnAsk` 也只接受 `deny`。要在无人值守时放开权限，正确层位是宿主的权限档位（完全权限 / 无沙箱），不是把这几条红线配成 `allow`/`ask`
- **重构请求只改文案，不改判定**：`feedbackKind: restructure`（超长命令、混合副作用的复合命令）只影响拒绝后的更正消息，让它要求"拆分后重新提交"；判定仍是拒绝，同一条命令原样重发仍被拒，不会变成借此获得放行
- **熔断只减少付费，不产生许可**：冷却期与同动作阈值的拒绝是 `deny`，绝不会被当作放行；`/approval-allow-once` 的授权是**人工**决定，且仍先过规则层（规则 `deny` 不可覆盖），只对一个动作生效一次
- **审批不会被卡死**：单次判定有独立硬超时（候选超时 +250ms 宽限），适配器不响应取消信号也不会挂住审批；补证的路径解析、`stat` 与读取共享审批自身的截止
- **一次性授权不可转移**：授权键是（工具、实际目录、提权目标、命令全文）的 JSON 元组哈希——改目录、加提权、或伪造分隔符都产生不同的键，人工签字只对它签的那一个动作生效
- **补证是白名单只读**：裁判只能请求工作区内的文件——realpath 复核、拒凭据文件与二进制、超长截断并标注，拒绝原因同时进审计与第二轮判定；插件不给裁判 shell、目录列举或任意读盘能力
- **原文进判**：规则与 AI 看到的是完整命令；截断只用于日志与 UI 预览
- **证据门槛**：参数缺失 / 无法解析 / 命令超预算 → 不问 AI，直接交人类（`ai-auto` 下直接拒绝），审计标 `evidenceIncomplete`。这是"没看到操作"，不是"AI 判定不确定"，因此不受任何无人值守开关影响（`mode3OnAsk` / `hardAskOnUnattended` / `enforcedAskOnUnattended` 三项都已写死 `deny`）
- **统一脱敏**：命令、reason、提权理由与会话骨架（`transcript: short` 的 `Context` 块，含 `[U]` / `[T]` 行）在进入 AI prompt、审计日志、拒绝反馈前一律脱敏；插件新建的审计日志为 `0600` 并按 `logMaxBytes` 轮转（**已存在的旧日志权限不会被自动改动**）
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

- **策略层的「用户授权」来自模型**：程序保证的是「没有 strong 授权就不自动放行高风险」，但 `user_authorization: strong` 是模型对用户消息的判断，模型可能高估——衡量这一点需要真实模型评测集。`eval/` 已建立三层（`--policy` 离线策略回归 / `--replay` 审计回放 / `--live` 真实模型，报告在 `eval/reports/`），但现有基线只有 24 条人工真值案例、且只覆盖 `command/*` 模型族，不等于对全部候选模型都有保证
- **裁判模型不遵循新 schema 时更保守**：`user_authorization` 缺失按「不是 strong」处理，结果是高风险一律交人工——更安全，也更打扰；更换模型或兜底模型后审批尺度会变
- **枚举校验只约束 AI 输出的格式**，不能保证裁判不受提示注入影响。role 分离（政策 `system` / 证据 `user`）削弱了"命令文本冒充指令"的路径，但削弱不等于消除，且 `authorization` 仍要过规则层
- **role 分离依赖宿主与上游接受 `system` 消息**：DSH 会把 `system` 透传给 provider；若某模型的通道会把 system 映射成 `developer` 而该上游不接受（此前实测 opencode 系通道即如此），需要在模型配置上声明 `compat: { supportsDeveloperRole: false }`，否则判定调用直接 400（走 failOpen）
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
