/**
 * dsh-codex-approval — rules.js
 *
 * Codex-style rule matching over the "matchable text": `ToolName(args preview)
 * reason:<reason>`, plus a structured argv-prefix form:
 *
 *   legacy (glob over the text):
 *     { match: "Bash(git status*)", action: "allow" }
 *     { match: "Bash(npm publish*)", action: "ask" }
 *   structured (argv prefix, Codex `prefix_rule` style):
 *     { tool: "bash", pattern: ["git", "status"], action: "allow" }
 *     { tool: "bash", pattern: ["git", "diff"], action: "allow", forbidOptions: ["--output", "-O"] }
 *     { tool: "bash", pattern: ["cat"], action: "allow", pathGuard: "workspace-relative" }
 *
 * Evaluation priority is safety-first regardless of list order:
 *   deny  >  ask  >  allow
 * (an explicit ask or deny can never be overridden by a blanket allow,
 * mirroring Codex where ask/reject rules take precedence over auto-approve).
 *
 * Two safety rules on top of the glob match:
 *
 *  1. **Shape gate (allow only).** A shell tool's text is only auto-approved
 *     when `shell-shape.js` classified it `simple` — one command of plain
 *     words. `git status; rm -rf /`, `echo $(touch x)`, `cat /dev/null > x` and
 *     PowerShell chains are `compound`/`opaque`, so no allow rule may claim
 *     them; they fall through to the ask/deny rules and then to the judge /
 *     human. ask/deny rules are deliberately *not* gated: they are the
 *     fail-safe side.
 *  2. **Option / path guards.** A structured allow rule may name options that
 *     turn a read-only command into a writer (`git diff --output=<file>`), or
 *     require every path argument to stay inside the workspace (`cat`).
 */

import {
	classifyCommand,
	forbiddenOptionHit,
	isShellTool,
	isWorkspaceRelativePath,
	positionalArgs
} from "./shell-shape.js";

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

/** Whether a rule is the structured (argv-prefix) form. */
export function isStructuredRule(rule) {
	return rule !== null
		&& typeof rule === "object"
		&& typeof rule.tool === "string"
		&& rule.tool !== ""
		&& Array.isArray(rule.pattern);
}

/**
 * The human-readable label of a rule, used in the audit record, the denial
 * feedback and the transcript's `[D]` lines.
 * @param rule - a legacy or structured rule
 */
export function ruleLabel(rule) {
	if (rule === null || typeof rule !== "object") return "";
	if (typeof rule.match === "string") return rule.match;
	if (isStructuredRule(rule)) {
		const tool = rule.tool.toLowerCase() === "bash" ? "Bash" : rule.tool.toLowerCase() === "pwsh" ? "Pwsh" : rule.tool;
		return `${tool}(${rule.pattern.join(" ")}${rule.pattern.length > 0 ? "*" : ""})`;
	}
	return "";
}

/**
 * Whether a rule may auto-approve this request's command text. Shell text must
 * have been recognised as a single plain command; anything else — compound,
 * opaque, or a caller that forgot to classify — is refused.
 * @param toolName - the request's tool name
 * @param opts - { shape } from shell-shape.classifyCommand
 */
export function allowEligible(toolName, opts) {
	if (!isShellTool(toolName)) return true;
	return opts?.shape === "simple";
}

function matchesStructured(rule, req, opts) {
	const toolName = String(req.toolName ?? "").toLowerCase();
	if (toolName !== rule.tool.toLowerCase()) return false;
	const argv = opts?.argv;
	if (!Array.isArray(argv)) return false;
	if (argv.length < rule.pattern.length) return false;
	for (let i = 0; i < rule.pattern.length; i += 1) {
		if (argv[i] !== rule.pattern[i]) return false;
	}
	if (forbiddenOptionHit(argv, rule.forbidOptions) !== null) return false;
	if (rule.pathGuard === "workspace-relative") {
		const args = positionalArgs(argv, rule.pattern.length);
		if (!args.every((arg) => isWorkspaceRelativePath(arg))) return false;
	}
	return true;
}

/**
 * Evaluate an ordered rule list against one request.
 * @param rules - ordered rule list (legacy `{match}` and/or structured forms)
 * @param req - { toolName, argsText, reason }
 * @param opts - { shape, argv } from shell-shape.classifyCommand; a shell allow
 *   rule cannot fire without a `simple` shape.
 * @returns the first matching rule under deny > ask > allow priority, or null.
 */
export function evaluateRules(rules, req, opts = {}) {
	const surfaces = matchSurfaces(req);
	if (surfaces.length === 0) return null;
	const allowOpen = allowEligible(req.toolName, opts);
	for (const action of ["deny", "ask", "allow"]) {
		if (action === "allow" && !allowOpen) continue;
		for (const rule of rules) {
			if (rule === null || typeof rule !== "object" || rule.action !== action) continue;
			if (isStructuredRule(rule)) {
				if (matchesStructured(rule, req, opts)) return rule;
				continue;
			}
			if (typeof rule.match !== "string") continue;
			for (const surface of surfaces) {
				if (wildcardMatch(rule.match, surface)) return rule;
			}
		}
	}
	return null;
}

/**
 * Classify a request's command text once, for the rule gate, the audit record
 * and the handler's path-guard hardening.
 * @param toolName - the request's tool name
 * @param argsText - the full (untruncated, redacted) arguments text
 */
export function classifyRequest(toolName, argsText) {
	return classifyCommand(toolName, argsText);
}
