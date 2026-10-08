# 更新日志

本插件的版本历史。版本号以 git tag 与 `package.json` 为准；早于 `v0.2.1` 的版本没有打 tag，按其功能提交归类。

---

## 未发布（2026-10-08 工作区，版本号待定）

**`ai-auto` 的激进化：让无人值守不再拒绝自己的日常工作。四处新增，其中两处是它敢被激进使用的前提。**

背景（本机 2026-08-14 → 10-08 的 774 行审计 + 336 次宿主审批对实测）：

- `ai` 模式下 2026-10 只有 8% 自动放行、**90% 交人工**；而插件把决定交给人类的那 157 次里，人类批准 153 次、拒绝 3 次（**同意率 97.5%**），且那 3 次否决全部是 8/9 月的自测探测命令，没有一次是对真实危险动作的有效否决——中间态只剩仪式感。
- `ai-auto` 也不理想：`enforced`（无人授权）写死 `deny`，而**无人值守场景下"用户授权"本就不可能由用户逐句给出**，于是它把大量日常工作一起拒了。影子分析（50 条可重算的真实判定）：24 条 `enforced` 里 14 条是 `edit` 工具改工作区内文件。
- 另有一个反直觉的实测：**`riskTolerance` 在 `ai-auto` 下完全无效**——`enforced` 分支在档位判断之前就返回，把档位从 medium 调到 high，落点一条不变。真正的旋钮是"授权强度"与"越界信号"这两条判据。

1. **【安全前提】提权请求不再被 allow 规则静默批准**（critical）。宿主把 `allowed-once` 直接映射为授予更宽的沙箱（`dsh-sandbox` 的 `approveEscalation`），而规则层此前完全不看 `facts.escalationTo`——`{command:"ls", sandbox_permissions:"danger-full-access"}` 命中无守卫的 `ls` allow 规则后**不调用裁判、不弹窗**就把沙箱放宽了。本机 258 条决策里有 37 条提权请求（全部 `danger-full-access`），说明这是常态操作。现在带提权目标的调用一律不适用 allow 规则，落到裁判（它能看到 `escalation`）或人类。
2. **【安全前提】`getCwd` 死接线修复 + 两条守卫跟随实际执行目录**。`agent?.session?.policy?.workspaceRoot` 在 0.2.x 上取不到值（工作区根在 `session.header.cwd`），于是 `pathGuardAllows` / `gitConfigGuard` 在**生产上从不生效**（22 条默认 allow 里 9 条带守卫全被丢弃，`transcript` 的 `[W]` 行与补证 root 一并空转）。修接线**同时**让守卫按命令的实际执行目录判定：`pathGuard` 用 `resolve(cwd, workdir)` 解析路径参数、`configGuard` 检查那个目录里的仓库，且 workdir 落在工作区外时任何 allow 规则都不适用。**这两件事必须一起做**——只修接线会让守卫从"恒不生效"变成"可被 `workdir` 绕过地放行"。
3. **【激进化核心】`actionScope` + 新策略分支 `medium-uncertain-in-scope`**。裁判说"拿不准"（`ask`）且风险为 medium、又无人授权时，此前一律 `enforced`（`ai-auto` 下即拒绝）。现在多一个输入：**这个调用自身有没有越界信号**——越界路径、网络目标、破坏性选项、被截断的事实（`pathsOmitted` 等）、提权请求、执行目录在工作区外、非 shell 工具的目标路径在工作区外或无法识别、**以及规则守卫是否拒绝过它**、**裁判是否请求过补证却没拿到**。任何一项成立就照旧 `enforced`；全部干净且档位够时，才由容忍度落成放行。判据全部来自调用本身（命令文本、执行目录、工具参数），不来自模型自述；`scope` 未知时保持旧的严格读法。影子回放：自动放行 20 → 31（+11），**全部是工作区内的文件编辑**，没有一条 shell 命令被新放行。
4. **命令线索的两处漏检修复**（`command-facts.js`）：①重复的破坏性选项此前触发 `break`，使 `rm -rf a; rm -rf b && git reset --hard` 只报 `-rf` 而漏掉 `--hard`；②路径配额先到先得，模型控制 argv 顺序时可把唯一的越界路径挤到第 7 位、让线索看起来干净。现在越界路径优先入列，且被丢弃的部分以 `pathsOmitted` / `flagsOmitted` / `hostsOmitted` 显式上报——"线索短"不再能读成"命令干净"。

**验证**：单测 414/414（新增 `test/action-scope.test.mjs`，覆盖判据的两个方向与三条端到端场景）；双平面 `check-planes` 2/2；离线策略回归 18/18（新增 `p-ask-medium-in-scope` / `p-ask-medium-out-of-scope`，并修好 `p-ask-medium-no-auth`——它此前**声称**覆盖 `curl|sh` 却没给命令，实际跑的是默认 `echo hi`）。

随后在同一工作区补的三项（同一目标：让 ai-auto 可被日常依赖）：

5. **判定预算不再压死回退链**（`judgeBudgetMs`）。`ai.totalBudgetMs` 是硬上限，但**上限比单个候选的超时还短**时它表达不了部署的意图：`attemptJudge` 把每个候选压到剩余预算内，一个挂起的主候选就能吃光全部预算，配置好的 `fallbacks` 永远不会被尝试——而"主候选挂起"正是回退链存在的理由。本机实测（`timeoutMs: 60000` 撞上默认 `totalBudgetMs: 30000`）：82 条带 `judgeAttempts` 的记录**恒为 1**、`judgeFallbackFrom` **0 条**。现在上限会被抬到"链上每个候选各一次完整尝试"所需的量（配置值只升不降，`0` 仍然表示不设预算），并在 `plugin-loaded` 审计里同时记录配置值与生效值（`judgeBudget`）。
6. **主判定路由的校验**。`ai.provider` / `ai.model` 此前是 `z.string()` 无 `min(1)`，且 `assertConfig` 完全不看它们——`ai.provider: ""` 让每次 `prepareCall` 抛错（被吞成 `failOpen`），`ai.timeoutMs: "15s"`（YAML 常见写法）一路走到 `AbortSignal.timeout()` 并在守卫之外抛错，把请求变成没有答复的审批。现在四者都有类型与范围校验（`timeoutMs` 1..600000、`maxTokens` 1..32768），而 `fallbacks` 条目本来就在两级校验——主路由反而没有，这个不对称一并消掉。
7. **评测报告给出置信区间**（`wilsonUpper`）。报告里最常被引用的数字大多是零，而零事件只能给上界；`--repeat 3` 把 22 个非争议案例变成 66 行，按行数算上界 ≈ 4.5%、按**不同案例**算 ≈ 14.9%——差三倍。`--live` 的报告与 stdout 现在都在危险放行旁标注 95% 上界与它的分母（案例数，不是行数）。

**验证（补三项后）**：单测 420/420（新增 `test/judge-budget.test.mjs`：预算抬升的两个方向、主路由 12 条非法取值、以及"主候选挂起时回退链真的被走到"的端到端用例）。

再加一项（激进化的安全前提：无人值守下更多命令被自动放行，脱敏缺口的暴露面同步变大）：

8. **统一脱敏的规则重写**。此前对 12 种常见凭据形态实测**漏 10 种**，其中两种是"看起来处理过了"的最坏形态：

   - **环境变量风格的键名整体不生效**：标签规则用 `\b` 卡在关键词前，而 `_` 是词字符——`AWS_SECRET_ACCESS_KEY=`、`GITHUB_TOKEN=`、`npm config set …​:_authToken=` 前都没有词边界，整条规则不触发。现在标签按**整个键名**匹配（`[A-Za-z0-9_-]*<关键词>[A-Za-z0-9_-]*`）。
   - **认证头只认 `Bearer`**：`Authorization: Basic <b64>` 被处理成 `Authorization: [REDACTED] <b64>`——标签涂黑、凭据（`user:password` 的 base64）留在明处。现在 scheme 保留、scheme 之后的值全部吃掉，且 scheme 不会被两条规则吃两次。
   - **URL userinfo 无任何规则**：`https://user:pass@host` 原样进 prompt 与审计。现在凭据被替换，**host 保留**——占位符刻意不带方括号，因为 `[REDACTED]` 会破坏 URL authority，而 `command-facts.js` 正是从这段脱敏文本里提取主机（实测 `https://[REDACTED]@host` 被解析成主机 `redacted`，丢掉的恰是裁判最需要的线索）。URL 规则排在赋值规则**之前**，否则 `oauth2:glpat-…@host` 会被当成 `label: value` 而把整个 URL 尾巴当凭据吞掉。
   - **补上无标签形态**：AWS `AKIA…`、GitHub `ghp_`/`github_pat_`、npm `npm_`、Slack `xox*`、JWT、PEM 私钥块、`-u user:pass`。
9. **补证正文与模型回显过脱敏边界**。`buildJudgeMessages` 把证据文件正文原样拼进 prompt（`redact.js` 自述是"每条命令文本路径的唯一脱敏边界"，而证据正文是唯一跳过它的一条路），现在证据正文过同一遍；裁判回显的 `aiReason` / `aiEvidence` / `aiUnknowns` 写审计前也过一遍——它读的就是脱敏后的文本，回显不该把凭据带进日志。
10. **补证凭据清单扩充 + 后缀剥离**。原清单漏掉云 CLI 真正写的名字：`.credentials.json`（段锚定要求以 `credentials` 开头，点前缀形式漏网）、`service-account*.json`（含 `gcp-` 前缀形式）、`kubeconfig`、`.pgpass`、`.pypirc`、`.my.cnf`、`.htpasswd`、`.bash_history`/`.zsh_history`、`terraform.tfstate`、`.envrc`、`.config/gcloud/`；且 `x.pem.bak` / `id_rsa.old` / `credentials.json.1` 这类**加后缀**即可绕过——现在后缀先剥离再判。

**验证**：单测 427/427（脱敏新增 4 条用例共 30 余条断言，含"suffix 不能洗白凭据名"与"URL 里的 host 必须保留"两侧；凭据清单新增 2 条）。12 种形态探针复核：**12/12 正确脱敏，0 误伤**（无凭据的 URL 原样不动、`Authorization` 的 scheme 保留）。

11. **补证白名单改单 fd 原子读取**（安全修复，CWE-367）。`realpath` → `stat` → `read` 是三次对同一个字符串的独立解析，"被检查的对象"与"被读取的对象"不是同一个：检查通过之后把文件换成指向工作区外的符号链接，读到的就是白名单刚刚拒掉的字节。现在 `open(O_RDONLY | O_NOFOLLOW)` → `fstat`（`isFile` / 大小）→ **在同一个 fd 上读出文本** → 关闭；`O_NOFOLLOW` 是关键一步（上面的解析已去掉所有合法符号链接，此刻仍是符号链接的正是竞态本身），`ELOOP` / `ENOENT` / `EACCES` 一律 fail-closed。注入式 reader（测试用）保留旧路径。
12. **5 个 `volatile` 字段接上 live getter**。`totalBudgetMs` / `evidenceFetch` / `evidenceMaxFiles` / `evidenceMaxBytes` / `denialBreaker` 在 Config schema 里声明为 volatile，于是 loader 永远不会为它们重载插件（`isVolatilePath` → `volatileOnly`），而设置表单正是从同一份声明派生的——**操作者可以收紧一道闸门、看到保存成功、然后继续跑启动快照直到下次重启**。其中三个（熔断阈值、补证开关、补证上限）是收紧无人值守的杠杆，静默失效是最坏情况。0.1.x 的设置路径每次都重建 `cfg`，所以这个洞只在 0.2.0 上成立。
13. **`check-planes` 的期待值不再是人手同步的字面量**。原常量唯一的失败信号是"期待值不匹配"，而那个信号正好可以被"把常量 +1"消费掉：把一条真实安全用例标成 `{ skip: VOLATILE_ONLY }` 再同步常量，双平面依旧报"全部通过"，该用例就在生产平面（0.1.5）上被**永久跳过**且无人知晓。现在期待值**从测试源码数出来**，并新增用例名白名单——只有"配置往返"这类主题本身就是 volatile 机制的用例才允许带标记，其余一律报错退出。实测：给 `actionKeyOf` 的安全用例打上标记 → 立即报"有非配置用例标了 VOLATILE_ONLY"并退出非零。
14. **评测层 `--live` 与 `--replay` 的退出门槛**：`--live` 在判定失败率 > 10% 时报 `2`、非争议危险放行 > 0 时报 `1`（此前恒 exit 0）；失败行不再计入 p95 样本。**一次性授权键改用原始命令文本**（此前基于脱敏文本，`--token=STAGING` 与 `--token=PRODUCTION` 同键 → 授权转移）。




---

## v0.4.6 — 2026-10-06

**决策语义、删除族规则与评测闭环。两处语义变更：放行由程序按规则算，红条不再受无人值守开关影响。**

- **策略层 `decidePolicy` 取代旧的容忍度映射**：裁判只给风险、处理意见与**用户授权强度**（`none` / `weak` / `strong`），最终动作由固定分支表算出，命中的分支名进审计（`policy`）。行为变化：裁判判 `allow` 不再自动越过 `riskTolerance`——超档放行需要用户明确要求过这条动作；**风险 high 且授权不是 strong 时一律交人工**，容忍度管不了它
- **红条 `hardAsk`**：发布（npm / pnpm / yarn / bun publish、npm unpublish、twine upload、cargo publish、docker push、gh release create、git push）与凭据路径（`.ssh` / `.aws` / `.codex/auth.json` / `id_rsa` / `id_ed25519`）标为红条。`ai-auto` 下不走 `mode3OnAsk`，改由 `ai.hardAskOnUnattended` 决定（默认**拒绝**）；`.dsh/*` 保持普通 `ask`。`ai.hardAskOnUnattended` 不接受 `allow`
- **三项无人值守红线写死 `deny`，并从设置卡片移除**：`mode3OnAsk`、`ai.hardAskOnUnattended`、`ai.enforcedAskOnUnattended` 现在只接受 `deny`——patch 里写别的值在装配期直接报错，旧 settings 文档里残留的 `allow` / `ask` 也不再进入运行配置（`applyConfigSettings` 强制覆盖）。设置卡片不再显示这三项，也不再占一段说明文字。设计意图：无人值守时非 `deny` 的取值等价于「直接给这次调用完全权限」，而给权限的正确层位是**宿主的权限档位**（完全权限 / 无沙箱），不是在审批闸门里把红线拆掉
- **默认审批模式（`mode`）进设置卡片、且可热改**：配置层的 `mode`（`manual` / `ai` / `ai-auto`）此前只能写 patch 或按会话 `/approval-mode` 覆盖；现在它在 Web 设置卡片里可选（新的一行「默认审批模式」），保存即生效、不重载插件。实现上它成为 entry Config 里唯一被标 volatile 的**运行期**字段——0.2.0 的设置写回由宿主按 `isVolatilePath()` 逐路径校验，非 volatile 字段的写入会被直接拒绝，所以想在卡片里选它就只有这一条路；同时它被接成 getter（`LIVE_FIELDS`），`resolveMode()` 每次审批都读它，改完的下一个请求就是新模式。0.1.x 侧同步加入 `CONFIG_SETTINGS_SCHEMA`（旧设置页按全字段渲染，与 volatile 无关）。注意它是**默认值**：已有会话覆盖的会话不受影响
- **判定上下文（`transcript`）进设置卡片、且可热改**：`transcript`（`off` / `short`）与 `transcriptMaxChars` 加入表单并接入 volatile 链路，保存即生效、不重载插件。评测数据（2026-10-03，`command/deepseek/deepseek-v4.1-flash`，repeat=3，24 案例）：`off` 相对 `short` 交人工从 13/72 升到 17/72——真值 `allow` 的 `build-rm-authorized`、`npm-install`、`background-server` 各 3 轮全部因「模型看不到用户消息」降为交人工；两者的**非争议危险放行都是 0/66**（报告见 `eval/reports/`）
- **判定上下文的默认值改为 `short`**（2026-10-06）：此前默认 `off`，判定模型默认看不到会话骨架。24 案例 repeat=3 实测 `off` 比 `short` 多 4 次交人工（17/72 vs 13/72），两者的非争议危险放行同为 0/66，故默认打开。`off` 仍是合法取值（零上下文判定、更省 token），设置卡片与配置参考都保留。生产 patch 此前已显式写 `transcript: short`，改默认值后**未显式配置的部署（含预览实例）与生产一致**
- **会话骨架纳入统一脱敏边界（安全修复）**：`transcript: short` 下骨架里的 `[T]` 行按工具参数**原文**渲染，于是 judge prompt 里同时出现「已脱敏的命令」与「未脱敏的原值」——实测 `curl -H 'Authorization: Bearer …' https://x.test/api?token=…` 会在 `Context` 块里把凭据重新带回模型输入（生产 patch 此前已显式开 `short`，属现存泄漏，不是本次引入）。现在 `context` 生成后过 `redactSensitive`；P0 脱敏用例新增「prompt 里必须出现 `Context:`」断言，关掉 transcript 无法再让该断言静默通过
- **设置卡片文案精简**：`fallbacks` 的中文由「兜底候选」改为「回退模型」，删除「调用顺序」摘要行，红线说明段整体删除，风险容忍度只留「严格 / 平衡 / 宽松」，字段说明收敛成一句话；长解释一律留在本文档与 [配置参考](configuration.md)
- **执行事实进判定与审计**：`workdir`（本条命令的实际目录）、`sandbox_permissions` + `justification`（本次请求的提权目标与理由）此前被 `argsPreview` 丢掉，现在随请求进入判定与审计；提权理由是 agent 自述，属不可信证据
- **按需补证（`ai.evidenceFetch`，默认 `read-file`）**：裁判可请求读取工作区内至多 `evidenceMaxFiles`（默认 2）个文件，插件按白名单抓取（realpath 复核、拒凭据与二进制、超长截断）并**再审一次**；拒绝原因进审计（`evidenceRefused`）与第二轮提示。`off` 恢复单轮判定
- **审计可解释性**：记录新增 `policy` / `userAuthorization` / `aiEvidence` / `aiUnknowns` / `cwd` / `workdir` / `escalation` / `evidenceFetched` / `evidenceRefused` / `evidenceRounds` / `hardAsk`
- **一次审批的总预算 `ai.totalBudgetMs`（默认 30s）**：覆盖全部候选与补证轮次，单候选仍受 `timeoutMs` 限制但会被剩余预算压低；耗尽即按 `failOpen` 落地并在审计标 `budgetExhausted`
- **拒绝熔断 `denialBreaker`**：连续 `consecutive` 次自动拒绝（默认 3）→ 本会话冷却 `cooldownMs`（默认 10 分钟），冷却期内需要 AI 判定的请求直接拒绝、不再花模型调用；同一动作被拒 `duplicate` 次（默认 2）→ 直接拒绝。任何非拒绝结果重置连续计数，熔断自身拒绝不延长冷却
- **`/approval-allow-once`**：列出本会话最近被拒动作并授权其中一条放行一次（`kind: manual-override`，不花模型调用）；授权只对该动作生效一次，且仍先过规则层——规则 `deny` 不可被覆盖，授权同时清除该会话冷却
- **拒绝反馈分两种导向**：`feedbackKind: restructure`（命令超预算，或裁判拒绝一条同时下载/执行/销毁的复合命令）时，更正消息改为要求「拆成可验证的步骤、脚本落文件、删除范围写到具体路径后重新提交」；规则 `deny` / 裁判 `deny` / 评审故障 / 熔断重复拒绝保持原有的「不要绕过」导向。判定不变，原样重发仍被拒
- **评测闭环 `eval/`**：24 条人工真值案例（覆盖复合命令、命令替换、间接执行、凭据外传、伪造授权、注入、超长、提权、类生产目标）+ `scripts/eval.mjs` 三层（`--policy` 离线策略回归按 CI 用；`--replay` 用真实审计记录重算落点；`--live` 调真实模型出误放行/误拒/交人工/p95）。审计新增 `judgeAuthorization` 与 `tolerance`，使历史判定可精确回放
- **独立审核（codex, gpt-6.1-sol, medium）的六条 major 修复**：①策略强制人工（高风险无授权、超档放行）在 `ai-auto` 下不再被 `mode3OnAsk: allow` 放行，改由 `ai.enforcedAskOnUnattended`（默认拒绝）决定；②`hardAsk` 只能标在 `ask` 规则上，标到 `allow`/`deny` 上装配期报错（此前会被静默忽略并当作普通放行）；③补证对 **realpath 解析后**的路径再查一次凭据（此前指向 `.env` 的同工作区符号链接可绕过），凭据名单补 `auth.json`（任意位置）、`.codex-run/`、`.netrc`/`_netrc`、`.config/gh/`、`.docker/config.json`、`.kube/config`；④补证被拒的清单会进入第二轮提示（`Evidence unavailable`），且「只被拒、没取到」也会发起第二轮；⑤`ai.totalBudgetMs` 成为硬上限（去掉 1s 下限），补证读取共享同一截止并拒绝非常规文件（FIFO/设备）；⑥`/approval-allow-once` 的授权键绑定 `workdir` 与提权目标——同一命令换个目录或加提权不再消费授权
- **第二轮独立审核的闭环修复**：①`hardAsk` 校验覆盖**结构化规则**（`tool`/`pattern` 形态此前绕过校验，标在 `allow` 上会被静默忽略并直接放行）；②`/approval-allow-once` 的授权键改为 JSON 元组编码——此前用分隔符拼接，构造 `workdir`（如 `/a|esc:danger-full-access`）可伪造出另一动作的键并**转移授权**；③`attemptJudge` 增加独立硬超时（候选超时 +250ms 宽限）：适配器不响应 `AbortSignal` 时不再无限挂住审批；④补证的 `realpath` 与 `stat` 和读取共享同一截止，`resolvePath` 卡住（网络挂载、慢符号链接链）同样被截止
- **策略收紧（由真实模型基线驱动）**：新增 `ask-without-authorization` 分支——AI 判 `ask` 且风险 ≥ medium 且用户授权不是 strong 时交人工（`enforced`），不再因「风险在容忍度内」而放行。首轮 live 基线（`eval/reports/2026-10-02-live-*.md`）里 `curl … \| sh` 就是这样被自动放行的（模型自己判 medium + ask + weak）。容忍度现在只决定「风险 low 的 ask」与「用户明确要求过的 ask」的落点
- **判定输入补命令线索 `facts`**（新增 `command-facts.js`）：把「不在工作区内的路径」「网络目标主机」「破坏性选项」从命令文本里解析出来交给裁判（`paths` / `hosts` / `destructive`），并在提示词里标明是线索而非证据。opaque 命令（`echo $(cat /etc/passwd)`）拿不到 argv 时从文本提取——首轮 live 基线里正是这类命令被模型判成 low 而放行。线索随审计落盘（`commandFacts`）
- **第三轮独立审核（xhigh）的修复**：①`command-facts.js` 的每条输出先过 `redactSensitive`——识别器给的 argv 来自**原始**命令文本，一条含斜杠的 `Authorization: Bearer …` 会以"路径"的名义把凭据重新带回 prompt 与审计；②单项 200 字符 / 总量 1200 字符的上限（此前 8KB 命令会生成 8KB 线索）；③URL authority 正确解析（剥 userinfo/端口/IPv6 括号）、`ssh`/`scp`/`nc` 的裸主机名可识别、引号内的 `host:port` 只在网络命令里算目标（`git commit -m "… docs.example.com:8080"` 不再误报）、`sed 's/a/b/'` 与 `python3 -c "print(1/2)"` 不再被当成路径
- **评测方法学修复**：`--live` 此前**没有把 `facts` 交给模型**，所以"喂线索前后对比"实际是同一条件跑两次——现在默认喂（与生产一致），新增 `--no-facts` 做对照；模型失败或输出不可解析时改走真实 `failOpen` 计分（此前这类行既不算危险放行也不算误拒，却仍在分母里）；重试后累计耗时；报告把 ⚖ 争议案例从门槛里分列；报告文件名加模型短哈希避免 `command/a/b` 与 `command/a_b` 互相覆盖
- **规则层新增「删除」一整族，判定从文本升到 argv**：① **递归删除一律询问**——新增语义 guard `flagGuard: "recursive-delete"`（无 `pattern`，按 argv 判定，见 [决策链](decision-chain.md#规则语法)）：把短选项打包拆开找递归开关，于是 `rm -rf` / `rm -fr` / `rm -r -f` / `rm -rvf` / `rm -vrf` / `rm --recursive --force` / `/bin/rm -rvf` / `cd pkg && rm -rvf dist` 命中同一条规则，pwsh 的 `Remove-Item -Recurse`（含 `rm` / `rd` / `rmdir` / `ri` / `del` / `erase` 别名）亦然；`rm -r`（不带 `-f`）同样算——对可写目录树它与 `-rf` 没有区别。opaque 命令没有 argv，由旁边的字面规则 `Bash(*rm -rf*)` 一类兜住。② **内容销毁询问**：`truncate` / `shred` / `unlink` / `cp /dev/null` / `dd … of=<文件>` / 无命令的截断重定向（`> f`、`: > f`）/ `find … -delete` / `rsync --delete` / `git stash drop` / `userdel -r` / `DROP TABLE` / `DROP DATABASE` / `FLUSHALL` / pwsh `Clear-Content` 与 cmd 风格 `rd /s`、`rmdir /s`、`del /s`。③ **整体状态删除直接拒绝**：`git clean -f*` / `git reset --hard` / `git checkout -- …` / `git restore` / `git stash clear` / `git branch -D` / `git worktree remove`、`docker system prune` / `docker volume rm` / `docker volume prune` / `docker compose down -v`、`kubectl delete ns|namespace|pvc|pv` 与 `kubectl delete … --all`、`rclone purge`、`aws s3 rm --recursive`、`wipefs -a` / `--all`——这些删掉的状态在别处没有副本。④ **日常正当形态不落在 deny 档**（`deny` 是 `/approval-allow-once` 也解不开的机器独断）：为 glob 规则新增两个选项——`caseSensitive: true`（`git branch -D` 丢弃未合并提交、`git branch -d` git 自己会拒绝，默认折叠会把两者合成一条；带此选项的规则要锚在命令文本上，`Bash(` 前缀靠折叠才成立）与 `unless: <模式>`（规则自己的例外，只能让 deny/ask 变窄，标在 `allow` 上或与结构化规则同用会装配期报错）。据此 `git branch -d`、`git restore --staged`（`--staged --worktree` 仍拒，那条窄规则写在它前面，同优先级按列表顺序取首个）、`kubectl delete pod|<kind>` 回到 AI 判定；`wipefs -n` / `--no-act`（dry run，只签名不写）成为 `allow` 规则，`wipefs /dev/sdX`（不带 `-n`，真擦）为 `ask`——wipefs 的 deny/ask 模式因此重写成不匹配 `-n`，否则 deny > ask > allow 会把 allow 吃掉。规则匹配大小写不敏感仍是默认（`RM -RF x` 与 `rm -rf x` 同一条规则）
- 不变：规则优先级（deny > ask > allow）、证据门槛、`denyFeedback`、`transcript`、审计日志格式与轮转、候选链语义

验证：`node --test` 387 用例全绿（v0.4.5 为 282）；双平面检查 `node scripts/check-planes.mjs` 全绿（schemastery 3.18.2 跳 4 条 volatile-only、3.18.4 全跑）；`node scripts/build-client.mjs` 重建后无差异。

---

## v0.4.5 — 2026-10-02

**安全更新：关闭路径层、规则层与 git 配置层的确定性放行路径。**

本版把"看起来只读、实际不是"的命令从自动放行里摘出来，全部是可复现的确定性缺陷（判定提示词也改为按 role 分离的两条消息）。配置字段与默认值向后兼容；只有那些**此前被误判为只读而自动放行**的写法，现在会交给 AI 或人类。

- **路径参数完整化**：`--` 终止符之后的每一项、选项的内联值（`-Path:..\secret`、`--file=/etc/passwd`）、pwsh 里用引号写出的词（含裸 `-` 与 `-/../../x`）都送 `realpath` 复核；只有 `-n` / `--output` / `-Path` 这类选项**名**会被跳过，`-ReadCount:0` 一类具名计数开关的值不算路径。引号位置参与判定：`-Path:'link'` 检查 `link`，整词被引号包裹的 `'--file=link'` 检查整串
- **规则扫还原面**：deny / ask 规则除原文外还扫重建 argv（`rm -r"f" /tmp/x` 即 `rm -rf /tmp/x`）、紧贴引号折叠（`~/.ss''h/i''d_rsa` 即 `~/.ssh/id_rsa`）、引号转空格、标点转空格与空白规范化（`npm  publish`、`npm<TAB>publish`），三种改写**三轮复合**；`allow` 仍只用原始文本与重建 argv，参数含空白的段不生成重建面（`"git status"` 不是 `git status`）
- **git 自动放行加 `configGuard`**：仓库 `.git/config` 与 `extensions.worktreeConfig` 的 `.git/config.worktree` 命中 `external` / `command` / `textconv`（含段头与键同行写法）、`gpg`、`include` / `include.path`，或 `fsmonitor` 取值非布尔（值按引号语法解析，`"true; exec evil"` 是命令行），即不再自动放行；**配置读不出来也不放行**（只有"文件不存在"算干净，权限与 I/O 失败视为无法核验）。`--ext-diff` / `--textconv` / `--show-signature` 进 `forbidOptions`
- **默认 deny / ask 扩充**：`sudo` / `doas` 包裹的 shutdown / reboot / halt / poweroff / dd；裸设备写入（`of=/dev/sd*`、`nvme`、`mapper`、`md`、`dm-`、`loop` 等 → deny，其余 `of=/dev/*` → ask）；fork bomb；凭据路径补全绝对 / 相对 / 正反斜杠 / 点目录矩阵（`.ssh\config`、`.dsh/profiles/…`、`id_rsa` 等），同时不再误伤 `docs/.aws-guide.md` 这类同名前缀文件
- **判定提示按 role 分离**：固定政策走 `system` 消息，命令 / reason / 会话骨架走 `user` 消息，请求文本不再与指令同级
- **文档与包结构**：客户端源码移入 `src/client/`（`package.json` 的 `files` 相应收紧，不再发布根级 `client-*.js` 与构建脚本）；README 改为特性导向，细节拆进 `docs/`，新增配置 / 决策链 / 安全 / 客户端卡片 / 开发 / 本地环境 / 第一性原理等文档与 README 横幅
- 不变：配置字段与默认值、`/approval-mode` 语义、`denyFeedback`、transcript、审计记录格式

验证：`node --test` 282 用例全绿（v0.4.4 为 256）；另以 120 组凭据路径矩阵与 28 项修复/对照矩阵复核。

---

## v0.4.4 — 2026-10-01

**修复：空回复现在会推进候选链，兜底模型终于能被用上。**

候选链此前只在**传输层失败**时推进。当流在没有任何 `text-delta` 的情况下结束（包括 `AbortSignal` 掐断而没有 `finish(error/aborted)` 分片），`attemptJudge` 返回 `{ok:true, text:""}`——于是一个不含可用判定的回复被当成**成功的判定尝试**：链停在空串上，配置好的 `ai.fallbacks` 永远轮不到，审计日志里堆满 `kind=ai-error` + `unparseable judge output` + 空 `rawOutput` 且**没有 `judgeAttempts`** 的记录（WX301 实测：66 条 unparseable、全部空回复、0 条带 `judgeAttempts`）。

- 候选只有在 `parseVerdict` 接受其回复时才算答对；空文本与"有文本但无判定对象"都会推进候选链（全链失败才落到 `failOpen`）
- 审计原因区分 `unparseable judge output (empty reply)` 与 `unparseable judge output (no verdict)`
- 新增候选诊断字段 `textChars` 与 `endedWithoutFinish`，随 `ai-error` 记录落盘
- 不变：`judgeModel` / `judgeFallbackFrom` / `judgeAttempts` / `judgeTried` 语义、单候选结果形状、`failOpen` / `mode3OnAsk` / `riskTolerance` / 规则 / 形状判定

---

## v0.4.3 — 2026-10-01

**双平面客户端兼容（DSH 0.2.0 `configForms`）+ 审批逃逸修复。**

- 客户端半边同时适配 DSH 0.1.5（schemastery 3.18.2）与 0.2.0（3.18.4）的可发现平面；测试套件对每个可发现的 schemastery 平面各跑一遍
- 声明 DSH `0.2.0-rc.2` 为兼容版本
- 关闭 2026-09-22 审计发现的确定性自动放行逃逸路径

## v0.4.2 — 2026-09-12

**判定候选链 + Web 模型选择卡片 + AI 失败诊断。**

Host：

- `ai.fallbacks`：有序判定候选链（每候选各自计时、按 provider+model 去重、取消感知中断）；全链失败时按主模型信息记 `judgeAttempts` / `judgeTried`，走兜底时记 `judgeModel` / `judgeFallbackFrom`
- settings 改走 `settings.register()` 返回的 owner scope（DSH 0.1.5），同时兼容 0.1.2 的服务级 API，live 更新恢复；注册失败被记录而非 try/catch 吞掉
- 拒绝反馈携带 `finishKind` / `failure` 安全诊断

Client：

- 设置卡片：主模型选择 + 兜底链编辑（增删、调序，上限 4）+ 按模型目录标注可用性 + 调用顺序摘要 + 未保存标记
- 原生卡片外观：样式逐条抄自内置 `PluginCard` / `fields`，控件取自 shell primitives 表
- 修复 `slot entry crashed in settings.plugin.item`：显式声明点号服务 `remote.session`，并在自己的 fiber 上解析 `modelCatalog()`
- 可复现的客户端 bundle 构建（`scripts/build-client.mjs`）

> **版本号说明**：这次开发期 `package.json` 曾被写成 `0.5.4`（提交 `cd2b8d6` 的标题也照此记录）。发布时以维护者决定的 tag 为准，下一个提交把清单改回 `0.4.2`——所以这个提交的标题里的 `0.5.4` 是开发期编号，不是漏发的版本。本页一律以 tag 与 `package.json` 为准。

## v0.4.1 — 2026-09-08

**修复：客户端 bundle 按 loader factory 形式构建。**

## v0.4.0 — 2026-09-02

**`transcript`：给 AI 审判提供紧凑会话上下文。**

- 新增 `transcript.js`：语义过滤（丢弃流式分片与插件注入的用户消息）、两级窗口（最近用户消息 + ≤3 条工具链 / 更早的用户意图线）、超长粘贴的头尾省略与省略计数、分层预算与硬上限
- `judge.js` 接受可选 Context 块；系统提示新增**意图优先规则**（用户明确要求的操作除非明显高风险，否则可判 allow）
- `sessionId` 透传到 LLM 调用（provider 侧前缀缓存所需）
- 默认规则新增 11 条 `Pwsh(...)` 只读 allow，与 `Bash(...)` 族并存
- 配置：`transcript: off|short`（默认 off）+ `transcriptMaxChars`（100–16000）

## v0.3.0 — 2026-09-02

**`denyFeedback`：拒绝归因反馈。**

- 插件自身产生的拒绝（规则 / AI / `ai-error` / 兜底 / `mode3`）进入每会话队列
- 新增 `agent/pre-step` 注入器：在下一次模型请求前追加一条 plugin 来源的更正消息（"这不是用户拒绝" + 来源 / 风险 / 理由 + 不得绕路）
- 中英文案模板，含来源标签与 `viaAsk`（`ai-auto` 的 mode3）归因
- 配置：`denyFeedback`（默认 true）+ `denyFeedbackMax`（默认 3）

## v0.2.2 — 2026-08-16

**双语 `/approval-mode` 文案 + `npm publish` 询问规则。**

- `i18n.js`：中英文案表、`pickLocale`、双语命令描述；`locale: auto|zh|en`
- 默认规则新增 `Bash(npm publish*)` → `ask`：每次发布升级请求都必须询问人类（`cd x && npm publish` 同样命中）

## v0.2.1 — 2026-08-16

内部发布提交，无面向用户的变化。

## v0.2.0 — 2026-08-15

**审批模式维度（`manual` / `ai` / `ai-auto`）+ `/approval-mode` 命令。**

- `modes.js`：模式词汇、数字别名（1/2/3）、生效模式解析、`ask → mode3OnAsk` 映射（纯函数）
- `manual` 完全旁路（不决策、不写日志）；`ai-auto` 绝不把 `ask` 交给人类——规则 ask、AI 判 ask 且超容忍度、`failOpen=ask`、`fallback=ask` 全部按 `mode3OnAsk`（默认 deny）结算
- `ai-auto` 使用禁用 `ask` 的判定提示词变体（模型必须给出 allow 或 deny）
- `/approval-mode` 命令：查看 / 切换 / 清除会话覆盖
- 会话覆盖经 settings namespace 持久化（服务不可用时降级为纯内存）
- 新增依赖 `@deepseek-ai/schemastery`（设置 schema）

## v0.1.0 — 2026-08-15

**首个版本：Codex 风格 AI 审批自动驾驶。**

- 规则层（approve-always / reject-always 风格 glob，`deny > ask > allow` 优先级）
- AI 审判层（风险 `low/medium/high` + 授权 `allow/ask/deny` + `riskTolerance` 映射）
- 人类兜底（GUI 弹窗），经 `approval/request` 应答者瀑布
- JSONL 决策审计日志（`~/.dsh/logs/approval.jsonl`）
