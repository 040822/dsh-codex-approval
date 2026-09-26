/**
 * dsh-codex-approval — redact.js
 *
 * One redaction boundary for every path a command text travels: the judge
 * prompt, the JSONL audit record, the denial-feedback message, and provider
 * failure diagnostics. Before this module the only redaction covered provider
 * errors, so a credential inside a command was copied verbatim into the model
 * input and the audit log (verified against a real log: two records carried an
 * unredacted `K=sk-…` / `Authorization: Bearer …` command line).
 *
 * The redaction keeps the *shape* of the evidence — the credential's label,
 * URL parameter name, file path and surrounding syntax survive — because the
 * judge still has to recognise "this command handles a credential".
 *
 * Pure functions only; never throws on non-string input.
 */

/**
 * Replace credential-shaped values with `[REDACTED]`.
 * Covers bearer tokens, `sk-`/`pk-` keys, URL query parameters, and
 * `key: value` / `key=value` assignments for the usual secret names.
 * @param text - raw text (command, reason, model output, error message)
 * @returns the redacted text; non-strings pass through unchanged.
 */
export function redactSensitive(text) {
	if (typeof text !== "string") return text;
	return text
		.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
		.replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
		.replace(/([?&](?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|token)=)[^&#\s]*/gi, "$1[REDACTED]")
		.replace(/\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|token)\s*[:=]\s*[^\s,;]+/gi, (match) => {
			const separator = match.match(/\s*[:=]\s*/)?.[0] ?? "=";
			const label = match.slice(0, match.indexOf(separator));
			return `${label}${separator}[REDACTED]`;
		});
}

/**
 * Redact, trim, and bound a value for a log field or prompt field.
 * @param value - candidate text
 * @param maxChars - hard cap (an ellipsis is added when it truncates)
 * @returns the bounded text, or undefined when there is nothing to store.
 */
export function boundedText(value, maxChars) {
	if (typeof value !== "string") return undefined;
	const text = redactSensitive(value).trim();
	if (text === "") return undefined;
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
