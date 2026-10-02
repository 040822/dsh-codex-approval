/**
 * dsh-codex-approval — command-facts.js
 *
 * Structured hints the judge cannot reliably read off a raw command line, and
 * that cost it a model call to guess at:
 *
 *   - `paths` — the path arguments, each marked when it is NOT inside the
 *     workspace (an absolute path, `~`, or a `..` escape). A judge reading
 *     `echo $(cat /etc/passwd)` has to notice the escape itself; here it is
 *     handed over.
 *   - `hosts` — the network destinations the text names (URL authorities,
 *     `user@host:` / `host:port` forms, and the target argument of ssh-like
 *     commands).
 *   - `destructive` — options that delete, overwrite or rewrite (`--delete`,
 *     `--hard`, `-rf`, `-Recurse -Force`, …).
 *
 * Everything here is derived from the TEXT and is therefore a hint, not a fact
 * about what will happen: the prompt says so, and the judge is told to keep
 * treating what it cannot see as unknown. Nothing in this module decides
 * anything — it only gives the judge better eyes.
 *
 * Two hard constraints, both learned from review:
 *   1. **Everything emitted is redacted first.** The recogniser's argv comes
 *      from the RAW command text, so a credential that `redactSensitive` had
 *      already stripped from `argsText` could otherwise ride back into the
 *      prompt and the audit log through a "path" that happens to contain a
 *      slash (`Authorization: Bearer ab/cd`).
 *   2. **Every field is bounded** — per item and in total. An 8KB command line
 *      must not become an 8KB fact block; the point is to help the judge, not
 *      to double the prompt.
 *
 * Pure functions, no filesystem access: the "outside" check is the same static
 * predicate the rule layer uses, so a symlinked path is judged by its written
 * form and never resolved here.
 */

import { redactSensitive } from "./redact.js";
import { isWorkspaceRelativePath } from "./shell-shape.js";

/** Caps, so a pathological command line cannot bloat the prompt. */
const MAX_PATHS = 6;
const MAX_HOSTS = 4;
const MAX_FLAGS = 6;
const MAX_ITEM_CHARS = 200;
const MAX_TOTAL_CHARS = 1_200;

/**
 * Options that destroy or rewrite rather than merely act. Deliberately a short
 * list of unambiguous ones: a broad list would flag half of everyday usage and
 * teach the judge to ignore the field.
 */
const DESTRUCTIVE_FLAGS = [
	"--delete",
	"--hard",
	"--force",
	"--force-with-lease",
	"--no-preserve-root",
	"--mirror",
	"--prune",
	"--overwrite",
	"-rf",
	"-fr",
	"-recurse",
	"-force"
];

/** Commands whose non-option arguments name a remote host. */
const NETWORK_COMMANDS = new Set(["ssh", "scp", "sftp", "rsync", "nc", "ncat", "telnet", "mosh", "curl", "wget"]);

/** Hosts we never report: they say nothing about where data goes. */
const UNINTERESTING_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/** A full URL, capturing its authority (`user:pass@host:port`). */
const URL = /\bhttps?:\/\/([^\s"'<>)\]]+)/gi;
/** `host:` / `user@host:` followed by something, as scp and rsync write it. */
const COLON_HOST = /(?:^|[\s"'(=,])((?:[A-Za-z0-9._-]+@)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+):(?=\S)/g;
/** A bare host name (needs a dot) used as an argument of a network command. */
const BARE_HOST = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
/**
 * A path written anywhere in the text. Needed because the recogniser refuses to
 * build an argv for opaque commands (`echo $(cat /etc/passwd)`), and those are
 * exactly the ones whose target the judge most needs to see.
 */
const TEXT_PATH = /(?:^|[\s"'(=,:])((?:\/|~\/|\.\.?\/)[^\s"'`),;]+)/g;

/** Whether the character at `index` sits inside a simple quoted run. */
function insideQuotes(text, index) {
	let single = 0;
	let double = 0;
	for (let i = 0; i < index; i += 1) {
		const ch = text[i];
		if (ch === "'") single += 1;
		else if (ch === '"') double += 1;
	}
	return single % 2 === 1 || double % 2 === 1;
}

/** Redact, bound and trim one emitted string. */
function clean(value) {
	return redactSensitive(String(value)).trim().slice(0, MAX_ITEM_CHARS);
}

/** Strip userinfo / port / path off a URL authority and keep the host. */
function authorityHost(authority) {
	let rest = authority.replace(/^[^@/]*@/, "");
	rest = rest.split("/")[0].split("?")[0].split("#")[0];
	if (rest.startsWith("[")) {
		const end = rest.indexOf("]");
		return (end === -1 ? rest : rest.slice(0, end + 1)).toLowerCase();
	}
	return rest.split(":")[0].toLowerCase();
}

/** Whether an argument looks like a path rather than a flag, code or a word. */
function looksLikePath(arg) {
	if (typeof arg !== "string" || arg === "") return false;
	if (arg.startsWith("-")) return false;
	if (arg.includes("\u0000")) return false;
	if (/^https?:\/\//i.test(arg)) return false;
	// Inline code and substitution expressions are not paths: `sed 's/foo/bar/g'`
	// and `python3 -c "print(1/2)"` both contain slashes and neither is a file.
	if (/^[sgy]\/.*\/.*\/?[gimpxy0-9]*$/.test(arg)) return false;
	if (/[(}$`]/.test(arg)) return false;
	// require a path separator, a dot-prefix, a tilde, or a drive letter: a bare
	// word is far more likely a subcommand or a value than a path
	return arg.startsWith("/") || arg.startsWith("~") || arg.startsWith("./") || arg.startsWith("../") || arg.includes("/") || /^[A-Za-z]:[\\/]/.test(arg);
}

/**
 * Recover the structured hints of one shell command.
 *
 * @param opts - { toolName, argsText, shapeInfo }
 *   `argsText` must be the REDACTED argument text (the handler's `argsText`).
 *   `shapeInfo` is the recogniser output from `classifyRequest`; when it has no
 *   argv (opaque commands) only the text-level hints are available, which is
 *   exactly the case where the judge needs them most.
 * @returns { paths?, hosts?, destructive? } or null when there is nothing to add
 */
export function commandFacts({ toolName, argsText, shapeInfo }) {
	const rawText = typeof argsText === "string" ? argsText : "";
	if (rawText === "") return null;
	// Redact ONCE up front: the recogniser's argv is built from the raw command,
	// so every string that leaves this module is derived from redacted text.
	const text = redactSensitive(rawText);

	const paths = [];
	const hosts = [];
	const destructive = [];
	let budget = MAX_TOTAL_CHARS;
	const pushPath = (candidate) => {
		const value = clean(candidate);
		if (value === "" || paths.length >= MAX_PATHS || budget < value.length) return;
		if (paths.some((entry) => entry.path === value)) return;
		budget -= value.length;
		paths.push({ path: value, ...isWorkspaceRelativePath(value) ? {} : { outside: true } });
	};
	const pushHost = (candidate) => {
		// An IPv6 literal arrives bracketed from a URL authority; the bare form is
		// what the "uninteresting host" list and the report should compare.
		const value = clean(candidate).toLowerCase().replace(/^\[|\]$/g, "");
		if (value === "" || hosts.length >= MAX_HOSTS || budget < value.length) return;
		if (UNINTERESTING_HOSTS.has(value) || hosts.includes(value)) return;
		budget -= value.length;
		hosts.push(value);
	};

	const argvLists = [];
	if (shapeInfo !== null && typeof shapeInfo === "object") {
		if (Array.isArray(shapeInfo.argv)) argvLists.push(shapeInfo.argv);
		if (Array.isArray(shapeInfo.parts)) {
			for (const part of shapeInfo.parts) if (Array.isArray(part)) argvLists.push(part);
		}
	}
	for (const argv of argvLists) {
		for (const arg of argv) if (looksLikePath(arg)) pushPath(arg);
	}
	// Text-level paths: no argv exists for opaque commands, so scan the raw text too.
	for (const match of text.matchAll(TEXT_PATH)) {
		if (match[1].startsWith("//")) continue; // the tail of a URL, reported as a host
		pushPath(match[1]);
	}

	// A command that talks to the network may name its target inside quotes
	// (`rsync -a ./d/ "deploy@host:/srv"`); anywhere else a quoted `host:port` is
	// prose — `git commit -m "see docs.example.com:8080"` — and must not be
	// reported as a destination.
	const networkCommand = argvLists.some((argv) => NETWORK_COMMANDS.has(String(argv[0] ?? "").toLowerCase()));
	for (const match of text.matchAll(URL)) pushHost(authorityHost(match[1]));
	for (const match of text.matchAll(COLON_HOST)) {
		if (!networkCommand && insideQuotes(text, match.index)) continue;
		pushHost(match[1].includes("@") ? match[1].split("@")[1] : match[1]);
	}
	// `ssh host`, `scp file host:/path`, `nc host port`: the target is a bare
	// argument, and the text-level patterns above only catch it when it carries a
	// colon or a scheme.
	for (const argv of argvLists) {
		if (!NETWORK_COMMANDS.has(String(argv[0] ?? "").toLowerCase())) continue;
		for (const arg of argv.slice(1)) {
			if (typeof arg !== "string" || arg.startsWith("-")) continue;
			if (!arg.includes("@") && BARE_HOST.test(arg)) pushHost(arg);
			else if (arg.includes("@")) {
				const rest = arg.split("@")[1] ?? "";
				if (BARE_HOST.test(rest)) pushHost(rest.split(":")[0]);
			}
		}
	}

	// Exact token match, not a substring scan: `--force` contains `-force`, and
	// `--force-with-lease` contains `--force` — reporting both spellings of one
	// flag (or the wrong one) would teach the judge to distrust the field.
	for (const token of text.toLowerCase().split(/[\s"';|&()]+/)) {
		if (token === "") continue;
		const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
		if (!DESTRUCTIVE_FLAGS.includes(name)) continue;
		if (destructive.length >= MAX_FLAGS || destructive.includes(name)) break;
		destructive.push(name);
	}

	const facts = {};
	if (paths.length > 0) facts.paths = paths;
	if (hosts.length > 0) facts.hosts = hosts;
	if (destructive.length > 0) facts.destructive = destructive;
	return Object.keys(facts).length === 0 ? null : facts;
}

/** Exported for tests and docs: the option list the judge is shown. */
export const DESTRUCTIVE_OPTIONS = Object.freeze([...DESTRUCTIVE_FLAGS]);
