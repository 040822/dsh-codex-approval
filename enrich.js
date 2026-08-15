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
 * @param events - session.events (or any event array)
 * @param callId - the approval request's callId
 * @returns the parsed arguments object, or null when unrecoverable.
 */
export function findToolCallArgs(events, callId) {
	if (!Array.isArray(events) || callId === undefined) return null;
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const event = events[i];
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

/**
 * Build the Codex-style args preview used for rule matching and the AI
 * prompt: the raw command for bash/pwsh, compact JSON otherwise.
 * @param args - parsed tool arguments (or null)
 * @param toolName - the tool that was called
 * @param maxChars - preview length cap
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
	if (preview.length > maxChars) preview = `${preview.slice(0, maxChars)}…`;
	return preview;
}
