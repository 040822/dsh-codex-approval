# 更新日志

本插件的版本历史。版本号以 git tag 与 `package.json` 为准；早于 `v0.2.1` 的版本没有打 tag，按其功能提交归类。

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
