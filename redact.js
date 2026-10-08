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
 * Two rules keep a rewrite from becoming a different command:
 *
 *   - the value classes deliberately stop at whitespace, `,`, `;`, `&`, `|`
 *     and `\`. An earlier `[^\s,;]+` swallowed everything after a `&` or a `|`,
 *     so `token=Z|git reset --hard HEAD` collapsed into `token=[REDACTED]
 *     reset --hard HEAD` — the `git` the deny rule matches on was gone, and the
 *     command fell through to the judge. Rules now also see the ORIGINAL text
 *     (see `index.js`), but redaction must still not rewrite a command into a
 *     different one;
 *   - the label is matched as a WHOLE KEY (`[A-Za-z0-9_-]*<word>…`). A bare
 *     `\b` in front of the word made every environment-style name invisible to
 *     this module: `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN` and `_authToken`
 *     have `_` before the keyword, and `_` is a word character, so the old
 *     pattern never fired on them. Measured against 12 common credential
 *     shapes, 10 leaked.
 *
 * Pure functions only; never throws on non-string input.
 */

/** The words that mark a key as credential-bearing. `authorization` is left to
 *  the dedicated header rule: matched here as well, it was redacted twice and
 *  the scheme it must keep got eaten (`Authorization: [REDACTED] [REDACTED]`). */
const LABEL_WORD = "api[_-]?key|access[_-]?token|auth(?!orization)|password|passwd|secret|token|credential";
/** A whole key containing one of those words, in either position. */
const LABEL = `[A-Za-z0-9_-]*(?:${LABEL_WORD})[A-Za-z0-9_-]*`;

const QUOTED_ASSIGNMENT = new RegExp(`(?<![A-Za-z0-9])((${LABEL})\\s*[:=]\\s*)(['"])(?:\\\\.|[^'"\\\\])*\\3`, "gi");
const PLAIN_ASSIGNMENT = new RegExp(`(?<![A-Za-z0-9])((${LABEL})\\s*[:=]\\s*)(?![Bb]earer\\b)(?:\\\\.|[^\\s,;&|\\\\'"])+`, "gi");

/**
 * Replace credential-shaped values with `[REDACTED]`.
 *
 * Covers, in this order: private-key blocks, authentication headers for **any**
 * scheme, `Bearer` everywhere else, `key: value` / `key=value` assignments for
 * environment-style names (quoted values first, then unquoted), URL query
 * parameters, the credential shapes that carry no label at all (AWS key ids,
 * GitHub / npm / Slack / Stripe-style tokens, JWTs), URL userinfo
 * (`scheme://user:pass@host`) and the `-u user:pass` spelling.
 *
 * The scheme had to become part of what is redacted: `Bearer` used to be the
 * only one handled, so `Authorization: Basic <b64>` came out as
 * `Authorization: [REDACTED] <b64>` — the label blacked out and the credential
 * (base64 of `user:password`) in the clear, which reads worse than no
 * redaction at all because it looks handled.
 * @param text - raw text (command, reason, model output, error message)
 * @returns the redacted text; non-strings pass through unchanged.
 */
export function redactSensitive(text) {
	if (typeof text !== "string") return text;
	return text
		// Private key material: the whole block, body lines included.
		.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
		// Authentication headers: keep the SCHEME when there is one, redact
		// everything it carries. Handling only `Bearer` meant `Authorization:
		// Basic <b64>` came out as `Authorization: [REDACTED] <b64>` — the label
		// blacked out and the credential (base64 of `user:password`) in the clear,
		// which is worse than no redaction because it looks handled. The scheme is
		// not a secret and stays: it tells the judge which authentication is in
		// play. It is optional, because a bare `Authorization: <token>` counts too.
		.replace(/(?<![A-Za-z0-9])((?:proxy-)?authorization\s*[:=]\s*)((?:[A-Za-z][A-Za-z0-9+.-]*)\s+)?(?:\\.|[^\s,;&|\\'"])+/gi, "$1$2[REDACTED]")
		// A plain `Bearer …` the rule above did not reach.
		.replace(/\bBearer\s+[^\s,;"]+/gi, "Bearer [REDACTED]")
		// URL userinfo (`scheme://user:pass@host`) and `-u user:pass`, BEFORE the
		// assignment rules: `oauth2:glpat-…@host` otherwise looked like a
		// `label: value` pair, and the value class swallowed the rest of the URL
		// (`host`, `path` and all) as one credential. The URL form uses a
		// placeholder WITHOUT brackets on purpose: `[REDACTED]` inside an authority
		// breaks the structure, and `command-facts.js` extracts the host from this
		// same redacted text — `https://[REDACTED]@host` parsed as host `redacted`,
		// losing the one clue the judge needed most.
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s:@]+@/gi, "$1REDACTED@")
		.replace(/((?<!\S)(?:--user|--username|-u)\s+)(?:\\.|[^\s,;&|\\'"])+/g, "$1[REDACTED]")
		// Quoted values first: `--password='alpha beta'` would otherwise lose only
		// its first word to the unquoted rule below.
		.replace(QUOTED_ASSIGNMENT, "$1[REDACTED]")
		// `(?!Bearer\b)` keeps `Authorization: Bearer <t>` to the scheme rule, or
		// this one rewrites the scheme into the placeholder as well.
		.replace(PLAIN_ASSIGNMENT, "$1[REDACTED]")
		// URL query parameters — the value stops at `&`, so later parameters stay.
		.replace(/([?&](?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|token)=)[^&#\s|]*/gi, "$1[REDACTED]")
		// Shapes that carry no label at all. A shape can only ever be a net: it
		// catches what the label rules cannot see, never the other way round.
		.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
		.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
		.replace(/\bnpm_[A-Za-z0-9]{16,}\b/g, "[REDACTED]")
		.replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, "[REDACTED]")
		.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\b/g, "[REDACTED]")
		.replace(/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
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
