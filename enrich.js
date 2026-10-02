/**
 * dsh-codex-approval — enrich.js
 *
 * Best-effort recovery of the full tool-call arguments behind an approval
 * request. The approval seam hands answerers only `{ toolName, callId,
 * reason }`, but the session log's latest `assistant/message` contains the
 * complete `tool-call` content part (id, name, arguments JSON) — so by
 * `callId` we can recover e.g. the exact bash command that triggered a
 * sandbox escalation, which is what rule matching and the AI judge see.
 *
 * Everything here is defensive: any shape drift or missing data returns
 * null / a degraded preview, never throws.
 */

/**
 * Find the parsed tool-call arguments for a callId in a session event list.
 * @param events - a Session-like object (`snapshotEvents()`/`ownEvents()`) or any event array
 * @param callId - the approval request's callId
 * @returns the parsed arguments object, or null when unrecoverable.
 */
/**
 * Read session events across the legacy and current DSH Session APIs.
 * @param sessionOrEvents - a Session-like object or an event array
 * @returns an event array; never throws
 */
export function getSessionEvents(sessionOrEvents) {
	try {
		if (Array.isArray(sessionOrEvents)) return sessionOrEvents;
		const candidate = typeof sessionOrEvents?.snapshotEvents === "function"
			? sessionOrEvents.snapshotEvents()
			: typeof sessionOrEvents?.ownEvents === "function"
				? sessionOrEvents.ownEvents()
				: sessionOrEvents?.events;
		return Array.isArray(candidate) ? candidate : [];
	} catch {
		return [];
	}
}

export function findToolCallArgs(events, callId) {
	if (callId === undefined || callId === null) return null;
	const list = getSessionEvents(events);
	if (list.length === 0) return null;
	for (let i = list.length - 1; i >= 0; i -= 1) {
		const event = list[i];
		if (event === null || typeof event !== "object" || event.type !== "assistant/message") continue;
		const content = event.data?.message?.content;
		if (!Array.isArray(content)) continue;
		for (let j = content.length - 1; j >= 0; j -= 1) {
			const part = content[j];
			if (part === null || typeof part !== "object" || part.type !== "tool-call") continue;
			if (part.id !== callId) continue;
			try {
				return JSON.parse(part.arguments ?? "null");
			} catch {
				return null;
			}
		}
	}
	return null;
}

/** Shell tools whose call arguments carry execution-location and escalation facts. */
const SHELL_TOOLS = new Set(["bash", "pwsh"]);

/**
 * The execution facts of a shell call that the approval seam does not carry but
 * the tool arguments do.
 *
 * The approval request handed to answerers is only `{ toolName, callId,
 * reason }`; everything else has to be recovered from the call's arguments.
 * For a shell call those arguments additionally answer three questions the
 * judge needs and cannot guess:
 *   - `workdir` — the directory THIS command runs in (the session cwd is only
 *     the default; a call may override it, and a relative value resolves
 *     against the session workspace).
 *   - `sandbox_permissions` / `justification` — the widening this exact call
 *     requests (DSH requires the pair together: a target mode plus one
 *     sentence of justification). This is the "permission change" dimension:
 *     the judge must weigh the intended effect under the WIDER mode.
 *   - `run_in_background` — whether the command outlives the approval turn.
 *
 * `justification` is the agent's own statement: it travels as untrusted
 * evidence and is never treated as user authorization.
 *
 * @param args - parsed tool arguments (or null)
 * @param toolName - the tool that was called
 * @returns a facts object, or null when there is nothing to add/not a shell call
 */
export function shellCallFacts(args, toolName) {
	if (!SHELL_TOOLS.has(toolName)) return null;
	if (args === null || typeof args !== "object") return null;
	const facts = {};
	if (typeof args.workdir === "string" && args.workdir.trim() !== "") facts.workdir = args.workdir;
	if (typeof args.sandbox_permissions === "string" && args.sandbox_permissions.trim() !== "") facts.escalationTo = args.sandbox_permissions;
	if (typeof args.justification === "string" && args.justification.trim() !== "") facts.justification = args.justification;
	if (args.run_in_background === true) facts.background = true;
	return Object.keys(facts).length === 0 ? null : facts;
}

/**
 * Build the arguments text: the raw command for bash/pwsh, compact JSON
 * otherwise.
 *
 * Two callers with different needs share this function:
 *   - rule matching and the judge prompt pass **no** `maxChars`, so the whole
 *     operation is judged. Truncating first is what let `echo <2200 chars>;
 *     npm publish` slip past the publish rule — the dangerous tail was cut
 *     before any rule saw it.
 *   - the audit record and the UI pass `maxChars` for a bounded *display*
 *     preview only.
 * @param args - parsed tool arguments (or null)
 * @param toolName - the tool that was called
 * @param maxChars - display cap; omit it (or pass a non-finite value) to keep
 *   the whole text.
 */
export function argsPreview(args, toolName, maxChars) {
	let preview;
	if (args !== null && typeof args === "object") {
		if ((toolName === "bash" || toolName === "pwsh") && typeof args.command === "string") {
			preview = args.command;
		} else {
			try {
				preview = JSON.stringify(args);
			} catch {
				preview = String(args);
			}
		}
	} else if (args === undefined || args === null) {
		preview = "";
	} else {
		preview = String(args);
	}
	if (Number.isFinite(maxChars) && preview.length > maxChars) preview = `${preview.slice(0, maxChars)}…`;
	return preview;
}
