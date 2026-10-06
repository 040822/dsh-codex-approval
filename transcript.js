/**
 * dsh-codex-approval — transcript.js
 *
 * Compact-session-transcript builder (`transcript: "short"`). Turns the live
 * session event stream into a bounded, skeletonized context block for the AI
 * approval judge, so the judge can see user intent and the surrounding tool
 * chain — not just the bare command.
 *
 * Pipeline:
 *   1. semantic filter   — keep only user/message, tool-calls, tool/results,
 *                          turn markers; drop streaming chunks and plugin-
 *                          sourced user messages (denyFeedback / time-context
 *                          injections must never be fed back to the judge).
 *   2. two-level window  — short window (the ≤3 NEWEST tool calls after the
 *                          recent user message, plus each call's result status)
 *                          rendered in full skeleton, the newest user message
 *                          last as the intent anchor; long window (older user
 *                          messages only) as an intent line.
 *                          Result lines carry the exit status only: successful
 *                          stdout is dropped (raw tool output is an indirect
 *                          prompt-injection surface), failure text is bounded.
 *   3. head/tail truncation — overlong messages keep head + tail with an
 *                          elision counter (error-report pastes: head =
 *                          action, tail = crux, middle = noise).
 *   4. budget tiers      — total bounded by transcriptMaxChars; overflow
 *                          drops lowest-priority items first (denial history
 *                          → cwd → oldest long-window entries).
 *
 * Pure functions only; everything defensive, never throws into the
 * approval path.
 */

/** Head/tail caps per item class, in chars. */
const CAPS = {
	shortUser: { head: 600, tail: 600 },   // the most recent user message (P0)
	longUser: { head: 120, tail: 80 },     // older intent-line entries (P2)
	tool: { head: 200, tail: 0 }           // tool-call arguments (P1)
};

/** Elide the middle of an over-long text: `head…〔省略 N 字符〕…tail`. */
export function truncateMiddle(text, headChars, tailChars) {
	if (typeof text !== "string" || text.length <= headChars + tailChars) return text;
	const head = text.slice(0, headChars);
	const tail = tailChars > 0 ? text.slice(text.length - tailChars) : "";
	const omitted = text.length - headChars - tailChars;
	return omitted > 0
		? `${head}…〔省略 ${omitted} 字符〕…${tail}`
		: text;
}

/**
 * Extract the text of a user/message event. Returns "" for non-text shapes.
 */
function userText(data) {
	const content = data?.content;
	if (Array.isArray(content)) {
		return content
			.filter((part) => part?.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join(" ");
	}
	if (content && content.type === "text" && typeof content.text === "string") return content.text;
	return "";
}

/**
 * Pair every `tool/result` with the tool call it answers. The session log's
 * `tool/result` event carries no `callId` (only turn/step/message/error), so
 * results are matched FIFO to the tool calls that precede them in event order.
 * @param list - the raw event list in chronological order
 * @returns Map<event index, callId>
 */
function pairResultsToCalls(list) {
	const paired = new Map();
	const pending = [];
	for (let i = 0; i < list.length; i += 1) {
		const event = list[i];
		if (event === null || typeof event !== "object") continue;
		if (event.type === "assistant/message") {
			const content = event.data?.message?.content;
			if (!Array.isArray(content)) continue;
			for (const part of content) {
				if (part?.type === "tool-call" && part.id !== undefined) pending.push(part.id);
			}
		} else if (event.type === "tool/result") {
			const callId = pending.shift();
			if (callId !== undefined) paired.set(i, callId);
		}
	}
	return paired;
}

/**
 * Collect semantic items from the raw event stream, newest first.
 * Plugin-sourced user messages and streaming chunks are excluded here.
 * @param events - a Session-like object or event array
 * @returns array of { seq, kind, ... } with seq counting only semantic items
 *   (newest first, so index 0 is the most recent). Tool and result items carry
 *   a `callId` so a window can pull the result of a specific call.
 */
export function collectSemanticItems(events) {
	const list = Array.isArray(events)
		? events
		: typeof events?.snapshotEvents === "function"
			? (() => { try { return events.snapshotEvents(); } catch { return []; } })()
			: typeof events?.ownEvents === "function"
				? (() => { try { return events.ownEvents(); } catch { return []; } })()
				: Array.isArray(events?.events)
					? events.events
					: [];
	if (!Array.isArray(list)) return [];
	const callIdByIndex = pairResultsToCalls(list);
	const items = [];
	for (let i = list.length - 1; i >= 0; i -= 1) {
		const event = list[i];
		if (event === null || typeof event !== "object") continue;
		const type = event.type;
		if (type === "user/message") {
			const source = event.data?.source;
			const kind = source?.kind;
			if (kind === "plugin" || (typeof kind === "string" && kind.startsWith("plugin:"))) continue; // never feed injections back
			const text = userText(event.data);
			if (text === "") continue;
			items.push({ seq: items.length, kind: "user", text, time: event.time });
		} else if (type === "assistant/message") {
			const content = event.data?.message?.content;
			if (!Array.isArray(content)) continue;
			for (const part of content) {
				if (part?.type !== "tool-call") continue;
				const args = typeof part.arguments === "string" ? part.arguments : "";
				items.push({ seq: items.length, kind: "tool", name: part.name, args, callId: part.id, time: event.time });
			}
		} else if (type === "tool/result") {
			const msg = event.data?.message;
			const error = event.data?.error;
			const text = typeof msg?.text === "string" ? msg.text
				: Array.isArray(msg?.content)
					? msg.content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join(" ")
					: "";
			items.push({
				seq: items.length,
				kind: "result",
				callId: callIdByIndex.get(i),
				ok: error === undefined,
				errorCode: error?.code,
				text: text === "" ? "" : truncateMiddle(text, 120, 60),
				time: event.time
			});
		}
	}
	return items;
}

/**
 * Render a semantic item to one skeleton line.
 */
export function renderItem(item) {
	if (item.kind === "user") {
		const elided = truncateMiddle(item.text, CAPS.shortUser.head, CAPS.shortUser.tail);
		return `[U] 用户: ${elided}`;
	}
	if (item.kind === "tool") {
		const args = truncateMiddle(item.args ?? "", CAPS.tool.head, CAPS.tool.tail);
		return `[T] ${item.name}(${args})`;
	}
	if (item.kind === "result") {
		const marker = item.ok ? "→ ok" : `→ error${item.errorCode ? ` (${item.errorCode})` : ""}`;
		// Successful stdout is deliberately dropped: raw tool output is an
		// indirect prompt-injection surface, and the exit status is what the
		// judge actually needs. Only failure text survives, bounded.
		const extra = item.ok || item.text === "" ? "" : ` ${truncateMiddle(item.text, 80, 40)}`;
		return `[R] ${marker}${extra}`;
	}
	return "";
}

/**
 * Build the compact transcript for the judge.
 *
 * @param opts - {
 *   events,            session.events
 *   cfg,               plugin config (uses transcriptMaxChars)
 *   denialHistory,     Map<sessionId, Array<...>> — recent denials (≤5 kept)
 *   sessionId,         for denial history lookup
 *   mode, tolerance,   effective mode / risk tolerance lines
 *   mode3OnAsk, cwd,   optional context lines
 * }
 * @returns the bounded transcript text; "" when there is nothing to show.
 */
export function buildTranscript({ events, cfg, denialHistory, sessionId, mode, tolerance, mode3OnAsk, cwd } = {}) {
	const maxChars = cfg?.transcriptMaxChars ?? 4000;
	const items = collectSemanticItems(events);
	if (items.length === 0) return "";

	// Two-level window split (items are newest-first: index 0 is the most
	// recent semantic item, and lower indexes are NEWER than the user message).
	const firstUserIdx = items.findIndex((item) => item.kind === "user");
	const shortItems = [];
	const longUsers = [];
	let intentItem = null;
	if (firstUserIdx !== -1) {
		intentItem = items[firstUserIdx];
		// Short window: the newest user message (rendered last, as the intent
		// anchor) plus the ≤3 NEWEST tool calls that followed it, each with its
		// paired result status. Walking indexes upward from 0 visits newest
		// first — walking downward (the old behaviour) selected the *oldest*
		// three of the recent calls and dropped the ones that explain the
		// request being judged.
		const windowTools = [];
		for (let i = 0; i < firstUserIdx && windowTools.length < 3; i += 1) {
			if (items[i].kind === "tool") windowTools.push(items[i]);
		}
		const wantedCalls = new Set(windowTools.map((item) => item.callId).filter((id) => id !== undefined));
		const windowResults = [];
		if (wantedCalls.size > 0) {
			const seenCalls = new Set();
			for (let i = 0; i < items.length; i += 1) {
				const item = items[i];
				if (item.kind !== "result" || item.callId === undefined) continue;
				if (!wantedCalls.has(item.callId) || seenCalls.has(item.callId)) continue;
				seenCalls.add(item.callId);
				windowResults.push(item);
			}
		}
		shortItems.push(...[...windowTools, ...windowResults].sort((a, b) => b.seq - a.seq));
		// Long window: every older user message (intent line), capped per entry.
		for (let i = items.length - 1; i > firstUserIdx; i -= 1) {
			if (items[i].kind === "user") {
				longUsers.push(truncateMiddle(items[i].text, CAPS.longUser.head, CAPS.longUser.tail));
			}
		}
	}
	// Fallback: no user message at all (e.g. fresh session) — keep recent tools.
	const fallbackTools = firstUserIdx === -1
		? items.filter((item) => item.kind === "tool" || item.kind === "result").slice(0, 4)
		: [];

	// Build sections in stable-prefix order (oldest first) for prefix caching.
	const sections = [];
	if (mode !== undefined) {
		const modeLine = `mode: ${mode}${tolerance !== undefined ? `, tolerance: ${tolerance}` : ""}${mode3OnAsk !== undefined ? `, mode3OnAsk: ${mode3OnAsk}` : ""}`;
		sections.push(`[M] ${modeLine}`);
	}
	if (cwd !== undefined && cwd !== "") sections.push(`[W] ${cwd}`);
	for (const line of longUsers) sections.push(`[U] 用户: ${line}`);
	for (const item of [...fallbackTools].reverse()) sections.push(renderItem(item));
	for (const item of shortItems) sections.push(renderItem(item));
	if (intentItem !== null) sections.push(renderItem(intentItem));

	// Denial history (P2, dropped first on overflow).
	const denials = denialHistory?.get(sessionId) ?? [];
	const denialLines = denials.slice(-3).map((d) => {
		const src = d.source ?? "?";
		const risk = d.risk !== undefined ? `, risk: ${d.risk}` : "";
		const cmd = truncateMiddle(d.command ?? "", 80, 0);
		return `[D] deny ${cmd} (${src}${risk})`;
	});

	// Budget: assemble; on overflow drop denial history, then oldest
	// long-window entries, then oldest tool lines; final hard cut keeps the
	// head and tail (mode line / newest user message are protected).
	const joinLen = (lines) => lines.reduce((sum, line) => sum + line.length + 1, 0) - (lines.length > 0 ? 1 : 0);
	let lines = [...sections, ...denialLines];
	let text;
	if (joinLen(lines) <= maxChars) {
		text = lines.join("\n");
	} else {
		// 1) drop denial history entirely
		lines = [...sections];
		// 2) drop droppable lines from the oldest (top), protecting the first
		//    two lines ([M] mode / [W] cwd) and the last line (newest user).
		while (joinLen(lines) > maxChars && lines.length > 3) {
			lines.splice(2, 1);
		}
		text = lines.join("\n");
		// 3) final hard cut — the elision marker costs ~12 chars itself, so
		//    shrink head/tail until the cut truly fits inside the cap.
		let headChars = Math.floor(maxChars * 0.6);
		let tailChars = Math.floor(maxChars * 0.3);
		let cut = truncateMiddle(text, headChars, tailChars);
		while (cut.length > maxChars && (headChars > 8 || tailChars > 4)) {
			headChars = Math.floor(headChars * 0.8);
			tailChars = Math.floor(tailChars * 0.8);
			cut = truncateMiddle(text, headChars, tailChars);
		}
		if (cut.length > maxChars) cut = `${text.slice(0, Math.max(8, maxChars - 4))}…`;
		text = cut;
	}
	return text.trim();
}