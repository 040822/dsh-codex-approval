/**
 * dsh-codex-approval — shell-shape.js
 *
 * A conservative *recognizer* (deliberately not a parser) that decides whether
 * a shell command's text may be trusted for a deterministic allow.
 *
 *   simple   — exactly one command made of plain words / quoted strings: the
 *              argv is trustworthy, so prefix rules may auto-approve it.
 *   compound — two or more simple commands joined by `&&`, `||`, `;` or `|`.
 *              Rules never auto-approve these today (P1 will judge each part
 *              separately, Codex-style); they go to the judge / human.
 *   opaque   — anything we refuse to interpret: redirection, command
 *              substitution, variables, globs, control flow, escapes,
 *              assignments, newlines, unterminated quotes.
 *   not-shell — the tool is not bash/pwsh; shapes do not apply.
 *
 * Why refuse instead of splitting: a regex split on `;`/`&&` is not a shell
 * parser, and pretending otherwise is exactly the bypass this module exists to
 * close. Codex takes the same stance — it splits only a linear chain of plain
 * words joined by safe operators (tree-sitter) and otherwise treats the whole
 * script as one opaque invocation, so prefix rules simply do not match
 * (https://learn.chatgpt.com/docs/agent-configuration/rules). Claude Code
 * likewise refuses to let `Bash(safe-cmd *)` authorize `safe-cmd && other-cmd`
 * (https://code.claude.com/docs/en/permissions).
 *
 * Pure functions only; never throws.
 */

/** Tool names whose text is shell code (and therefore needs a shape verdict). */
export const SHELL_TOOLS = Object.freeze(["bash", "pwsh"]);

/** Every shape this module can return. */
export const SHAPES = Object.freeze(["simple", "compound", "opaque", "not-shell"]);

/** A bare `NAME` token that would make `NAME=value` a shell assignment. */
const ASSIGNMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @param toolName - the approval request's tool name */
export function isShellTool(toolName) {
	return typeof toolName === "string" && SHELL_TOOLS.includes(toolName.toLowerCase());
}

function opaque(reason) {
	return { shape: "opaque", argv: null, parts: null, reason };
}

/**
 * Classify one command string.
 * @param toolName - "bash" | "pwsh" (anything else → not-shell)
 * @param command - the tool call's command text (may be missing)
 * @returns { shape, argv, parts, reason } — `argv`/`parts` are null unless the
 *   shape is simple/compound; `reason` is a short machine-readable code.
 */
export function classifyCommand(toolName, command) {
	if (!isShellTool(toolName)) return { shape: "not-shell", argv: null, parts: null, reason: null };
	if (typeof command !== "string" || command.trim() === "") return opaque("empty-command");
	return toolName.toLowerCase() === "bash" ? classifyBash(command) : classifyPwsh(command);
}

/**
 * bash: accept exactly the "linear chain of plain words" subset, resolving
 * quoting ourselves so `echo '$(rm -rf /)'` stays simple (single quotes never
 * expand) while `echo "$(rm -rf /)"` is opaque (double quotes do).
 */
function classifyBash(command) {
	const parts = [];
	let current = [];
	let token = "";
	let inSingle = false;
	let inDouble = false;

	const pushToken = () => {
		if (token !== "") {
			current.push(token);
			token = "";
		}
	};
	const endPart = () => {
		pushToken();
		if (current.length > 0) parts.push(current);
		current = [];
	};

	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else token += ch;
			continue;
		}
		if (inDouble) {
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			if (ch === "\\") {
				const next = command[i + 1];
				if (next === "$" || next === "`" || next === '"' || next === "\\") {
					token += next;
					i += 1;
					continue;
				}
				token += ch;
				continue;
			}
			if (ch === "$" || ch === "`") return opaque("expansion-in-double-quotes");
			token += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === " " || ch === "\t") {
			pushToken();
			continue;
		}
		if (ch === "\n" || ch === "\r") return opaque("newline");
		if (ch === "\\") return opaque("escape");
		if (ch === "$" || ch === "`") return opaque("expansion");
		if (ch === "(" || ch === ")" || ch === "{" || ch === "}") return opaque("grouping");
		if (ch === "[" || ch === "]" || ch === "*" || ch === "?") return opaque("glob");
		if (ch === "~") return opaque("home-expansion");
		if (ch === "!") return opaque("history-expansion");
		if (ch === "#") return opaque("comment");
		if (ch === "<" || ch === ">") return opaque("redirection");
		if (ch === ";") {
			if (command[i + 1] === ";" || command[i + 1] === "&") return opaque("separator");
			if (current.length === 0 && token === "" && parts.length === 0) return opaque("empty-command");
			endPart();
			continue;
		}
		if (ch === "&") {
			if (command[i + 1] !== "&") return opaque("background");
			i += 1;
			endPart();
			continue;
		}
		if (ch === "|") {
			if (command[i + 1] === "|" || command[i + 1] === "&") i += 1;
			endPart();
			continue;
		}
		if (ch === "=" && current.length === 0 && ASSIGNMENT_NAME.test(token)) return opaque("assignment");
		token += ch;
	}
	if (inSingle || inDouble) return opaque("unterminated-quote");
	endPart();
	if (parts.length === 0) return opaque("empty-command");
	return {
		shape: parts.length > 1 ? "compound" : "simple",
		argv: parts[0],
		parts,
		reason: null
	};
}

/**
 * pwsh: stricter than bash on purpose. PowerShell's `;`/`|` chains, `$()`
 * subexpressions, backtick escapes, `&` call operator, array operator and
 * `@` splatting all change what runs, so P0 accepts a single command of plain
 * words and literal single-quoted strings only, and calls everything else
 * opaque (no "compound" verdict for pwsh yet).
 */
function classifyPwsh(command) {
	const argv = [];
	let token = "";
	let inSingle = false;
	let inDouble = false;
	const pushToken = () => {
		if (token !== "") {
			argv.push(token);
			token = "";
		}
	};
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else token += ch;
			continue;
		}
		if (inDouble) {
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			if (ch === "$" || ch === "`") return opaque("pwsh-expansion");
			token += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === " " || ch === "\t") {
			pushToken();
			continue;
		}
		if (ch === "\n" || ch === "\r") return opaque("newline");
		if (ch === ";" || ch === "|" || ch === "&") return opaque("pwsh-separator");
		if (ch === "$" || ch === "`") return opaque("pwsh-expansion");
		if (ch === "(" || ch === ")" || ch === "{" || ch === "}" || ch === "@") return opaque("pwsh-grouping");
		if (ch === ">" || ch === "<") return opaque("redirection");
		if (ch === "*" || ch === "?" || ch === "[" || ch === "]") return opaque("glob");
		if (ch === ",") return opaque("pwsh-array");
		if (ch === "#") return opaque("comment");
		token += ch;
	}
	if (inSingle || inDouble) return opaque("unterminated-quote");
	pushToken();
	if (argv.length === 0) return opaque("empty-command");
	return { shape: "simple", argv, parts: [argv], reason: null };
}

/**
 * The arguments that name a path: everything after the matched prefix that is
 * not an option/switch. `cat -n file` → `["file"]`; `Get-Content -Path x` → `["x"]`.
 * @param argv - the command's argv (simple shape only)
 * @param skip - how many leading argv entries the rule's prefix consumed
 */
export function positionalArgs(argv, skip = 1) {
	if (!Array.isArray(argv)) return [];
	return argv.slice(skip).filter((arg) => typeof arg === "string" && !arg.startsWith("-"));
}

/**
 * Whether one argument is a workspace-relative path *by inspection*: no
 * absolute path, no home expansion, no drive letter, no backslash, no `..`
 * segment. The workspace root itself is enforced by the handler's realpath
 * check (see index.js), this only rejects what is obviously outside.
 * @param arg - one non-option argument
 */
export function isWorkspaceRelativePath(arg) {
	if (typeof arg !== "string" || arg === "") return false;
	if (/^[A-Za-z]:[\\/]/.test(arg)) return false;
	if (arg.startsWith("/") || arg.startsWith("\\") || arg.startsWith("~")) return false;
	if (arg.includes("\\")) return false;
	return !arg.split("/").includes("..");
}

/**
 * The first argv entry that hits one of a rule's `forbidOptions`, or null.
 * Long options also match their `--opt=value` form; a two-character short
 * option also matches its attached form (`-O<file>`).
 * @param argv - the command's argv
 * @param options - the rule's forbidOptions list
 */
export function forbiddenOptionHit(argv, options) {
	if (!Array.isArray(argv) || !Array.isArray(options)) return null;
	for (const arg of argv) {
		if (typeof arg !== "string") continue;
		for (const option of options) {
			if (typeof option !== "string" || option === "") continue;
			if (arg === option) return arg;
			if (option.startsWith("--") && arg.startsWith(`${option}=`)) return arg;
			if (option.length === 2 && arg.startsWith(option) && arg.length > 2) return arg;
		}
	}
	return null;
}
