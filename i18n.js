/**
 * dsh-codex-approval — i18n.js
 *
 * zh/en copy for the /approval-mode command. The host reads the user's
 * locale preference from the dsh settings service (`locale.preference`,
 * owned by dsh-client-locale, persisted in settings.yaml); without a value
 * (or without settings at all) the copy falls back to English.
 *
 * Pure functions only: pick the locale, render command texts.
 */

export const LOCALES = ["zh", "en"];

/**
 * The full message table. Keys are identical across locales so a missing
 * translation fails loudly in tests rather than silently at runtime.
 */
export const T = {
	zh: {
		showWithOverride: (effective, override, configDefault) =>
			`当前模式：${effective}（会话覆盖：${override}，配置默认：${configDefault}）`,
		showNoOverride: (effective, configDefault) =>
			`当前模式：${effective}（配置默认：${configDefault}，无会话覆盖）`,
		cleared: (configDefault) => `已清除会话覆盖 → 回落 ${configDefault}（配置默认）`,
		clearedMemoryOnly: (configDefault) => `已清除会话覆盖 → 回落 ${configDefault}（配置默认；settings 不可用，仅内存）`,
		switched: (mode) => `已切换 → ${mode}（本会话）`,
		switchedMemoryOnly: (mode) => `已切换 → ${mode}（本会话；settings 不可用，重启后丢失）`,
		unknown: (input) => `未知模式 "${input}" — 用 manual | ai | ai-auto（或 1/2/3），或用 default 清除覆盖`
	},
	en: {
		showWithOverride: (effective, override, configDefault) =>
			`mode: ${effective} (session override: ${override}, config default: ${configDefault})`,
		showNoOverride: (effective, configDefault) =>
			`mode: ${effective} (config default: ${configDefault}, no session override)`,
		cleared: (configDefault) => `override cleared → ${configDefault} (config default)`,
		clearedMemoryOnly: (configDefault) => `override cleared → ${configDefault} (config default; memory-only: settings unavailable)`,
		switched: (mode) => `switched → ${mode} (this session)`,
		switchedMemoryOnly: (mode) => `switched → ${mode} (this session; memory-only: settings unavailable, lost on restart)`,
		unknown: (input) => `unknown mode "${input}" — use manual | ai | ai-auto (or 1/2/3), or "default" to clear the override`
	}
};

/**
 * Pick the command copy locale from a raw preference value.
 * @param pref - settings `locale.preference` (e.g. "zh", "en", or undefined)
 * @returns "zh" | "en" — valid values pass through; anything else → "en"
 */
export function pickLocale(pref) {
	return pref === "zh" ? "zh" : "en";
}

/** The command description for the given locale (registered once at boot). */
export function commandDescription(locale) {
	return locale === "zh"
		? "显示或切换审批模式（manual | ai | ai-auto，或 1/2/3）"
		: "Show or switch the approval mode (manual | ai | ai-auto, or 1/2/3)";
}

/**
 * Human-readable denial-source labels, keyed per locale. Every source the
 * plugin can stage in a denial record must have a label in both locales
 * (rule / ai / ai-error / fallback) so renderDenialNotice never leaks a raw
 * internal kind to the model.
 */
const SOURCE_LABELS = {
	zh: {
		rule: "确定性规则",
		ai: "AI 评审",
		"ai-error": "AI 评审故障兜底（failOpen）",
		fallback: "兜底策略",
		breaker: "拒绝熔断"
	},
	en: {
		rule: "deterministic rule",
		ai: "AI judge",
		"ai-error": "AI judge failure fallback (failOpen)",
		fallback: "fallback policy",
		breaker: "rejection breaker"
	}
};

/**
 * The denial-feedback copy table. Renders one staged denial into the exact
 * corrective message the `agent/pre-step` injector appends to the next model
 * request. Keys are identical across locales so a missing translation fails
 * loudly in tests rather than silently at runtime.
 */
const NOTICE = {
	zh: {
		deniedByReviewer: (cmd) => `[auto-review] 上一个操作 ${cmd} 被自动审批评审拒绝——这不是用户的拒绝。`,
		unknownCommand: "（未知命令）",
		sourceLine: (src, risk) => `来源：${src}${risk !== void 0 ? `；风险：${risk}` : ""}`,
		viaAsk: "（全自动模式下 \"ask\" 被解析为 \"deny\"，未经过人类确认）",
		failure: (kind, failure) => `评审调用失败：${kind ?? "unknown"}${failure?.code !== undefined ? `（${failure.code}）` : ""}${failure?.message !== undefined ? `：${failure.message}` : ""}`,
		rationale: (text) => `评审理由：${text}`,
		rationaleMissing: "未提供评审理由。",
		directive: "不要通过变通手段或间接执行绕开该操作；请改用实质更安全的替代方案，或停下来询问用户。",
		restructure: "这个操作**不是不能做**，而是**这样提交无法审查**：请拆成若干条可验证的步骤重新提交——把下载与执行分开、把要执行的逻辑写进脚本文件并把脚本交给审查、把删除或清理的范围写到具体路径。重新提交的必须是实质更小、更容易验证的方案，不是同一条命令的改写。"
	},
	en: {
		deniedByReviewer: (cmd) => `[auto-review] The previous action ${cmd} was denied by the automatic approval reviewer — this was NOT a user rejection.`,
		unknownCommand: "(unknown command)",
		sourceLine: (src, risk) => `Source: ${src}${risk !== void 0 ? `; risk: ${risk}` : ""}`,
		viaAsk: " (denied by the auto mode default: \"ask\" resolved to \"deny\" without a human)",
		failure: (kind, failure) => `Review call failed: ${kind ?? "unknown"}${failure?.code !== undefined ? ` (${failure.code})` : ""}${failure?.message !== undefined ? `: ${failure.message}` : ""}`,
		rationale: (text) => `Review rationale: ${text}`,
		rationaleMissing: "No rationale was provided.",
		directive: "Do not pursue this action via workaround or indirect execution. Continue with a materially safer alternative, or stop and ask the user.",
		restructure: "This action is not forbidden — it cannot be REVIEWED as submitted. Re-submit it as separate verifiable steps: split fetching from executing, put the logic to run into a script file and hand the script over, and name the exact paths you intend to remove or clean. The re-submission must be materially smaller and easier to verify, not a rewording of the same command."
	}
};

/**
 * Render one staged denial record into a corrective paragraph.
 * @param record - { command, source, match?, risk?, aiReason?, finishKind?, failure?, viaAsk? }
 * @param t - the locale's NOTICE table
 * @returns the paragraph text (no trailing newline).
 */
function renderNoticeOne(record, t, locale) {
	const command = record.command === undefined || record.command === ""
		? t.unknownCommand
		: `\`${record.command}\``;
	const src = (SOURCE_LABELS[locale] ?? {})[record.source] ?? record.source;
	const lines = [
		t.deniedByReviewer(command),
		t.sourceLine(src, record.risk) + (record.viaAsk === true ? t.viaAsk : ""),
		record.failure !== undefined
			? t.failure(record.finishKind, record.failure)
			: record.aiReason !== undefined
				? t.rationale(record.aiReason)
				: t.rationaleMissing
	];
	return lines.join("\n");
}

/**
 * Render staged denials into the single corrective message injected before
 * the next model step. Multiple denials render in order, separated by a blank
 * line, each prefixed; the closing directive is emitted once at the end.
 * @param queue - staged denial records (1..denyFeedbackMax).
 * @param locale - "zh" | "en".
 * @returns the full message text.
 */
export function renderDenialNotice(queue, locale) {
	const t = NOTICE[locale] ?? NOTICE.en;
	const body = queue.map((record) => renderNoticeOne(record, t, locale)).join("\n\n");
	const directive = queue.some((record) => record.feedbackKind === "restructure") ? t.restructure : t.directive;
	return `${body}\n${directive}`;
}

/**
 * `/approval-allow-once` copy: list the recent denials of this session and let
 * the human approve exactly one of them for a single retry. The grant is a
 * one-shot consumed by the next identical action, and the rule layer still runs
 * first — a rule `deny` is never overridden by a human override either.
 */
const ALLOW_ONCE = {
	zh: {
		listHeader: "最近被自动审批拒绝的动作（最近在前）：",
		listLine: (index, command, source, time) => `${index}. ${command}（来源：${source}${time === undefined ? "" : `，${time}`}）`,
		listFooter: "用 /approval-allow-once <编号> 授权其中一条放行一次：仍会先过规则层（规则 deny 不可覆盖），且只对同一动作生效一次。",
		empty: "本会话还没有被自动审批拒绝的动作。",
		granted: (command) => `已授权一次：${command} —— 下一次相同动作会自动放行一次，之后需要重新授权。`,
		unknown: (input) => `未知编号 "${input}"：先运行 /approval-allow-once 查看列表。`,
		unknownCommand: "（未知命令）"
	},
	en: {
		listHeader: "Recently denied actions (newest first):",
		listLine: (index, command, source, time) => `${index}. ${command} (source: ${source}${time === undefined ? "" : `, ${time}`})`,
		listFooter: "Run /approval-allow-once <number> to approve one for a single retry: the rule layer still runs first (a rule `deny` cannot be overridden), and the grant applies once to that exact action.",
		empty: "No action has been denied by the automatic reviewer in this session yet.",
		granted: (command) => `Approved once: ${command} — the next identical action runs without asking; after that the grant is spent.`,
		unknown: (input) => `Unknown number "${input}" — run /approval-allow-once to see the list.`,
		unknownCommand: "(unknown command)"
	}
};

/** The `/approval-allow-once` command description for the given locale. */
export function allowOnceCommandDescription(locale) {
	return locale === "zh"
		? "列出被自动审批拒绝的动作，并授权其中一条放行一次"
		: "List denied actions and approve one for a single retry";
}

/** Local clock time for a denial record, or undefined when it has no timestamp. */
function formatClock(ts, locale) {
	if (typeof ts !== "number" || !Number.isFinite(ts)) return undefined;
	try {
		return new Date(ts).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", { hour12: false });
	} catch {
		return undefined;
	}
}

/**
 * Render the allow-once list. The records arrive oldest-first (the denial ring
 * buffer) and are listed newest-first, so number 1 is always the most recent
 * denial the command would grant.
 * @param list - denial records, oldest first
 * @param locale - "zh" | "en"
 */
export function renderAllowOnceList(list, locale) {
	const t = ALLOW_ONCE[locale] ?? ALLOW_ONCE.en;
	const labels = SOURCE_LABELS[locale] ?? SOURCE_LABELS.en;
	const lines = list.map((record, offset) => {
		const command = record.command === undefined || record.command === ""
			? t.unknownCommand
			: `\`${record.command}\``;
		const source = labels[record.source] ?? record.source;
		return t.listLine(offset + 1, command, source, formatClock(record.ts, locale));
	});
	return [t.listHeader, ...lines, t.listFooter].join("\n");
}

/** "Nothing to approve yet" copy. */
export function renderAllowOnceEmpty(locale) {
	return (ALLOW_ONCE[locale] ?? ALLOW_ONCE.en).empty;
}

/** Confirmation after a grant. */
export function renderAllowOnceGranted(command, locale) {
	const t = ALLOW_ONCE[locale] ?? ALLOW_ONCE.en;
	const shown = command === undefined || command === "" ? t.unknownCommand : `\`${command}\``;
	return t.granted(shown);
}

/** "That number is not in the list" copy. */
export function renderAllowOnceUnknown(input, locale) {
	return (ALLOW_ONCE[locale] ?? ALLOW_ONCE.en).unknown(input);
}
