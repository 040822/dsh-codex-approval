/**
 * dsh-codex-approval — evidence.js
 *
 * The read-only evidence fetch behind the judge's `needs` request.
 *
 * `bash scripts/deploy.sh` is a one-line request whose real effect lives in
 * another file. The judge may therefore ask for a bounded, *workspace-local*
 * read before deciding — but the plugin, not the judge, decides what is
 * readable: every path is re-resolved through `realpath`, must land inside the
 * workspace root, and both the REQUESTED path and the RESOLVED one must pass
 * the credential check (otherwise a symlink named `notes.txt` would hand over
 * `.env`). Reads are bounded by size, by a deadline, and by file type — a FIFO
 * or a device would otherwise block the approval path forever. Anything the
 * judge asks for that fails those checks is refused with a reason and recorded,
 * never silently dropped, so "I could not see it" stays visible.
 *
 * The judge never gets a shell, a directory listing, or an arbitrary read: it
 * names files, this module answers with bounded text or a refusal reason.
 *
 * Functions take injectable `resolvePath` / `readFile` / `statFile`, so every
 * rule is unit-testable without touching the filesystem.
 */

import { readFile as fsReadFile, realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/** The only evidence kind the judge may ask for. */
export const EVIDENCE_KIND = "read-file";

/** Refusal reasons: a closed vocabulary, so the audit stays greppable. */
export const REFUSAL = {
	/** a credential file, or the private half of a key pair */
	credential: "credential-path",
	/** the path escapes the workspace root (directly or through a symlink) */
	outside: "outside-workspace",
	/** the file does not exist, or cannot be read */
	unreadable: "unreadable",
	/** the content is binary (a NUL byte in the first block) */
	binary: "binary",
	/** not a regular file (directory, FIFO, socket, device) */
	notAFile: "not-a-regular-file",
	/** bigger than the plugin is willing to pull into a prompt */
	tooLarge: "too-large",
	/** the approval's own deadline ran out while reading */
	timeout: "deadline-exceeded"
};

/**
 * Files that are never handed to the judge: private keys, cloud credentials,
 * tool auth files (`auth.json` wherever it sits — it is a credential file by
 * name), the harness's own provider config, and the common CLI credential
 * stores.
 */
const CREDENTIAL_PATH = [
	/(^|\/)\.ssh(\/|$)/i,
	/(^|\/)\.aws(\/|$)/i,
	/(^|\/)\.gnupg(\/|$)/i,
	/(^|\/)auth\.json$/i,
	/(^|\/)\.codex(\/|$)/i,
	/(^|\/)\.codex-run(\/|$)/i,
	/(^|\/)\.dsh\/profiles(\/|$)/i,
	/(^|\/)\.dsh\/settings\.yaml$/i,
	/(^|\/)\.env(\.|$)/i,
	/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
	/\.(pem|key|p12|pfx|keystore)$/i,
	/(^|\/)credentials(\.json)?$/i,
	/(^|\/)\.npmrc$/i,
	/(^|\/)\.git-credentials$/i,
	/(^|\/)\.netrc$/i,
	/(^|\/)_netrc$/i,
	/(^|\/)\.config\/gh(\/|$)/i,
	/(^|\/)\.docker\/config\.json$/i,
	/(^|\/)\.kube\/config$/i
];

/**
 * The largest file we are willing to pull into memory at all. Anything bigger is
 * refused outright; everything below it is read and then truncated to
 * `maxBytes`, because a 200KB deploy script with a 16KB cap is still worth
 * showing its head to the judge.
 */
const MAX_EVIDENCE_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Clean the judge's `needs` array down to the requests this plugin will even
 * consider: the known kind, a plausible path, no duplicates, at most
 * `maxFiles` entries.
 * @param raw - the `needs` value of a parsed verdict
 * @param maxFiles - hard cap on entries
 * @returns array of `{ path, why }`
 */
export function parseNeeds(raw, maxFiles = 2) {
	if (!Array.isArray(raw)) return [];
	const needs = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
		const kind = typeof item.type === "string" ? item.type.trim().toLowerCase() : "";
		if (kind !== EVIDENCE_KIND) continue;
		const path = typeof item.path === "string" ? item.path.trim() : "";
		if (path === "" || path.length > 512 || path.includes("\u0000")) continue;
		if (needs.some((need) => need.path === path)) continue;
		const why = typeof item.why === "string" ? item.why.trim().slice(0, 200) : "";
		needs.push({ path, why });
		if (needs.length >= maxFiles) break;
	}
	return needs;
}

/**
 * Whether a path looks like a credential file we never read. Works on the
 * requested path AND on a resolved one — a symlink must not smuggle a
 * credential in under an innocent name.
 */
export function isCredentialPath(path) {
	const normalized = path.replace(/\\/g, "/");
	return CREDENTIAL_PATH.some((pattern) => pattern.test(normalized));
}

/**
 * Race a promise against a deadline, tagging the rejection so the caller can
 * report *why* it gave up.
 */
function withDeadline(promise, ms, reason) {
	if (!Number.isFinite(ms)) return promise;
	if (ms <= 0) return Promise.reject(Object.assign(new Error(reason), { evidenceReason: reason }));
	let timer;
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(Object.assign(new Error(reason), { evidenceReason: reason })), ms);
		})
	]);
}

/**
 * Fetch the evidence a verdict asked for, under the plugin's whitelist.
 *
 * Every entry ends up either in `files` (verified, bounded text) or in
 * `refused` (with a reason) — a judge that cannot see a file must be told so,
 * because "unknown" is a judgement input, not a silent omission.
 *
 * @param needs - cleaned needs (parseNeeds)
 * @param opts - { root, base, maxBytes, deadline, resolvePath, readFile, statFile }
 *   `root` is the workspace boundary every path must stay inside; `base` is
 *   what a relative path resolves against (the directory the command runs in,
 *   defaulting to the root); `deadline` is the approval's own budget, so a slow
 *   read cannot outlive it. All injectable, so tests stay filesystem-free.
 * @returns { files, refused }
 */
export async function fetchEvidence(needs, { root, base, maxBytes = 16_384, deadline, resolvePath = fsRealpath, readFile: read = fsReadFile, statFile = fsStat } = {}) {
	const files = [];
	const refused = [];
	if (needs.length === 0) return { files, refused };
	const remaining = () => (deadline === undefined ? Number.POSITIVE_INFINITY : deadline - Date.now());
	if (typeof root !== "string" || root === "") {
		for (const need of needs) refused.push({ path: need.path, reason: REFUSAL.outside });
		return { files, refused };
	}
	let rootReal;
	try {
		rootReal = await withDeadline(resolvePath(root), remaining(), REFUSAL.timeout);
	} catch (error) {
		const reason = error?.evidenceReason ?? REFUSAL.unreadable;
		for (const need of needs) refused.push({ path: need.path, reason });
		return { files, refused };
	}
	const origin = typeof base === "string" && base !== "" ? base : root;
	for (const need of needs) {
		// The requested name is checked first (cheap, and gives the clearest
		// reason), then the resolved path is checked again below.
		if (isCredentialPath(need.path)) {
			refused.push({ path: need.path, reason: REFUSAL.credential });
			continue;
		}
		if (remaining() <= 0) {
			refused.push({ path: need.path, reason: REFUSAL.timeout });
			continue;
		}
		let targetReal;
		try {
			// Resolving and stat-ing can block too (a hung network mount, a slow
			// symlink chain), so they share the approval's deadline with the read.
			targetReal = await withDeadline(resolvePath(resolve(origin, need.path)), remaining(), REFUSAL.timeout);
		} catch (error) {
			// missing file, permission failure, symlink loop: all "cannot verify"
			refused.push({ path: need.path, reason: error?.evidenceReason ?? REFUSAL.unreadable });
			continue;
		}
		const rel = relative(rootReal, targetReal);
		const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
		if (!inside) {
			refused.push({ path: need.path, reason: REFUSAL.outside });
			continue;
		}
		// A symlink inside the workspace can still point at a credential file
		// inside the workspace: the resolved path is what decides.
		if (isCredentialPath(targetReal)) {
			refused.push({ path: need.path, reason: REFUSAL.credential });
			continue;
		}
		try {
			const info = await withDeadline(statFile(targetReal), remaining(), REFUSAL.timeout);
			if (info === null || typeof info !== "object" || typeof info.isFile !== "function" || info.isFile() !== true) {
				refused.push({ path: need.path, reason: REFUSAL.notAFile });
				continue;
			}
			if (typeof info.size === "number" && info.size > MAX_EVIDENCE_FILE_BYTES) {
				refused.push({ path: need.path, reason: REFUSAL.tooLarge });
				continue;
			}
		} catch (error) {
			refused.push({ path: need.path, reason: error?.evidenceReason ?? REFUSAL.unreadable });
			continue;
		}
		let text;
		try {
			const value = await withDeadline(read(targetReal, "utf8"), remaining(), REFUSAL.timeout);
			if (typeof value !== "string") {
				refused.push({ path: need.path, reason: REFUSAL.unreadable });
				continue;
			}
			text = value;
		} catch (error) {
			const reason = error?.evidenceReason ?? REFUSAL.unreadable;
			refused.push({ path: need.path, reason });
			continue;
		}
		if (text.includes("\u0000")) {
			refused.push({ path: need.path, reason: REFUSAL.binary });
			continue;
		}
		const bytes = Buffer.byteLength(text, "utf8");
		const truncated = text.length > maxBytes;
		files.push({
			path: need.path,
			bytes,
			truncated,
			text: truncated ? text.slice(0, maxBytes) : text
		});
	}
	return { files, refused };
}
