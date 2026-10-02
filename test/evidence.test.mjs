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
	return { resolvePath, readFile };
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
	const { resolvePath, readFile } = fakeFs({ "/ws/scripts/deploy.sh": "#!/bin/sh\nrsync -a ./dist/ prod:/var/www\n" }, ["/ws", "/ws/scripts"]);
	const { files, refused } = await fetchEvidence([{ path: "scripts/deploy.sh", why: "target" }], { root: "/ws", base: "/ws", resolvePath, readFile });
	assert.equal(refused.length, 0);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, "scripts/deploy.sh");
	assert.equal(files[0].truncated, false);
	assert.equal(files[0].bytes, Buffer.byteLength("#!/bin/sh\nrsync -a ./dist/ prod:/var/www\n", "utf8"));
	assert.match(files[0].text, /prod:\/var\/www/);
});

test("fetchEvidence: a relative path resolves against the command's own directory", async () => {
	const { resolvePath, readFile } = fakeFs({ "/ws/sub/run.sh": "echo hi" }, ["/ws", "/ws/sub"]);
	const { files } = await fetchEvidence([{ path: "run.sh", why: "script" }], { root: "/ws", base: "/ws/sub", resolvePath, readFile });
	assert.equal(files.length, 1);
	assert.equal(files[0].text, "echo hi");
});

test("fetchEvidence: escapes, credentials, binaries and missing files are refused with a reason", async () => {
	const { resolvePath, readFile } = fakeFs({
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
	], { root: "/ws", base: "/ws", resolvePath, readFile });
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
	const { resolvePath, readFile } = fakeFs({ "/ws/big.txt": big }, ["/ws"]);
	const { files } = await fetchEvidence([{ path: "big.txt", why: "x" }], { root: "/ws", base: "/ws", maxBytes: 100, resolvePath, readFile });
	assert.equal(files[0].truncated, true);
	assert.equal(files[0].bytes, 1000);
	assert.equal(files[0].text.length, 100);
});

test("fetchEvidence: without a workspace root nothing is readable", async () => {
	const { resolvePath, readFile } = fakeFs({ "x.txt": "content" });
	const { files, refused } = await fetchEvidence([{ path: "x.txt", why: "x" }], { root: undefined, resolvePath, readFile });
	assert.deepEqual(files, []);
	assert.deepEqual(refused, [{ path: "x.txt", reason: REFUSAL.outside }]);
});

test("fetchEvidence: a root that cannot be resolved refuses everything", async () => {
	const { resolvePath, readFile } = fakeFs({ "x.txt": "content" });
	const { files, refused } = await fetchEvidence([{ path: "x.txt", why: "x" }], { root: "/nowhere", resolvePath, readFile });
	assert.deepEqual(files, []);
	assert.deepEqual(refused, [{ path: "x.txt", reason: REFUSAL.unreadable }]);
});

test("fetchEvidence: no needs means no work and no refusals", async () => {
	const { files, refused } = await fetchEvidence([], { root: "/ws" });
	assert.deepEqual(files, []);
	assert.deepEqual(refused, []);
});
