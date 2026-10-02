/**
 * dsh-codex-approval — evidence.js
 *
 * The read-only evidence fetch behind the judge's `needs` request.
 *
 * `bash scripts/deploy.sh` is a one-line request whose real effect lives in
 * another file. The judge may therefore ask for a bounded, *workspace-local*
 * read before deciding — but the plugin, not the judge, decides what is
 * readable: every path is re-resolved through `realpath`, must land inside the
 * workspace root, and must not be a credential file or a binary. Anything the
 * judge asks for that fails those checks is refused and recorded, never
 * silently dropped, so "I could not see it" stays visible in the audit.
 *
 * The judge never gets a shell, a directory listing, or an arbitrary read: it
 * names files, this module answers with bounded text or a refusal reason.
 *
 * Functions take injectable `resolvePath` / `readFile`, so every rule is
 * unit-testable without touching the filesystem.
 */

import { readFile as fsReadFile, realpath as fsRealpath } from "node:fs/promises";
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
	binary: "binary"
};

/**
 * Files that are never handed to the judge: private keys, cloud credentials,
 * tool auth files, and the harness's own provider config (which carries API
 * keys).
 */
const CREDENTIAL_PATH = [
	/(^|\/)\.ssh(\/|$)/i,
	/(^|\/)\.aws(\/|$)/i,
	/(^|\/)\.gnupg(\/|$)/i,
	/(^|\/)\.codex\/auth\.json$/i,
	/(^|\/)\.dsh\/profiles(\/|$)/i,
	/(^|\/)\.dsh\/settings\.yaml$/i,
	/(^|\/)\.env(\.|$)/i,
	/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
	/\.(pem|key|p12|pfx|keystore)$/i,
	/(^|\/)credentials(\.json)?$/i,
	/(^|\/)\.npmrc$/i,
	/(^|\/)\.git-credentials$/i
];

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

/** Whether a requested path looks like a credential file we never read. */
export function isCredentialPath(path) {
	const normalized = path.replace(/\\/g, "/");
	return CREDENTIAL_PATH.some((pattern) => pattern.test(normalized));
}

/**
 * Fetch the evidence a verdict asked for, under the plugin's whitelist.
 *
 * Every entry ends up either in `files` (verified, bounded text) or in
 * `refused` (with a reason) — a judge that cannot see a file must be told so,
 * because "unknown" is a judgement input, not a silent omission.
 *
 * @param needs - cleaned needs (parseNeeds)
 * @param opts - { root, base, maxBytes, resolvePath, readFile }
 *   `root` is the workspace boundary every path must stay inside; `base` is
 *   what a relative path resolves against (the directory the command runs in,
 *   defaulting to the root). Both injectable so tests stay filesystem-free.
 * @returns { files, refused }
 */
export async function fetchEvidence(needs, { root, base, maxBytes = 16_384, resolvePath = fsRealpath, readFile: read = fsReadFile } = {}) {
	const files = [];
	const refused = [];
	if (needs.length === 0) return { files, refused };
	if (typeof root !== "string" || root === "") {
		for (const need of needs) refused.push({ path: need.path, reason: REFUSAL.outside });
		return { files, refused };
	}
	let rootReal;
	try {
		rootReal = await resolvePath(root);
	} catch {
		for (const need of needs) refused.push({ path: need.path, reason: REFUSAL.unreadable });
		return { files, refused };
	}
	const origin = typeof base === "string" && base !== "" ? base : root;
	for (const need of needs) {
		if (isCredentialPath(need.path)) {
			refused.push({ path: need.path, reason: REFUSAL.credential });
			continue;
		}
		let targetReal;
		try {
			targetReal = await resolvePath(resolve(origin, need.path));
		} catch {
			// missing file, permission failure, symlink loop: all "cannot verify"
			refused.push({ path: need.path, reason: REFUSAL.unreadable });
			continue;
		}
		const rel = relative(rootReal, targetReal);
		const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
		if (!inside) {
			refused.push({ path: need.path, reason: REFUSAL.outside });
			continue;
		}
		let text;
		try {
			const value = await read(targetReal, "utf8");
			if (typeof value !== "string") {
				refused.push({ path: need.path, reason: REFUSAL.unreadable });
				continue;
			}
			text = value;
		} catch {
			refused.push({ path: need.path, reason: REFUSAL.unreadable });
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
