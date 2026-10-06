/**
 * dsh-codex-approval — rules.js
 *
 * Codex-style rule matching over the "matchable text": `ToolName(args preview)
 * reason:<reason>`, plus a structured argv-prefix form:
 *
 *   legacy (glob over the text):
 *     { match: "Bash(git status*)", action: "allow" }
 *     { match: "Bash(npm publish*)", action: "ask" }
 *     { match: "Bash(git branch -D *)", action: "deny", caseSensitive: true }
 *     { match: "Bash(*git restore*)", action: "deny", unless: "Bash(*git restore --staged*)" }
 *   structured (argv prefix, Codex `prefix_rule` style):
 *     { tool: "bash", pattern: ["git", "status"], action: "allow" }
 *     { tool: "bash", pattern: ["git", "diff"], action: "allow", forbidOptions: ["--output", "-O"] }
 *     { tool: "bash", pattern: ["cat"], action: "allow", pathGuard: "workspace-relative" }
 *   structured, semantic (no pattern — judged on the argv itself):
 *     { tool: "bash", flagGuard: "recursive-delete", action: "ask" }
 *     { tool: "pwsh", flagGuard: "recursive-delete", action: "ask" }
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
 *
 * Text rules also scan the argv the recognizer rebuilt and (for deny/ask) the
 * raw text with glued quoted literals folded, because a rule matches characters
 * while the shell matches tokens: `npm  publish` and `rm -r"f" /tmp/x` are the
 * same commands with a spliced token. See `semanticSurfaces` and
 * `foldQuotedLiterals`.
 */

import {
	classifyCommand,
	forbiddenOptionHit,
	isShellTool,
	isWorkspaceRelativePath,
	positionalArgs,
	recursiveDeleteFlags
} from "./shell-shape.js";

/**
 * Classic glob match: `*` = any sequence (incl. empty), `?` = one char.
 *
 * Case-insensitive by default, because a rule is written to describe a command
 * and the shell's own spelling varies (`RM -RF` is `rm -rf`). `caseSensitive`
 * exists for the opposite need: `git branch -D` and `git branch -d` are
 * different commands — one discards unmerged commits, the other refuses to —
 * and only a case-sensitive match can keep them apart.
 * @param pattern - the rule's glob
 * @param text - one match surface
 * @param caseSensitive - match letter-for-letter instead of folding case
 */
export function wildcardMatch(pattern, text, caseSensitive = false) {
	if (typeof pattern !== "string" || typeof text !== "string") return false;
	if (caseSensitive !== true) {
		pattern = pattern.toLowerCase();
		text = text.toLowerCase();
	}
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
 * The command text as the shell itself would deliver it: the argv of every
 * safely-recognised part, rejoined with single spaces. `git  status` →
 * `git status`; `rm -r"f" /tmp/x` → `rm -rf /tmp/x`.
 *
 * Rules match *text*, the shell matches *argv*, and the two disagree whenever
 * quoting or spacing splices a token — which is how `npm  publish` (an extra
 * space) and `rm -r"f" /tmp/x` used to walk past the `npm publish` ask rule and
 * the `rm -rf` deny rule. Rebuilt argv is the same command with that splicing
 * removed, so scanning it as an extra surface restores the match.
 *
 * The rebuild is **lossy in one direction**: a part whose argument itself
 * contains whitespace (`"git status"` — the name of an executable with a space
 * in it) rejoins into the same text as the two-word `git status`. Such a part
 * therefore contributes **no** surface at all: without argument boundaries the
 * rebuilt text is not equivalent to the command, and using it would let a legacy
 * `Bash(git status)` allow rule authorize that differently-named program.
 * @param req - { toolName }
 * @param opts - { parts } from shell-shape.classifyCommand
 */
export function semanticSurfaces(req, opts) {
	if (typeof req.toolName !== "string" || req.toolName === "") return [];
	const parts = opts?.parts;
	if (!Array.isArray(parts)) return [];
	const surfaces = [];
	for (const part of parts) {
		if (!Array.isArray(part)) continue;
		if (part.some((word) => typeof word !== "string" || /\s/.test(word))) continue;
		const text = part.join(" ");
		if (text !== "") surfaces.push(`${req.toolName}(${text})`);
	}
	return surfaces;
}

/**
 * Fold the two splices that keep a text rule from seeing what the shell runs,
 * without ever crossing a quote boundary:
 *
 *   - a quoted block **glued to what precedes it** is spliced, so its contents
 *     are the literal that was being padded: `-r"f"` → `-rf`,
 *     `~/.ss''h/i''d_rsa` → `~/.ssh/id_rsa`;
 *   - a quoted block standing on its own (`echo 'rm -rf /'`) is an argument, and
 *     is left exactly as written — folding inside it would deny a command that
 *     only prints text (`echo 'rm -r"f" /'`).
 *
 * The scan is quote-state aware precisely so that a quote *inside* a quoted
 * string never opens a new block.
 *
 * Only deny/ask rules scan this surface: it exists to make a *safety* rule fire,
 * never to let an allow rule claim something new.
 * @param text - one match surface
 */
export function foldQuotedLiterals(text) {
	if (typeof text !== "string" || text === "") return text;
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch !== "'" && ch !== '"') {
			out += ch;
			i += 1;
			continue;
		}
		const end = text.indexOf(ch, i + 1);
		if (end === -1) {
			// unterminated quote: nothing to splice, leave the rest as-is
			out += text.slice(i);
			break;
		}
		const inner = text.slice(i + 1, end);
		const gluedLeft = out !== "" && !/\s/.test(out[out.length - 1]);
		out += gluedLeft ? inner : `${ch}${inner}${ch}`;
		i = end + 1;
	}
	return out;
}

/**
 * Normalize runs of spaces/tabs to one space. An **opaque** command has no argv
 * to rebuild, so `npm  publish > /tmp/log` or `npm\tpublish 2>log` (one
 * separator too many, or a tab) would otherwise still slip past the
 * `npm publish` ask rule; normalizing the text restores the match. Safe by
 * construction: it only makes text *more* like the canonical spelling a rule is
 * written in.
 * @param text - one match surface
 */
export function collapseWhitespace(text) {
	return typeof text === "string" ? text.replace(/[ \t]+/g, " ") : text;
}

/**
 * Replace every quote with a space, so a quoted path lands on its own in the
 * text: `tar -czf x "/home/u/.aws"` → `tar -czf x  /home/u/.aws ` — which is
 * what makes the `<dir>`-at-end and `<dir> `-before-an-argument shapes fire.
 * Unlike folding, this never *joins* characters, so it cannot turn a printed
 * string into a command (`echo 'rm -r"f" /'` stays harmless).
 * @param text - one match surface
 */
export function spaceOutQuotes(text) {
	return typeof text === "string" ? text.replace(/['"]/g, " ") : text;
}

/**
 * Replace shell punctuation with spaces, so a path that ends where the next
 * command begins still stands alone: `tar -czf x /home/u/.aws; echo done` →
 * `... /home/u/.aws  echo done`, which the `<dir> `-before-an-argument shape
 * matches. Only deny/ask rules scan it.
 * @param text - one match surface
 */
export function spaceOutPunctuation(text) {
	return typeof text === "string" ? text.replace(/[;|&()<>{}]+/g, " ") : text;
}

/**
 * Every safety-side rewrite of a surface. The rewrites compose — a command can
 * splice a quote **and** hide behind a separator (`/w/.a"w"s;echo x>y`), so a
 * single pass is not enough: apply each rewrite to the original and then to the
 * result of every other rewrite, and finally normalize the whitespace of each
 * variant. Everything is a pure text rewrite used only by deny/ask rules.
 */
function safetyFolds(text) {
	const passes = [foldQuotedLiterals, spaceOutQuotes, spaceOutPunctuation];
	const first = passes.map((apply) => apply(text));
	const second = first.flatMap((variant) => passes.map((apply) => apply(variant)));
	return unique([text, ...first, ...second].flatMap((variant) => [variant, collapseWhitespace(variant)]));
}

/** De-duplicate surfaces while keeping their order. */
function unique(surfaces) {
	return [...new Set(surfaces)];
}

/** Every `flagGuard` this build understands. */
export const FLAG_GUARDS = Object.freeze(["recursive-delete"]);

/**
 * Whether a rule is the structured (argv-prefix) form — including the semantic
 * `flagGuard` form, which carries no `pattern` because it is judged on the argv
 * rather than on a text prefix.
 */
export function isStructuredRule(rule) {
	return rule !== null
		&& typeof rule === "object"
		&& typeof rule.tool === "string"
		&& rule.tool !== ""
		&& (Array.isArray(rule.pattern) || typeof rule.flagGuard === "string");
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
		if (typeof rule.flagGuard === "string") return `${tool}(flagGuard:${rule.flagGuard})`;
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
	if (rule.flagGuard !== void 0) return matchesFlagGuard(rule, req.toolName, opts);
	const argv = opts?.argv;
	if (!Array.isArray(argv)) return false;
	if (argv.length < rule.pattern.length) return false;
	for (let i = 0; i < rule.pattern.length; i += 1) {
		if (argv[i] !== rule.pattern[i]) return false;
	}
	if (forbiddenOptionHit(argv, rule.forbidOptions) !== null) return false;
	if (rule.pathGuard === "workspace-relative") {
		const args = positionalArgs(argv, rule.pattern.length, opts);
		if (!args.every((arg) => isWorkspaceRelativePath(arg))) return false;
	}
	return true;
}

/**
 * The `flagGuard` form: no pattern, judged on the argv the recognizer built.
 *
 * It exists because a text rule cannot see the *meaning* of a bundled short
 * option: `rm -rvf ./x` and `rm -rf ./x` are one command, but as text they are
 * two strings, so a glob list has to enumerate every letter of every bundle in
 * every order (and loses to `-rvif`). `recursiveDeleteFlags` splits the bundle
 * instead, and this rule fires on the meaning.
 *
 * Every part of a compound command is checked (`cd pkg && rm -rvf dist`), and
 * an opaque command — no argv to inspect — simply does not match here; that is
 * what the `Bash(*rm -rf*)` text rules next to it in the default list are for.
 * `flagGuard` is a safety-side guard by design: `assertConfig` refuses it on an
 * `allow` rule, so it can only add strictness.
 *
 * @param rule - a structured rule carrying `flagGuard`
 * @param toolName - the request's tool name
 * @param opts - { argv, parts } from shell-shape.classifyCommand
 */
function matchesFlagGuard(rule, toolName, opts) {
	if (rule.flagGuard !== "recursive-delete") return false;
	const parts = Array.isArray(opts?.parts) ? opts.parts : Array.isArray(opts?.argv) ? [opts.argv] : [];
	for (const part of parts) {
		const flags = recursiveDeleteFlags(part, toolName);
		if (flags !== null && flags.recursive) return true;
	}
	return false;
}

/**
 * Whether any `unless` pattern hits any surface.
 *
 * The exception is resolved against the same surfaces the rule itself matched,
 * so a `deny` on `Bash(*git restore*)` with `unless: "Bash(*git restore
 * --staged*)"` also lets the folded and bare surfaces speak.
 * @param unless - a pattern or list of patterns, or undefined
 * @param surfaces - the surfaces in play for this rule's action
 * @param caseSensitive - passed through from the rule
 */
function unlessHits(unless, surfaces, caseSensitive) {
	if (unless === void 0) return false;
	const patterns = Array.isArray(unless) ? unless : [unless];
	for (const pattern of patterns) {
		if (typeof pattern !== "string" || pattern === "") continue;
		for (const surface of surfaces) {
			if (wildcardMatch(pattern, surface, caseSensitive)) return true;
		}
	}
	return false;
}

/**
 * Evaluate an ordered rule list against one request.
 *
 * Every rule is tested against three families of surfaces:
 *   1. the raw text (`ToolName(args)`, `reason:...`, and their combination);
 *   2. the argv the recognizer understood, rejoined (see `semanticSurfaces`) —
 *      `git  status` and `git status` are the same command;
 *   3. for deny/ask rules only, the raw text with glued quoted literals folded
 *      and whitespace runs collapsed (see `foldQuotedLiterals` /
 *      `collapseWhitespace`) — `rm -r"f" /tmp/x` is `rm -rf /tmp/x`, and
 *      `npm  publish > log` is `npm publish > log`.
 * (2) and (3) only ever *add* candidates, so a rule that matched before still
 * matches; they close the gap between "what the text says" and "what the shell
 * runs" on the fail-safe side.
 *
 * Two per-rule options tune the glob itself:
 *   - `caseSensitive: true` folds nothing — `git branch -D` ≠ `git branch -d`;
 *   - `unless: <pattern|patterns>` is the rule's own exception, and it can only
 *     narrow a deny/ask rule (`assertConfig` refuses it on an allow).
 * @param rules - ordered rule list (legacy `{match}` and/or structured forms)
 * @param req - { toolName, argsText, reason }
 * @param opts - { shape, argv, parts } from shell-shape.classifyCommand; a shell
 *   allow rule cannot fire without a `simple` shape.
 * @returns the first matching rule under deny > ask > allow priority, or null.
 */
export function evaluateRules(rules, req, opts = {}) {
	const strict = matchSurfaces(req);
	if (strict.length === 0) return null;
	const semantic = semanticSurfaces(req, opts);
	// The bare arguments text, without the `ToolName(...)` wrapper, so a pattern
	// can anchor on the end of the operation: `tar -czf x.tgz ~/.aws` ends with
	// the credential directory, while the wrapped form would say `~/.aws)`.
	const bare = typeof req.argsText === "string" && req.argsText !== "" ? [req.argsText] : [];
	const allowOpen = allowEligible(req.toolName, opts);
	for (const action of ["deny", "ask", "allow"]) {
		if (action === "allow" && !allowOpen) continue;
		const surfaces = action === "allow"
			? unique([...strict, ...semantic])
			: unique([
				...strict,
				...semantic,
				...bare,
				...strict.flatMap(safetyFolds),
				...bare.flatMap(safetyFolds),
				...semantic.flatMap(safetyFolds)
			]);
		for (const rule of rules) {
			if (rule === null || typeof rule !== "object" || rule.action !== action) continue;
			if (isStructuredRule(rule)) {
				if (matchesStructured(rule, req, opts)) return rule;
				continue;
			}
			if (typeof rule.match !== "string") continue;
			const caseSensitive = rule.caseSensitive === true;
			for (const surface of surfaces) {
				if (!wildcardMatch(rule.match, surface, caseSensitive)) continue;
				// `unless` is the rule's own exception: when it hits, this rule does
				// not claim the request and evaluation moves on. It can only make a
				// deny/ask rule *narrower* (`assertConfig` refuses it on an allow),
				// which is what lets `git restore` stay denied while its `--staged`
				// form — index only, nothing discarded from the working tree — is
				// left to the judge.
				if (unlessHits(rule.unless, surfaces, caseSensitive)) continue;
				return rule;
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
