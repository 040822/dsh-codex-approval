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
 *   - `hosts` — the network destinations the text names (URL hosts, `host:` and
 *     `user@host:` forms). The live baseline showed the judge treating a deploy
 *     target as an ordinary path argument.
 *   - `destructive` — options that delete, overwrite or rewrite (`--delete`,
 *     `--hard`, `-rf`, `-Recurse -Force`, …). These are the options that turn a
 *     routine-looking command into a destructive one.
 *
 * Everything here is derived from the TEXT and is therefore a hint, not a fact
 * about what will happen: the prompt says so, and the judge is told to keep
 * treating what it cannot see as unknown. Nothing in this module decides
 * anything — it only gives the judge better eyes.
 *
 * Pure functions, no filesystem access (the "outside" check is the same static
 * predicate the rule layer uses, so a symlinked path is still judged by its
 * written form and never resolved here).
 */

import { isWorkspaceRelativePath } from "./shell-shape.js";

/** Caps, so a pathological command line cannot bloat the prompt. */
const MAX_PATHS = 6;
const MAX_HOSTS = 4;
const MAX_FLAGS = 6;

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

/** Hosts we never report: they say nothing about where data goes. */
const UNINTERESTING_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

const URL_HOST = /\bhttps?:\/\/([A-Za-z0-9._-]+)/g;
/**
 * A path written anywhere in the text. Needed because the recogniser refuses to
 * build an argv for opaque commands (`echo $(cat /etc/passwd)`), and those are
 * exactly the ones whose target the judge most needs to see.
 */
const TEXT_PATH = /(?:^|[\s"'(=,:])((?:\/|~\/|\.\.?\/)[^\s"'`),;]+)/g;
const COLON_HOST = /(?:^|[\s"'(=])(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+):(?![0-9]*\s*$)/g;

/** Whether an argument looks like a path rather than a flag or a bare word. */
function looksLikePath(arg) {
	if (typeof arg !== "string" || arg === "") return false;
	if (arg.startsWith("-")) return false;
	if (arg.includes("\u0000")) return false;
	if (/^https?:\/\//i.test(arg)) return false;
	// require a path separator, a dot-prefix, a tilde, or a drive letter: a bare
	// word is far more likely a subcommand or a value than a path
	return arg.startsWith("/") || arg.startsWith("~") || arg.startsWith("./") || arg.startsWith("../") || arg.includes("/") || /^[A-Za-z]:[\\/]/.test(arg);
}

/**
 * Recover the structured hints of one shell command.
 *
 * @param opts - { toolName, argsText, shapeInfo }
 *   `shapeInfo` is the recogniser output from `classifyRequest`; when it has no
 *   argv (opaque commands) only the text-level hints (hosts, flags) are
 *   available, which is exactly the case where the judge needs them most.
 * @returns { paths?, hosts?, destructive? } or null when there is nothing to add
 */
export function commandFacts({ toolName, argsText, shapeInfo }) {
	const text = typeof argsText === "string" ? argsText : "";
	if (text === "") return null;
	const paths = [];
	const argvLists = [];
	if (shapeInfo !== null && typeof shapeInfo === "object") {
		if (Array.isArray(shapeInfo.argv)) argvLists.push(shapeInfo.argv);
		if (Array.isArray(shapeInfo.parts)) {
			for (const part of shapeInfo.parts) if (Array.isArray(part)) argvLists.push(part);
		}
	}
	for (const argv of argvLists) {
		for (const arg of argv) {
			if (!looksLikePath(arg)) continue;
			if (paths.some((entry) => entry.path === arg)) continue;
			paths.push({ path: arg, ...isWorkspaceRelativePath(arg) ? {} : { outside: true } });
			if (paths.length >= MAX_PATHS) break;
		}
		if (paths.length >= MAX_PATHS) break;
	}

	// Text-level paths: no argv exists for opaque commands, so scan the raw text too.
	for (const match of text.matchAll(TEXT_PATH)) {
		if (paths.length >= MAX_PATHS) break;
		const candidate = match[1];
		if (candidate.startsWith("//")) continue; // the tail of a URL, already reported as a host
		if (paths.some((entry) => entry.path === candidate)) continue;
		paths.push({ path: candidate, ...isWorkspaceRelativePath(candidate) ? {} : { outside: true } });
	}

	const hosts = [];
	for (const pattern of [URL_HOST, COLON_HOST]) {
		for (const match of text.matchAll(pattern)) {
			const host = String(match[1]).toLowerCase();
			if (UNINTERESTING_HOSTS.has(host)) continue;
			if (hosts.includes(host)) continue;
			hosts.push(host);
			if (hosts.length >= MAX_HOSTS) break;
		}
		if (hosts.length >= MAX_HOSTS) break;
	}

	// Exact token match, not a substring scan: `--force` contains `-force`, and
	// `--force-with-lease` contains `--force` — reporting both spellings of one
	// flag (or the wrong one) would teach the judge to distrust the field.
	const destructive = [];
	for (const token of text.toLowerCase().split(/[\s"';|&()]+/)) {
		if (token === "") continue;
		const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
		if (!DESTRUCTIVE_FLAGS.includes(name)) continue;
		if (destructive.includes(name)) continue;
		destructive.push(name);
		if (destructive.length >= MAX_FLAGS) break;
	}

	const facts = {};
	if (paths.length > 0) facts.paths = paths;
	if (hosts.length > 0) facts.hosts = hosts;
	if (destructive.length > 0) facts.destructive = destructive;
	return Object.keys(facts).length === 0 ? null : facts;
}

/** Exported for tests and docs: the option list the judge is shown. */
export const DESTRUCTIVE_OPTIONS = Object.freeze([...DESTRUCTIVE_FLAGS]);
