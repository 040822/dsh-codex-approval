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
	// A quoted block is an argument even when it is empty: `cat ''` passes one
	// empty argument, and a dropped one shifts every later path argument.
	let tokenQuoted = false;
	let inSingle = false;
	let inDouble = false;

	const pushToken = () => {
		if (token !== "" || tokenQuoted) {
			current.push(token);
			token = "";
			tokenQuoted = false;
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
			tokenQuoted = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			tokenQuoted = true;
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
		// bash quotes are pure shell syntax: the program still receives `-n` from
		// `'-n'`, so a quoted word is an option name here and there is nothing to
		// track. PowerShell is the opposite case — see classifyPwsh.
		quoted: null,
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
	// Parallel to argv: the value a quoted word carries when the quote opened
	// right after an option name (`-Path:'link'`), else null — see pushToken.
	const inline = [];
	// Parallel to argv: was this word written as a quoted string? PowerShell binds
	// a **quoted** token as a value, never as a parameter name (`-Path '-x'` is
	// the path `-x`), and the word itself no longer shows that once the quotes are
	// stripped — so the flag has to travel with the word.
	const quoted = [];
	let token = "";
	// see classifyBash: an empty quoted string is still one argument
	let tokenQuoted = false;
	// offset inside the current word where its first quote opened, or -1. Only a
	// quote that opens *after* an option name is an inline value
	// (`-Path:'link'` → the path is `link`); a word that starts with a quote is
	// the whole value (`'--file=link'` → the path is `--file=link`).
	let tokenQuoteAt = -1;
	let inSingle = false;
	let inDouble = false;
	const pushToken = () => {
		if (token !== "" || tokenQuoted) {
			argv.push(token);
			quoted.push(tokenQuoted);
			inline.push(inlineValueAt(token, tokenQuoteAt));
			token = "";
			tokenQuoted = false;
			tokenQuoteAt = -1;
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
			tokenQuoted = true;
			if (tokenQuoteAt === -1) tokenQuoteAt = token.length;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			tokenQuoted = true;
			if (tokenQuoteAt === -1) tokenQuoteAt = token.length;
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
	return { shape: "simple", argv, quoted, inline, parts: [argv], reason: null };
}

/**
 * The value inside a quoted word when the quote opens right after an option
 * name or its separator (`-Path:` / `-Path=`), else null. `'-x'` and
 * `'--file=link'` are wholly quoted words: PowerShell hands the *entire*
 * string to the parameter, so the whole word is the path.
 * @param word - the assembled word
 * @param quoteAt - offset where the first quote opened, or -1
 */
function inlineValueAt(word, quoteAt) {
	if (quoteAt <= 0) return null;
	if (!/^-{1,2}[A-Za-z][A-Za-z0-9_-]*[:=]$/.test(word.slice(0, quoteAt))) return null;
	const value = word.slice(quoteAt);
	return value === "" ? null : value;
}

/**
 * The value an option carries inline, or null when the argument carries none.
 *
 * Two inline forms exist and neither may be treated as "just an option":
 *   - PowerShell binds a value with a **colon** ("The parameter name and value
 *     can be separated by a space or a colon character", about_Parameters), so
 *     `-Path:..\secret` is the same call as `-Path ..\secret` — the path is in
 *     the argument itself.
 *   - GNU-style long options accept `--flag=value`.
 *
 * Ignoring these is how `Get-Content -Path:..\secret` was auto-approved with an
 * empty path list.
 * @param arg - one argv entry
 * @returns the inline value, or null
 */
function inlineOptionValue(arg) {
	const colon = /^-[A-Za-z][A-Za-z0-9_-]*:([\s\S]+)$/.exec(arg);
	if (colon !== null) return colon[1];
	const equals = /^-{1,2}[A-Za-z][A-Za-z0-9_-]*=([\s\S]+)$/.exec(arg);
	return equals === null ? null : equals[1];
}

/** A token that names an option/switch rather than carrying a value: `-n`, `--output`, `-Path`. */
const OPTION_NAME = /^-{1,2}[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Option/value pairs whose value is a count, never a path: `-ReadCount:0`,
 * `-Tail:5`. Only these named switches are trusted to carry a non-path inline
 * value — everything else (`-Path:0`) is checked, because a bare number is a
 * perfectly good file name.
 */
const NON_PATH_INLINE = /^-(?:ReadCount|TotalCount|Tail):(?:\d+|true|false)$/i;

/**
 * The arguments that name a path: everything after the matched prefix that is
 * not an option/switch. `cat -n file` → `["file"]`; `Get-Content -Path x` → `["x"]`.
 *
 * Two cases must **not** be dropped, because the path hides inside them:
 *   - everything after a bare `--` terminator (`cat -- -../../etc/passwd`: the
 *     `--` ends option parsing, so every later entry is a path — including one
 *     that starts with `-`);
 *   - the inline value of `-Name:Value` / `--flag=value`.
 *
 * A word that the recognizer saw **quoted** is always a value (`quoted[i]`),
 * never an option name: PowerShell does not bind a quoted token as a parameter,
 * so `Get-Content -LiteralPath '-x'` passes the path `-x` and it must be checked.
 * bash reports no such flag — `cat '-n'` really does pass `-n` to `cat`.
 *
 * A dash-prefixed entry is only *skipped* when it actually looks like an option
 * name. Anything else starting with `-` is treated as a path and checked:
 * PowerShell binds a **quoted** string as a value, not as a parameter name
 * (`Get-Content -Path '-/../../x'` — the argument is quoted, so it is the path
 * `-/../../x`), and the recognizer has already dropped that quoting. A bare `-`
 * is likewise checked rather than waved through: PowerShell treats it as a path
 * (`-LiteralPath '-'`), and a symlink named `-` must still be resolved against
 * the workspace root.
 * @param argv - the command's argv (simple shape only)
 * @param skip - how many leading argv entries the rule's prefix consumed
 * @param flags - optional `{ quoted, inline }` from classifyCommand (pwsh only)
 */
export function positionalArgs(argv, skip = 1, flags = undefined) {
	if (!Array.isArray(argv)) return [];
	const quoted = flags?.quoted;
	const inline = flags?.inline;
	const args = [];
	let afterTerminator = false;
	for (let i = Math.max(0, skip); i < argv.length; i += 1) {
		const arg = argv[i];
		if (typeof arg !== "string") continue;
		if (afterTerminator) {
			args.push(arg);
			continue;
		}
		if (Array.isArray(quoted) && quoted[i] === true) {
			// a quoted word is a value. `-Path:'link'` carries the path `link`
			// (inline[i]); a wholly quoted word (`'--file=link'`) is the path as
			// written, so the whole word is checked.
			const value = Array.isArray(inline) ? inline[i] : null;
			args.push(value === null || value === undefined ? arg : value);
			continue;
		}
		if (arg === "--") {
			afterTerminator = true;
			continue;
		}
		if (arg.startsWith("-")) {
			if (NON_PATH_INLINE.test(arg)) continue;
			const value = inlineOptionValue(arg);
			if (value !== null) {
				args.push(value);
				continue;
			}
			// `-n` / `--output` / `-Path`: an option name, not a path. `-/../..`,
			// `-x.y`, `-`: not an option name, so it is checked as a path.
			if (OPTION_NAME.test(arg)) continue;
			args.push(arg);
			continue;
		}
		args.push(arg);
	}
	return args;
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

/** Programs that delete through PowerShell's `Remove-Item` and its aliases. */
const PWSH_DELETE_PROGRAMS = Object.freeze(["remove-item", "rm", "rd", "rmdir", "ri", "del", "erase"]);

/** `-Recurse` as PowerShell accepts it — any unique prefix counts. */
const PWSH_RECURSE = /^-(?:r|re|rec|recu|recur|recurs|recurse)$/i;

/** `-Force` likewise (`-f` alone is ambiguous with `-Filter`; asking is harmless). */
const PWSH_FORCE = /^-(?:f|fo|for|forc|force)$/i;

/**
 * A bundled short option split into its letters: `-rvf` → `["r","v","f"]`.
 * `--recursive`, `-`, `-x=1` and a path are not bundles.
 * @param arg - one argv entry
 */
function shortOptionBundle(arg) {
	if (!/^-[A-Za-z]+$/.test(arg)) return null;
	return [...arg.slice(1)];
}

/** The program name of an argv entry, with either directory separator stripped. */
function programName(entry) {
	return String(entry ?? "").split(/[\\/]/).pop().toLowerCase();
}

/**
 * Whether one argv is a *recursive deletion*, and whether it forces it.
 *
 * This is the check a text rule cannot make. `rm -rf`, `rm -fr`, `rm -r -f` and
 * `rm -rvf` are one command with one meaning, but as text they are four
 * different strings — a glob list has to enumerate the letters of every bundle
 * in every order, and loses as soon as a fifth letter appears (`-rvif`). The
 * recognizer already has the argv: split the bundle, look for the switches.
 *
 * Recursive is the predicate that matters: `rm -r dir` deletes a whole tree
 * without a prompt of its own, and `-f` only decides whether read-only files
 * stop it. `force` is reported alongside so a rule can be written for the
 * narrower "recursive **and** forced" case if a deployment wants that.
 *
 * PowerShell is the same question with other spellings: `Remove-Item` (or its
 * `rm` / `rd` / `rmdir` / `ri` / `del` / `erase` aliases) carrying `-Recurse`,
 * where PowerShell accepts any unique prefix of the parameter name.
 *
 * @param argv - one command's argv (from classifyCommand's `parts`)
 * @param toolName - "bash" | "pwsh"
 * @returns `{ recursive, force }`, or null when this is not a deletion program
 */
export function recursiveDeleteFlags(argv, toolName) {
	if (!Array.isArray(argv) || argv.length === 0) return null;
	const program = programName(argv[0]);
	const tool = String(toolName ?? "").toLowerCase();
	const flags = { recursive: false, force: false };
	if (tool === "bash") {
		if (program !== "rm") return null;
		for (const arg of argv.slice(1)) {
			if (typeof arg !== "string") continue;
			if (arg === "--") break; // everything after it is a path, even `-r`
			if (arg === "--recursive") {
				flags.recursive = true;
				continue;
			}
			if (arg === "--force") {
				flags.force = true;
				continue;
			}
			const letters = shortOptionBundle(arg);
			if (letters === null) continue;
			if (letters.includes("r") || letters.includes("R")) flags.recursive = true;
			if (letters.includes("f")) flags.force = true;
		}
		return flags;
	}
	if (tool === "pwsh") {
		if (!PWSH_DELETE_PROGRAMS.includes(program)) return null;
		for (const arg of argv.slice(1)) {
			if (typeof arg !== "string") continue;
			if (PWSH_RECURSE.test(arg)) flags.recursive = true;
			else if (PWSH_FORCE.test(arg)) flags.force = true;
		}
		return flags;
	}
	return null;
}
