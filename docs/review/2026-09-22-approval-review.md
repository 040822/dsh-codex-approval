**dsh-codex-approval 审查记录 · 2026-09-22**

审查快照：`3ad6e7d`，package.json 版本 `0.4.2`；同时核对本机 DSH `0.1.5-rc.1` 的审批和沙箱实现。

结论：项目已实现“用独立模型替代部分人工提权审批”的基本流程。规则优先级、一次性放行、默认交人兜底、候选模型切换、拒绝归因反馈都有实现。但默认规则存在确定性的越权放行路径；在修复这些路径和建立真实模型评测前，不宜将它视为可靠的自动审批安全边界。

验证：现有 `npm test` 为 197/197 通过；额外的隔离复现脚本确认了 15 条观察。所有危险命令仅作为字符串送入本项目函数，没有执行命令、访问凭据或调用真实 LLM。项目源码和 Git 工作区未改动。

**已确认的实现问题，按修复优先级排列**

1. **P1：默认 allow 规则会放行复合命令、重定向和敏感文件读取。**

   [默认规则](/home/wenxin/office/dsh/plugins/dsh-codex-approval/index.js:54) 使用 `Bash(git status*)`、`Bash(cat *)`、`Bash(echo *)` 等模式；[匹配器](/home/wenxin/office/dsh/plugins/dsh-codex-approval/rules.js:78) 对整段字符串执行 glob，不理解 shell 语法、选项和文件目标。

   已复现以下请求均返回 `allowed-once`，AI 调用次数为 0：

   - `git status; rm -rf /tmp/dsh-audit-placeholder`
   - `echo $(touch /tmp/dsh-audit-placeholder)`
   - `cat /dev/null > /tmp/dsh-audit-placeholder`
   - `cat ~/.ssh/id_rsa`
   - `git diff --output=/tmp/dsh-audit-placeholder`
   - PowerShell 的 `Get-ChildItem .; Remove-Item ... -Recurse -Force`

   deny 优先级只对“已经匹配上的规则”有效，不能阻止被 allow 前缀包住的危险子命令。应先移除这些宽泛默认 allow；只对能够完整解析、校验所有子命令/选项/重定向/目标路径的操作进行确定性放行。Bash 和 PowerShell 需要分别处理；未知结构交给审批，不能用简单分号切分替代语法分析。

2. **P1：命令在规则匹配前已经截断，强制 ask 可以被截掉。**

   [handler](/home/wenxin/office/dsh/plugins/dsh-codex-approval/index.js:409) 先调用 `argsPreview(..., maxPromptChars)`，再把同一预览送给规则和 AI；[截断实现](/home/wenxin/office/dsh/plugins/dsh-codex-approval/enrich.js:87) 默认只保留前 2000 字符。

   对 `echo ` + 2200 个字符 + `; npm publish`，完整输入命中 publish 的 `ask`；真实 handler 截断后命中 echo 的 `allow`。即使修好复合命令规则，模型仍会看不到被截断的危险尾部。

   原始审批载荷必须完整保存并参与规则判定。日志/UI 预览与审批输入分开；模型无法容纳完整操作时，应转人工或拒绝自动放行，并记录“证据不完整”。

3. **P1：设置页的风险容忍度说明与实现相反。**

   [UI 文案](/home/wenxin/office/dsh/plugins/dsh-codex-approval/src/client/DshCodexApprovalCard.tsx:56) 将 low 标成“尽量放行”，high 标成“尽量询问”。[实际映射](/home/wenxin/office/dsh/plugins/dsh-codex-approval/judge.js:143) 恰好相反：high 会把所有风险等级的 `ask` 映射成 allow；low 只放行 low-risk 的 ask。

   用户按文案选择更保守的选项，实际会扩大放行范围。应修正文案，并增加验证选项语义的测试；同步重建发布用 `lib/client.js`。

4. **P1：无法恢复工具参数时仍可自动放行。**

   [参数恢复](/home/wenxin/office/dsh/plugins/dsh-codex-approval/enrich.js:40) 失败返回 null；[handler](/home/wenxin/office/dsh/plugins/dsh-codex-approval/index.js:409) 没有完整性门槛，仍然调用模型，[输入](/home/wenxin/office/dsh/plugins/dsh-codex-approval/judge.js:54) 中变成 `command: null`。

   用缺失 callId 对应事件的请求和返回 allow 的模拟模型，已复现最终 `allowed-once`。这证明程序没有阻止“未审到具体操作也能批准”；没有测量真实模型遇到此输入的放行概率。

   提权审批应要求工具身份和完整操作可验证；参数缺失、解析失败、身份不匹配应进入明确的不可自动批准状态。长期应让宿主直接传递不可变的规范化请求，减少通过历史日志反查的依赖。

5. **P1：凭据脱敏没有覆盖正常审批数据路径。**

   [日志与反馈](/home/wenxin/office/dsh/plugins/dsh-codex-approval/index.js:474) 直接保存 `argsPreview`、`reason` 和拒绝命令；模型输出失败时还会记录 `rawOutput`。现有 `redactSensitive` 主要用于 provider 错误。

   使用明确的假 Bearer 值，已确认原值同时出现在审批模型输入、审计记录和拒绝反馈。实际命令若带密钥，则会复制到额外模型/日志路径，即使操作最终被拒绝也是如此。

   应建立统一脱敏边界，覆盖参数、reason、transcript、aiReason、rawOutput 和反馈，保留风险判断所需的凭据类型、文件路径、目标域名等信息；日志采用明确的私有权限和保留策略。fallback 模型也应满足同一数据处理要求。

6. **P2：审批过程中取消请求，不会取消模型链。**

   [调用 judgeWith](/home/wenxin/office/dsh/plugins/dsh-codex-approval/index.js:431) 漏传 `signal: req.signal`，尽管 runner 已支持取消；handler 也没有在 await 后重新检查取消状态。

   已复现 runner 收到 undefined signal，请求取消后插件仍记录并返回 `allowed-once`。本机 DSH 的 [宿主取消保护](/home/wenxin/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-user-approval/lib/index.js:175) 会把外层审批解析为 cancelled，所以不能据此断言命令仍会执行。实际问题是无效模型开销、可能继续调用 fallback、错误审计和过时的拒绝反馈。

7. **P2：短上下文选中了较早的调用，且正常分支没有结果行。**

   [窗口选择](/home/wenxin/office/dsh/plugins/dsh-codex-approval/transcript.js:156) 从最近用户消息向“较新的事件”方向取最先遇到的三条工具调用。一次用户消息后有 step-1 到 step-5 时，输出 step-3、step-2、step-1，漏掉最近的 step-4、step-5。包含用户消息的正常分支只收 tool，不收 result，与 README 中的 `[R]` 描述不一致。

   当前待批命令仍会单独发送给模型；丢失的是解释该命令来由的最近历史。应明确时序，选最新的关联调用，按 callId 关联必要证据；是否接收原始工具输出需要单独设计信任边界。

8. **P2：`rules: []` 不能关闭规则。**

   [normalizeConfig](/home/wenxin/office/dsh/plugins/dsh-codex-approval/index.js:193) 将空数组重新替换为 32 条默认规则。希望“全部交给 AI”而清空规则的用户，仍会保留默认自动放行。应区分未配置与显式空数组。

9. **P2：含互相冲突裁决的模型输出仍会被接受。**

   [parseVerdict](/home/wenxin/office/dsh/plugins/dsh-codex-approval/judge.js:79) 会从多对象输出中选取第一个合法对象。已复现先 allow、后 deny 的输出被解释为 allow；现有测试还将此行为固定下来。

   对审批协议，建议要求单个符合 schema 的对象；多裁决、未正常完成的流、未知字段组合等情况明确降级。修复时要同时覆盖输出解析与流完成状态。

**策略设计与现代 agent 的差距**

现有审批接入点方向正确：宿主授予单次操作，插件充当 answerer；只有实际产生审批请求的操作会到达插件。沙箱内本就允许的操作不会经过这里，默认 publish 规则也不能保证拦截所有发布。Codex 的 Auto-review 同样围绕既有审批边界工作；需要额外拦截沙箱内敏感行为时，应增加宿主工具审批策略。[OpenAI 官方 Auto-review 文档](https://learn.chatgpt.com/docs/sandboxing/auto-review)

| 维度 | 当前实现 | 建议目标 |
|---|---|---|
| 风险、授权与决策 | `authorization` 实际是 allow/ask/deny；AI allow 可越过 riskTolerance | 分开记录风险、用户授权证据、目标和副作用，由确定性策略生成最终结果 |
| 用户意图 | transcript 默认 off；reason 来自主 agent | 默认提供经过筛选的真实用户指令，并为授权引用消息 ID；agent 自述只作为待核实理由 |
| 硬性边界 | 部分 glob 规则；ai-auto 可把 ask 统一转 allow | 不可覆盖的 deny、必须人工的 ask、普通不确定性分别建模；保护审批配置和凭据路径 |
| 提示注入防护 | 固定提示和全部输入拼成一条 user 消息 | 使用 DSH 支持的 system/system-role 通道，明确不可信证据，防止命令/工具结果改变审批政策 |
| 拒绝恢复 | 已有归因反馈和最近拒绝记录 | 增加连续拒绝熔断、按风险对象检测重复尝试、明确 timeout/cancel/deny 差异 |
| 模型质量 | 同一接口可选任意模型；fallback 解决可用性 | 固定评测门槛，按风险升级复核；所有候选满足相同安全及数据要求 |
| 运行与审计 | JSONL、总耗时、部分模型信息 | 记录请求摘要/hash、策略/提示/模型版本、原始裁决与最终策略、全部候选错误、人工覆盖和预算 |

风险映射尤其需要明确产品语义：[decideAuthorization](/home/wenxin/office/dsh/plugins/dsh-codex-approval/judge.js:143) 当前有意允许 `{risk: high, authorization: allow}` 在 tolerance=low 时通过，也会把 `{risk: medium, authorization: ask}` 在默认容忍度下改成 allow。这是既定策略行为，不能简单称为编码失误；但它意味着 riskTolerance 不是硬上限，ask 也不一定意味着必须确认。应拆分“有无授权”和“是否建议确认”，并为高风险放行要求可核对的授权证据。

Codex 官方说明将用户授权与风险共同用于决策，高风险需要足够授权，critical 风险拒绝；构造、审查和解析失败不执行操作。[OpenAI 官方审批与安全说明](https://learn.chatgpt.com/docs/agent-approvals-security)

上下文不宜一味增加。Codex 审批员可见紧凑会话和相关工具证据，并可做只读检查；Claude Code 的公开设计则刻意排除 assistant 自述和原始工具输出，以降低被 agent 的理由或间接注入影响的机会。可以根据 DSH 的接口选择方案，但必须保留来源和可信度。[Codex 审批输入说明](https://learn.chatgpt.com/docs/sandboxing/auto-review)、[Anthropic 自动模式设计](https://www.anthropic.com/engineering/claude-code-auto-mode)

README 中“输出只映射三种结果，因此不存在注入面”的表述应删除：枚举校验限制了输出格式，无法防止模型被诱导选择 allow。本次已确认输入混在 user 消息和缺少可信授权的事实，未进行真实模型的提示注入成功率测试。[相关代码](/home/wenxin/office/dsh/plugins/dsh-codex-approval/judge.js:54)

拒绝后的边界也应更清楚。Codex 已有拒绝熔断以及针对确切动作、限定一次重试的人工覆盖；Claude Code 当前文档同样区分强制人工规则和普通模型决策。这支持将 `hardAsk` 与 `uncertain` 分开，避免 `mode3OnAsk=allow` 顺带覆盖发布确认等强制约束。[Codex 拒绝与覆盖](https://learn.chatgpt.com/docs/sandboxing/auto-review)、[Claude Code 权限模式](https://code.claude.com/docs/en/permission-modes)

**建议实施顺序**

1. 先修安全相关确定性问题：宽泛 allow、截断、缺参放行、UI 反向文案、凭据复制。同步修复取消传播、上下文窗口、空规则和歧义裁决，并加入针对这些缺陷的回归测试。
2. 建立独立 policy 模块：输入为完整审批请求、可信用户授权和模型评估；输出为明确的 allow / human-required / deny / unavailable。AI 不修改硬性规则。策略、配置和请求在一次审批期间使用可追踪的版本。
3. 建立离线风险数据集和 shadow 模式：覆盖复合命令、替换、重定向、选项副作用、符号链接、跨目录路径、编码/解释器调用、生产操作、凭据外传、伪造授权和长输入；测量危险误放行、正常误拒绝、p95 延迟和成本，再决定模型与快慢两阶段策略。
4. 完善宿主接口：结构化传递工具参数、cwd、目标路径/域名、当前权限和申请的权限变化；必要时增加受限只读核验。把配置保护、敏感工具审批和最小权限授予交给宿主强制执行。
5. 增加拒绝熔断、限次人工覆盖、provider 熔断和总审批 deadline；5 个候选各自 15 秒，可能把一次审批拖长至约 75 秒，需要整体预算约束。

**复现材料**

- [隔离复现脚本](/tmp/dsh-approval-audit-probes.mjs)，运行 `node /tmp/dsh-approval-audit-probes.mjs`。
- [现有测试运行日志](/tmp/dsh-codex-approval-review-tests.log)。

本次没有验证真实模型准确率、完整浏览器交互或真实提权执行。安全相关结论来自源码、实际 DSH 宿主接口和无副作用的函数级复现。
