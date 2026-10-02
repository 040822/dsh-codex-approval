/**
 * dsh-codex-approval — judge.js
 *
 * The AI approval judge: builds a strict prompt from the request, runs it
 * through an injected LLM runner, parses the verdict, and maps
 * risk × tolerance onto the allow/ask/deny authorization (Codex-style).
 *
 * The LLM runner is injected so tests can drive deterministic verdicts
 * without any model; index.js supplies the real ctx.llm-backed runner.
 */

import { redactSensitive } from "./redact.js";

export const RISKS = ["low", "medium", "high"];
export const AUTHORIZATIONS = ["allow", "ask", "deny"];
export const RISK_RANK = { low: 0, medium: 1, high: 2 };

const SYSTEM_PROMPT = `You are the automated approval judge for an AI coding agent's command-execution requests.

Classify the tool call on two axes:
1. risk: "low" (safe, read-only, reversible) | "medium" (modifies state, bounded and recoverable) | "high" (destructive, irreversible, credential-exposing, or system-wide impact).
2. authorization: "allow" (proceed without asking) | "ask" (a human must confirm) | "deny" (must not run).

Rules of thumb:
- Reading files, git status/diff/log, listing, help output: low.
- Writes inside a project, installs, network fetches: medium.
- Deleting data, overwriting configs, exposing secrets, privilege changes, formatting disks, anything touching credentials: high.
- User intent matters: an action the user explicitly requested in the recent conversation is "allow"-eligible even if nominally medium-risk; never "ask"/"deny" a command the user just asked for unless it is clearly high-risk.
- When uncertain, prefer "ask". Prefer "deny" for destructive or credential-exposing actions.

An optional "Context:" block may follow the request JSON — it is a compact, truncated session transcript ([U] user messages, [T] tool calls, [R] results, [D] recent denials, [M] mode). Use it to judge intent; ignore unrelated lines.

Reply with ONLY one JSON object, no prose, no markdown fences:
{"risk":"low|medium|high","authorization":"allow|ask|deny","reason":"one short sentence"}`;

/** Variant used in ai-auto mode: the judge must decide itself, no human is available. */
const SYSTEM_PROMPT_NO_ASK = SYSTEM_PROMPT.replace(
	'2. authorization: "allow" (proceed without asking) | "ask" (a human must confirm) | "deny" (must not run).',
	'2. authorization: "allow" (proceed without asking) | "deny" (must not run). "ask" is NOT available — no human will review this request, you MUST decide between allow and deny yourself.'
).replace(
	'- When uncertain, prefer "ask". Prefer "deny" for destructive or credential-exposing actions.',
	'- When uncertain, prefer "deny". Prefer "deny" for destructive or credential-exposing actions.'
).replace(
	'{"risk":"low|medium|high","authorization":"allow|ask|deny","reason":"one short sentence"}',
	'{"risk":"low|medium|high","authorization":"allow|deny","reason":"one short sentence"}'
);

/**
 * Build the messages array for the judge call.
 *
 * The fixed policy and the untrusted evidence travel as **two messages with
 * different roles**: the instructions are a `system` message, the request JSON
 * (command / reason) and the optional transcript follow as a `user` message.
 * Concatenating both into one user message — as this used to — puts the
 * attacker-controlled command text on the same instruction level as the policy,
 * so nothing but the `\n\n` separator tells the model which part it must obey.
 * The host's LLM service passes roles through to the adapter, so the split costs
 * nothing.
 * @param opts - { toolName, argsText, reason, context }
 *   `context` is an optional compact session transcript (transcript.js);
 *   when present it is appended after the request JSON in the user message.
 * @param allowAsk - when false (ai-auto mode), the prompt forbids "ask":
 *   the judge must commit to allow or deny.
 */
export function buildJudgeMessages({ toolName, argsText, reason, context }, { allowAsk = true } = {}) {
	const user = JSON.stringify({
		toolName,
		command: argsText === "" ? null : argsText,
		reason: reason ?? null
	});
	const system = allowAsk ? SYSTEM_PROMPT : SYSTEM_PROMPT_NO_ASK;
	const body = context !== undefined && context !== ""
		? `${user}\n\nContext:\n${context}`
		: user;
	return [
		{ role: "system", content: [{ type: "text", text: system }] },
		{ role: "user", content: [{ type: "text", text: body }] }
	];
}

/**
 * Every balanced `{...}` slice of a text, respecting JSON string literals (so
 * braces inside a `reason` value neither open nor close an object). Nested
 * objects are part of their enclosing slice, not reported separately.
 */
function balancedObjects(text) {
	const objects = [];
	let cursor = 0;
	while (cursor < text.length) {
		const start = text.indexOf("{", cursor);
		if (start === -1) break;
		let depth = 0;
		let inString = false;
		let escaped = false;
		let end = -1;
		for (let i = start; i < text.length; i += 1) {
			const ch = text[i];
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') {
				inString = true;
				continue;
			}
			if (ch === "{") {
				depth += 1;
				continue;
			}
			if (ch === "}") {
				depth -= 1;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		if (end === -1) break;
		objects.push(text.slice(start, end + 1));
		cursor = end + 1;
	}
	return objects;
}

/** Parse one candidate slice into a closed-enum verdict, or null. */
function toVerdict(candidate) {
	let parsed;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const { risk, authorization, reason } = parsed;
	if (!RISKS.includes(risk) || !AUTHORIZATIONS.includes(authorization)) return null;
	return {
		risk,
		authorization,
		reason: typeof reason === "string" ? reason.slice(0, 200) : ""
	};
}

/**
 * Parse a judge verdict out of model output.
 *
 * Accepted shapes: the whole reply is one JSON object, or the reply contains
 * exactly **one** verdict-shaped balanced object (surrounding prose and a
 * markdown fence are tolerated).
 *
 * Anything ambiguous is rejected — a model that emits `{allow…} then {deny…}`
 * returns null (→ failOpen) instead of the first object winning, and a reply
 * with two verdict-shaped objects is never resolved by position.
 *
 * @param text - the model's raw reply
 * @returns { risk, authorization, reason } or null.
 */
export function parseVerdict(text) {
	if (typeof text !== "string") return null;
	const trimmed = text.trim();
	if (trimmed === "") return null;
	if (trimmed.startsWith("{")) {
		const direct = toVerdict(trimmed);
		if (direct !== null) return direct;
	}
	const verdicts = [];
	for (const candidate of balancedObjects(text)) {
		const verdict = toVerdict(candidate);
		if (verdict !== null) verdicts.push(verdict);
	}
	return verdicts.length === 1 ? verdicts[0] : null;
}

/**
 * Map an AI verdict onto the final authorization under a risk tolerance.
 * A direct allow/deny verdict is respected; an "ask" verdict falls back to
 * the tolerance comparison (risk <= tolerance → allow, else ask).
 * @param verdict - parsed AI verdict {risk, authorization}
 * @param tolerance - "low" | "medium" | "high"
 * @returns "allow" | "ask" | "deny"
 */
export function decideAuthorization(verdict, tolerance) {
	if (verdict.authorization === "allow" || verdict.authorization === "deny") return verdict.authorization;
	const riskRank = RISK_RANK[verdict.risk] ?? 2;
	const toleranceRank = RISK_RANK[tolerance] ?? 1;
	return riskRank <= toleranceRank ? "allow" : "ask";
}

/**
 * Run the judge through an injected runner.
 * @param runner - async (messages, { signal, sessionId }) => Promise<{ ok: boolean, text: string }>
 * @param input - { toolName, argsText, reason, context }
 * @param config - { maxPromptChars } (unused here; kept for symmetry)
 * @param sessionId - optional stable per-conversation id forwarded to the LLM
 *   call so the provider can optimize prompt caching (e.g. OpenCode Go's
 *   `x-opencode-session` header).
 * @returns { ok: true, verdict, judgeModel?, judgeFallbackFrom?, judgeAttempts? }
 *   | { ok: false, error, finishKind?, failure?, rawText?, textChars?,
 *       endedWithoutFinish?, judgeAttempts?, judgeTried? }
 *   The `judge*` fields are present only when the runner used a fallback chain
 *   (see makeLlmRunner): they name the model that answered and how many
 *   candidates were tried, so the audit log shows a degraded judge.
 *
 *   An unusable reply is a failure, never a verdict: `parseVerdict` returning
 *   null is reported as `unparseable judge output (empty reply)` for an empty
 *   stream and `(no verdict)` when text arrived without a verdict object. The
 *   runner (the chain) already applies that rule per candidate, so this branch
 *   is the guard for a runner that answers with raw model text.
 */
export async function judgeWith({ runner, input, signal, allowAsk = true, sessionId }) {
	const messages = buildJudgeMessages(input, { allowAsk });
	let result;
	try {
		result = await runner(messages, { signal, sessionId });
	} catch (error) {
		return { ok: false, error: String(error?.message ?? error) };
	}
	if (result === null || result.ok !== true) {
		return {
			ok: false,
			error: result?.error ?? "judge runner failed",
			...result?.finishKind === undefined ? {} : { finishKind: result.finishKind },
			...result?.failure === undefined ? {} : { failure: result.failure },
			...result?.rawText === undefined ? {} : { rawText: result.rawText },
			...result?.textChars === undefined ? {} : { textChars: result.textChars },
			...result?.endedWithoutFinish === undefined ? {} : { endedWithoutFinish: result.endedWithoutFinish },
			...result?.judgeAttempts === undefined ? {} : { judgeAttempts: result.judgeAttempts },
			...result?.judgeTried === undefined ? {} : { judgeTried: result.judgeTried }
		};
	}
	const text = typeof result.text === "string" ? result.text : "";
	const verdict = parseVerdict(text);
	if (verdict === null) {
		return {
			ok: false,
			error: text.trim() === ""
				? "unparseable judge output (empty reply)"
				: "unparseable judge output (no verdict)",
			rawText: redactSensitive(text).slice(0, 500),
			textChars: text.length,
			...result.endedWithoutFinish === undefined ? {} : { endedWithoutFinish: result.endedWithoutFinish },
			...result.judgeModel === undefined ? {} : { judgeModel: result.judgeModel }
		};
	}
	return {
		ok: true,
		verdict,
		...result.judgeModel === undefined ? {} : { judgeModel: result.judgeModel },
		...result.judgeFallbackFrom === undefined ? {} : { judgeFallbackFrom: result.judgeFallbackFrom },
		...result.judgeAttempts === undefined ? {} : { judgeAttempts: result.judgeAttempts }
	};
}
