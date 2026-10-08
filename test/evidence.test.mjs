import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNeeds, isCredentialPath, fetchEvidence, REFUSAL } from "../evidence.js";

/** A fake filesystem: `files` maps paths to text, `dirs` lists what realpath resolves. */
function fakeFs(files, dirs = []) {
	const known = new Set([...Object.keys(files), ...dirs]);
	const resolvePath = async (path) => {
		if (!known.has(path)) {
			const error = new Error(`ENOENT: ${path}`);
			error.code = "ENOENT";
			throw error;
		}
		return path;
	};
	const readFile = async (path) => {
		if (!(path in files)) {
			const error = new Error(`ENOENT: ${path}`);
			error.code = "ENOENT";
			throw error;
		}
		return files[path];
	};
	// Regular files by default; `kinds` can mark a path as a FIFO/directory for
	// the file-type guard.
	const kinds = arguments[1] === undefined ? {} : {};
	const statFile = async (path) => {
		if (!(path in files)) {
			const error = new Error(`ENOENT: ${path}`);
			error.code = "ENOENT";
			throw error;
		}
		const kind = kinds[path] ?? "file";
		return {
			size: Buffer.byteLength(files[path], "utf8"),
			isFile: () => kind === "file",
			kind
		};
	};
	return { resolvePath, readFile, statFile };
}

test("parseNeeds: keeps read-file requests, cleans and bounds them", () => {
	assert.deepEqual(
		parseNeeds([
			{ type: "read-file", path: "scripts/deploy.sh", why: "deployment target" },
			{ type: "read-file", path: "scripts/deploy.sh", why: "duplicate" },
			{ type: "list-dir", path: "/" },
			{ type: "read-file", path: "  " },
			{ type: "READ-FILE", path: "b.txt" }
		]),
		[
			{ path: "scripts/deploy.sh", why: "deployment target" },
			{ path: "b.txt", why: "" }
		]
	);
});

test("parseNeeds: caps the number of requests and rejects junk shapes", () => {
	assert.equal(parseNeeds([{ type: "read-file", path: "a" }, { type: "read-file", path: "b" }, { type: "read-file", path: "c" }], 2).length, 2);
	assert.deepEqual(parseNeeds("nope"), []);
	assert.deepEqual(parseNeeds([null, 42, "x", []]), []);
	assert.deepEqual(parseNeeds([{ type: "read-file", path: "x".repeat(600) }]), []);
	assert.deepEqual(parseNeeds([{ type: "read-file", path: "a\u0000b" }]), []);
});

test("isCredentialPath: refuses key material, tool auth files and provider config", () => {
	for (const path of ["/home/wenxin/.ssh/id_rsa", ".env", "config/.env.local", "~/.aws/credentials", "/home/wenxin/.codex/auth.json", "/home/wenxin/.dsh/profiles/web/package.json", "/home/wenxin/.dsh/settings.yaml", "keys/server.pem", "deploy.key", ".npmrc", ".git-credentials"]) {
		assert.equal(isCredentialPath(path), true, path);
	}
	for (const path of ["docs/.aws-guide.md", "docs/.ssh-notes.md", "src/keyboard.js", "id_rsa.pub", "env.example"]) {
		assert.equal(isCredentialPath(path), false, path);
	}
});

test("fetchEvidence: reads a workspace-local file and reports its size", async () => {
	const { resolvePath, readFile, statFile } = fakeFs({ "/ws/scripts/deploy.sh": "#!/bin/sh\nrsync -a ./dist/ prod:/var/www\n" }, ["/ws", "/ws/scripts"]);
	const { files, refused } = await fetchEvidence([{ path: "scripts/deploy.sh", why: "target" }], { root: "/ws", base: "/ws", resolvePath, readFile, statFile });
	assert.equal(refused.length, 0);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, "scripts/deploy.sh");
	assert.equal(files[0].truncated, false);
	assert.equal(files[0].bytes, Buffer.byteLength("#!/bin/sh\nrsync -a ./dist/ prod:/var/www\n", "utf8"));
	assert.match(files[0].text, /prod:\/var\/www/);
});

test("fetchEvidence: a relative path resolves against the command's own directory", async () => {
	const { resolvePath, readFile, statFile } = fakeFs({ "/ws/sub/run.sh": "echo hi" }, ["/ws", "/ws/sub"]);
	const { files } = await fetchEvidence([{ path: "run.sh", why: "script" }], { root: "/ws", base: "/ws/sub", resolvePath, readFile, statFile });
	assert.equal(files.length, 1);
	assert.equal(files[0].text, "echo hi");
});

test("fetchEvidence: escapes, credentials, binaries and missing files are refused with a reason", async () => {
	const { resolvePath, readFile, statFile } = fakeFs({
		"/ws/ok.txt": "fine",
		"/ws/.ssh/id_rsa": "PRIVATE KEY",
		"/ws/bin.dat": "a\u0000b",
		"/outside/secret.txt": "secret"
	}, ["/ws", "/ws/.ssh", "/outside"]);
	const { files, refused } = await fetchEvidence([
		{ path: ".ssh/id_rsa", why: "x" },
		{ path: "bin.dat", why: "x" },
		{ path: "missing.txt", why: "x" },
		{ path: "../outside/secret.txt", why: "x" },
		{ path: "ok.txt", why: "x" }
	], { root: "/ws", base: "/ws", resolvePath, readFile, statFile });
	assert.deepEqual(files.map((file) => file.path), ["ok.txt"]);
	assert.deepEqual(refused, [
		{ path: ".ssh/id_rsa", reason: REFUSAL.credential },
		{ path: "bin.dat", reason: REFUSAL.binary },
		{ path: "missing.txt", reason: REFUSAL.unreadable },
		{ path: "../outside/secret.txt", reason: REFUSAL.outside }
	]);
});

test("fetchEvidence: an over-long file is truncated, not skipped", async () => {
	const big = "x".repeat(1000);
	const { resolvePath, readFile, statFile } = fakeFs({ "/ws/big.txt": big }, ["/ws"]);
	const { files } = await fetchEvidence([{ path: "big.txt", why: "x" }], { root: "/ws", base: "/ws", maxBytes: 100, resolvePath, readFile, statFile });
	assert.equal(files[0].truncated, true);
	assert.equal(files[0].bytes, 1000);
	assert.equal(files[0].text.length, 100);
});

test("fetchEvidence: without a workspace root nothing is readable", async () => {
	const { resolvePath, readFile, statFile } = fakeFs({ "x.txt": "content" });
	const { files, refused } = await fetchEvidence([{ path: "x.txt", why: "x" }], { root: undefined, resolvePath, readFile, statFile });
	assert.deepEqual(files, []);
	assert.deepEqual(refused, [{ path: "x.txt", reason: REFUSAL.outside }]);
});

test("fetchEvidence: a root that cannot be resolved refuses everything", async () => {
	const { resolvePath, readFile, statFile } = fakeFs({ "x.txt": "content" });
	const { files, refused } = await fetchEvidence([{ path: "x.txt", why: "x" }], { root: "/nowhere", resolvePath, readFile, statFile });
	assert.deepEqual(files, []);
	assert.deepEqual(refused, [{ path: "x.txt", reason: REFUSAL.unreadable }]);
});

test("fetchEvidence: no needs means no work and no refusals", async () => {
	const { files, refused } = await fetchEvidence([], { root: "/ws" });
	assert.deepEqual(files, []);
	assert.deepEqual(refused, []);
});

test("fetchEvidence: a symlink to a credential file is refused by its resolved path (finding 3)", async () => {
	const files = { "/ws/notes.txt": "SECRET=1", "/ws/.env": "SECRET=1" };
	const links = { "/ws/notes.txt": "/ws/.env" };
	const resolvePath = async (path) => links[path] ?? path;
	const readFile = async (path) => files[path];
	const statFile = async (path) => ({ size: Buffer.byteLength(files[path] ?? "", "utf8"), isFile: () => true });
	const { files: fetched, refused } = await fetchEvidence([{ path: "notes.txt", why: "context" }], { root: "/ws", base: "/ws", resolvePath, readFile, statFile });
	assert.deepEqual(fetched, [], "an innocent name must not smuggle a credential file in");
	assert.deepEqual(refused, [{ path: "notes.txt", reason: REFUSAL.credential }]);
});

test("isCredentialPath: auth.json and the common CLI credential stores are refused anywhere", () => {
	for (const path of ["auth.json", ".codex-run/auth.json", "/srv/app/auth.json", ".netrc", "_netrc", ".config/gh/hosts.yml", ".docker/config.json", ".kube/config"]) {
		assert.equal(isCredentialPath(path), true, path);
	}
	for (const path of ["auth.json.md", "docs/auth.md", "src/authorization.js", "package.json"]) {
		assert.equal(isCredentialPath(path), false, path);
	}
});

test("fetchEvidence: non-regular files and a spent deadline are refused", async () => {
	const files = { "/ws/pipe": "x", "/ws/ok.txt": "ok" };
	const resolvePath = async (path) => path;
	const readFile = async (path) => files[path];
	const statFile = async (path) => ({ size: 1, isFile: () => path !== "/ws/pipe" });
	const { files: fetched, refused } = await fetchEvidence([{ path: "pipe", why: "x" }, { path: "ok.txt", why: "y" }], { root: "/ws", base: "/ws", resolvePath, readFile, statFile });
	assert.deepEqual(fetched.map((f) => f.path), ["ok.txt"]);
	assert.deepEqual(refused, [{ path: "pipe", reason: REFUSAL.notAFile }]);

	const spent = await fetchEvidence([{ path: "ok.txt", why: "y" }], { root: "/ws", base: "/ws", deadline: Date.now() - 1, resolvePath, readFile, statFile });
	assert.deepEqual(spent.files, []);
	assert.deepEqual(spent.refused, [{ path: "ok.txt", reason: REFUSAL.timeout }]);
});

test("isCredentialPath: the names cloud CLIs actually write are refused", () => {
	// Each of these was readable before: the segment patterns anchored the name
	// (`credentials` did not match `.credentials.json`), or the name was simply
	// never listed.
	for (const path of [
		".credentials.json", "/home/u/.claude/.credentials.json",
		"service-account.json", "gcp-service-account-prod.json",
		".config/gcloud/application_default_credentials.json",
		"kubeconfig", "/home/u/.kube/config",
		".pgpass", ".pypirc", ".my.cnf", ".htpasswd",
		".bash_history", ".zsh_history", "terraform.tfstate", ".envrc",
		"/home/u/.docker/config.json"
	]) {
		assert.equal(isCredentialPath(path), true, `${path} must be refused`);
	}
	// …while ordinary files stay readable, so the refusal list keeps meaning
	// something instead of covering everything.
	for (const path of ["notes.txt", "src/index.js", "README.md", "app.key.pub", "x.pem.md", "history.txt"]) {
		assert.equal(isCredentialPath(path), false, `${path} must stay readable`);
	}
});

test("isCredentialPath: a backup suffix does not launder a credential name", () => {
	// Renaming a key file out of the way is not a way past a name list.
	for (const path of ["x.pem.bak", "id_rsa.old", "credentials.json.1", "secret.key.bak", ".npmrc.backup", "terraform.tfstate.backup", "id_ed25519.save.bak"]) {
		assert.equal(isCredentialPath(path), true, `${path} must be refused`);
	}
});

test("fetchEvidence: a path swapped for a symlink between the check and the read is refused", async () => {
	// The whitelist used to be checked on a string and then re-resolved three
	// more times: `realpath` → `stat` → `read`, all following whatever the path
	// pointed at by then (CWE-367). Swapping the file for a symlink after the
	// checks passed handed over the file the whitelist had just refused.
	const { mkdtempSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { realpath } = await import("node:fs/promises");
	const root = mkdtempSync(join(tmpdir(), "ev-race-"));
	const outside = mkdtempSync(join(tmpdir(), "ev-out-"));
	const secret = join(outside, "secret.txt");
	writeFileSync(secret, "OUTSIDE-SECRET");
	const target = join(root, "notes.txt");
	writeFileSync(target, "fine");
	let swapped = false;
	const racingResolve = async (path) => {
		const real = await realpath(path);
		if (real.endsWith("notes.txt") && !swapped) {
			swapped = true;
			rmSync(real);
			symlinkSync(secret, real);
		}
		return real;
	};
	const { files, refused } = await fetchEvidence([{ path: "notes.txt", why: "x" }], { root, base: root, resolvePath: racingResolve });
	assert.deepEqual(files, [], "the swapped path must not be read");
	assert.equal(refused.length, 1);
	// The old implementation returned files[0].text === "OUTSIDE-SECRET" here.
	assert.equal(refused[0].reason, REFUSAL.unreadable, "O_NOFOLLOW turns the race into a refusal");
});

test("fetchEvidence: through the real default reader, files are read and non-files are refused", async () => {
	// The single-fd path is what production uses; these pin its decisions.
	const { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = mkdtempSync(join(tmpdir(), "ev-fd-"));
	writeFileSync(join(root, "ok.txt"), "hello");
	mkdirSync(join(root, "adir"));
	symlinkSync(join(root, "ok.txt"), join(root, "link.txt"));

	const read = await fetchEvidence([{ path: "ok.txt", why: "x" }], { root, base: root });
	assert.equal(read.files.length, 1);
	assert.equal(read.files[0].text, "hello");
	assert.equal(read.files[0].bytes, 5);

	// A directory is not a regular file.
	const dir = await fetchEvidence([{ path: "adir", why: "x" }], { root, base: root });
	assert.deepEqual(dir.files, []);
	assert.equal(dir.refused[0].reason, REFUSAL.notAFile);

	// A symlink the resolver did not follow (injected as "already resolved") is
	// refused rather than followed — that is the whole point of O_NOFOLLOW.
	const { realpath } = await import("node:fs/promises");
	const link = await fetchEvidence([{ path: "link.txt", why: "x" }], { root, base: root, resolvePath: async () => join(root, "link.txt") });
	assert.deepEqual(link.files, []);
	assert.ok([REFUSAL.unreadable, REFUSAL.notAFile].includes(link.refused[0].reason), link.refused[0].reason);
	void realpath;
});
