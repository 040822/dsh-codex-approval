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
 * @param opts - { toolName, argsText, reason, context }
 *   `context` is an optional compact session transcript (transcript.js);
 *   when present it is appended as a "Context:" block after the request JSON.
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
	return [{
		role: "user",
		content: [{ type: "text", text: `${system}\n\n${body}` }]
	}];
}

/**
 * Parse a judge verdict out of model output. Tries, in order:
 *   1. whole-string JSON (models that emit pure JSON)
 *   2. a fenced ```json ... ``` block
 *   3. a balanced-brace scan from the first `{` (robust against prose,
 *      multiple objects, and nested braces inside string values)
 * The first candidate that parses AND passes the closed-enum validation
 * wins. Returns null when nothing qualifies.
 */
export function parseVerdict(text) {
	if (typeof text !== "string") return null;
	const candidates = [];
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) candidates.push(trimmed);
	const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence !== null) candidates.push(fence[1].trim());
	const start = text.indexOf("{");
	if (start !== -1) {
		let depth = 0;
		let inString = false;
		let escaped = false;
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
					candidates.push(text.slice(start, i + 1));
					break;
				}
			}
		}
	}
	for (const candidate of candidates) {
		let parsed;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (parsed === null || typeof parsed !== "object") continue;
		const { risk, authorization, reason } = parsed;
		if (!RISKS.includes(risk) || !AUTHORIZATIONS.includes(authorization)) continue;
		return {
			risk,
			authorization,
			reason: typeof reason === "string" ? reason.slice(0, 200) : ""
		};
	}
	return null;
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
 * @returns { ok: true, verdict } | { ok: false, error }
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
		return { ok: false, error: result?.error ?? "judge runner failed" };
	}
	const verdict = parseVerdict(result.text);
	if (verdict === null) {
		return { ok: false, error: "unparseable judge output", rawText: result.text.slice(0, 500) };
	}
	return { ok: true, verdict };
}
