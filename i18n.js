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
		fallback: "兜底策略"
	},
	en: {
		rule: "deterministic rule",
		ai: "AI judge",
		"ai-error": "AI judge failure fallback (failOpen)",
		fallback: "fallback policy"
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
		rationale: (text) => `评审理由：${text}`,
		rationaleMissing: "未提供评审理由。",
		directive: "不要通过变通手段或间接执行绕开该操作；请改用实质更安全的替代方案，或停下来询问用户。"
	},
	en: {
		deniedByReviewer: (cmd) => `[auto-review] The previous action ${cmd} was denied by the automatic approval reviewer — this was NOT a user rejection.`,
		unknownCommand: "(unknown command)",
		sourceLine: (src, risk) => `Source: ${src}${risk !== void 0 ? `; risk: ${risk}` : ""}`,
		viaAsk: " (denied by the auto mode default: \"ask\" resolved to \"deny\" without a human)",
		rationale: (text) => `Review rationale: ${text}`,
		rationaleMissing: "No rationale was provided.",
		directive: "Do not pursue this action via workaround or indirect execution. Continue with a materially safer alternative, or stop and ask the user."
	}
};

/**
 * Render one staged denial record into a corrective paragraph.
 * @param record - { command, source, match?, risk?, aiReason?, viaAsk? }
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
		record.aiReason !== undefined
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
	return `${body}\n${t.directive}`;
}
