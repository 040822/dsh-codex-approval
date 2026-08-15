/**
 * dsh-codex-approval — rules.js
 *
 * Codex-style rule matching. A rule matches a request via a single glob
 * pattern over the "matchable text": `ToolName(args preview) reason:<reason>`.
 * Examples:
 *   - `Bash(git *)`      — the recovered bash command starts with "git "
 *   - `Bash(rm -rf /*)`  — destructive command
 *   - `reason:*curl*`    — the approval reason mentions curl
 *
 * Evaluation priority is safety-first regardless of list order:
 *   deny  >  ask  >  allow
 * (an explicit ask or deny can never be overridden by a blanket allow,
 * mirroring Codex where ask/reject rules take precedence over auto-approve).
 */

/** Classic glob match: `*` = any sequence (incl. empty), `?` = one char. Case-insensitive. */
export function wildcardMatch(pattern, text) {
	if (typeof pattern !== "string" || typeof text !== "string") return false;
	pattern = pattern.toLowerCase();
	text = text.toLowerCase();
	let pi = 0;
	let ti = 0;
	let star = -1;
	let mark = 0;
	while (ti < text.length) {
		if (pi < pattern.length && (pattern[pi] === "?" || pattern[pi] === text[ti])) {
			pi += 1;
			ti += 1;
		} else if (pi < pattern.length && pattern[pi] === "*") {
			star = pi;
			pi += 1;
			mark = ti;
		} else if (star !== -1) {
			pi = star + 1;
			ti = mark + 1;
			mark += 1;
		} else {
			return false;
		}
	}
	while (pi < pattern.length && pattern[pi] === "*") pi += 1;
	return pi === pattern.length;
}

/**
 * Build the single string rules match against.
 * @param req - { toolName, argsText, reason }
 */
export function matchableText(req) {
	const bits = [];
	if (req.toolName) bits.push(`${req.toolName}(${req.argsText ?? ""})`);
	if (req.reason) bits.push(`reason:${req.reason}`);
	return bits.join(" ");
}

/**
 * The surfaces a rule pattern is tested against, in order: the tool call
 * alone (`ToolName(args)`), the reason alone (`reason:...`), then the
 * combined string. This lets `Bash(git *)` match regardless of an appended
 * reason, and `reason:*curl*` match the reason alone.
 */
export function matchSurfaces(req) {
	const surfaces = [];
	if (req.toolName) surfaces.push(`${req.toolName}(${req.argsText ?? ""})`);
	if (req.reason) surfaces.push(`reason:${req.reason}`);
	const combined = surfaces.join(" ");
	if (!surfaces.includes(combined)) surfaces.push(combined);
	return surfaces.filter((surface) => surface !== "");
}

/**
 * Evaluate an ordered rule list against one request.
 * @param rules - [{ match: string, action: "allow"|"ask"|"deny" }]
 * @param req - { toolName, argsText, reason }
 * @returns the first matching rule under deny > ask > allow priority, or null.
 */
export function evaluateRules(rules, req) {
	const surfaces = matchSurfaces(req);
	if (surfaces.length === 0) return null;
	for (const action of ["deny", "ask", "allow"]) {
		for (const rule of rules) {
			if (rule.action !== action) continue;
			for (const surface of surfaces) {
				if (wildcardMatch(rule.match, surface)) return rule;
			}
		}
	}
	return null;
}
