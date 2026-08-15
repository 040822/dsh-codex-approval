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
