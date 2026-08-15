/**
 * dsh-codex-approval — modes.js
 *
 * The approval-mode dimension, orthogonal to the dsh sandbox mode:
 *
 *   manual   — plugin fully bypassed (next() straight through, no decision,
 *              no audit): the pre-plugin experience.
 *   ai       — rules, then AI judge, then human fallback for every "ask"
 *              outcome (the default / v0.1.x behavior).
 *   ai-auto  — rules, then AI judge; "ask" is never routed to a human —
 *              it resolves through mode3OnAsk (default deny).
 *
 * Pure functions only: parse/validate mode names, resolve the effective mode
 * (per-session override wins over the config default), and map an "ask"
 * outcome onto its effective action under the active mode.
 */

/** The three approval modes. */
export const MODES = ["manual", "ai", "ai-auto"];
/** Numeric aliases mirroring the user-facing 1/2/3 choice. */
export const MODE_ALIASES = { "1": "manual", "2": "ai", "3": "ai-auto" };
/** Actions an "ask" may resolve to. */
export const ASK_ACTIONS = ["ask", "deny", "allow"];

/**
 * Parse and validate a mode name (or numeric alias).
 * @param input - "manual" | "ai" | "ai-auto" | "1" | "2" | "3"
 * @returns the canonical mode name, or null when invalid.
 */
export function parseMode(input) {
	if (typeof input !== "string") return null;
	const trimmed = input.trim().toLowerCase();
	if (MODES.includes(trimmed)) return trimmed;
	if (MODE_ALIASES[trimmed] !== void 0) return MODE_ALIASES[trimmed];
	return null;
}

/**
 * Resolve the effective mode for one request: per-session override wins,
 * else the config default.
 * @param sessionOverride - mode from the per-session store (or undefined)
 * @param configDefault - the configured default mode
 * @returns a canonical mode name (never null when configDefault is valid).
 */
export function resolveMode(sessionOverride, configDefault) {
	return parseMode(sessionOverride) ?? parseMode(configDefault) ?? "ai";
}

/**
 * Map an "ask" outcome onto its effective action under the active mode.
 * - manual: unreachable (handler bypasses); defensive "ask".
 * - ai: "ask" — route to the human (next()).
 * - ai-auto: mode3OnAsk — the human is never asked; default deny.
 * @param mode - effective mode
 * @param mode3OnAsk - "deny" | "allow" (validated config; anything else
 *   falls back to "deny")
 * @returns "ask" | "deny" | "allow"
 */
export function effectiveOnAsk(mode, mode3OnAsk) {
	if (mode === "ai-auto") return mode3OnAsk === "allow" ? "allow" : "deny";
	return "ask";
}
