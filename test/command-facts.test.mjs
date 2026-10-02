import { test } from "node:test";
import assert from "node:assert/strict";
import { commandFacts, DESTRUCTIVE_OPTIONS } from "../command-facts.js";
import { classifyCommand } from "../shell-shape.js";

/** facts for one command, with the real recogniser output behind it. */
const facts = (command, tool = "bash") => commandFacts({ toolName: tool, argsText: command, shapeInfo: classifyCommand(tool, command) });

test("commandFacts: escaping paths are marked, workspace-relative ones are not", () => {
	assert.deepEqual(facts("cat docs/readme.md"), { paths: [{ path: "docs/readme.md" }] });
	assert.deepEqual(facts("cat /etc/passwd"), { paths: [{ path: "/etc/passwd", outside: true }] });
	assert.deepEqual(facts("cat ../outside/x"), { paths: [{ path: "../outside/x", outside: true }] });
	assert.deepEqual(facts("cat ~/.ssh/config"), { paths: [{ path: "~/.ssh/config", outside: true }] });
});

test("commandFacts: an opaque command still yields its target path", () => {
	// The recogniser builds no argv for `echo $(cat /etc/passwd)` — text-level
	// extraction is the only way, and this is the exact case the live baseline
	// caught being approved.
	assert.deepEqual(facts("echo $(cat /etc/passwd)"), { paths: [{ path: "/etc/passwd", outside: true }] });
	assert.deepEqual(facts("cat /dev/null > /tmp/x"), { paths: [{ path: "/dev/null", outside: true }, { path: "/tmp/x", outside: true }] });
});

test("commandFacts: hosts and destructive options come from the text", () => {
	assert.deepEqual(facts("curl -s https://api.github.com/repos/x"), { hosts: ["api.github.com"] });
	const rsync = facts("rsync -a --delete ./dist/ deploy@prod.example.tld:/var/www/");
	assert.deepEqual(rsync.hosts, ["prod.example.tld"]);
	assert.deepEqual(rsync.destructive, ["--delete"]);
	assert.ok(rsync.paths.some((entry) => entry.path === "/var/www/" && entry.outside === true), JSON.stringify(rsync.paths));
	assert.deepEqual(facts("git reset --hard HEAD~3"), { destructive: ["--hard"] });
	assert.deepEqual(facts("Remove-Item -Recurse -Force C:\\Users", "pwsh").destructive, ["-recurse", "-force"]);
	assert.deepEqual(facts("npm publish --force").destructive, ["--force"]);
});

test("commandFacts: localhost is not a destination worth reporting", () => {
	assert.equal(facts("curl -s http://127.0.0.1:8317/v1/models"), null);
	assert.equal(facts("curl -s http://localhost:8080/x"), null);
});

test("commandFacts: a plain command adds nothing at all", () => {
	assert.equal(facts("git status"), null);
	assert.equal(facts("npm run build"), null);
	assert.equal(commandFacts({ toolName: "bash", argsText: "", shapeInfo: null }), null);
	assert.equal(commandFacts({ toolName: "bash", argsText: "ls", shapeInfo: null }), null);
	assert.equal(commandFacts({ toolName: "bash", argsText: "echo hello", shapeInfo: null }), null);
});

test("commandFacts: the lists stay bounded", () => {
	const many = facts(`cat /a /b /c /d /e /f /g /h`);
	assert.ok(many.paths.length <= 6, JSON.stringify(many.paths));
	const flags = facts("rsync --delete --hard --force --mirror --prune --overwrite --no-preserve-root a b");
	assert.ok(flags.destructive.length <= 6);
	assert.ok(DESTRUCTIVE_OPTIONS.includes("--delete"));
});

test("commandFacts: nothing emitted carries an un-redacted credential", () => {
	// The recogniser's argv comes from the RAW command, so a credential that
	// redaction already removed from argsText could ride back in through a "path"
	// that happens to contain a slash.
	const bearer = facts('curl -H "Authorization: Bearer sk-abcdefgh12345678" https://api.example.com/x');
	assert.equal(JSON.stringify(bearer).includes("sk-abcdefgh12345678"), false);
	// `--password=…` is the shape redaction recognises; either way nothing with a
	// slash may smuggle the value back in.
	const password = facts("mysql -u root --password=pass/word/secret -h db.example.tld");
	assert.equal(JSON.stringify(password).includes("pass/word/secret"), false);
	assert.deepEqual(bearer.hosts, ["api.example.com"]);
});

test("commandFacts: every field is bounded, per item and in total", () => {
	const long = `cat ${"/x".repeat(4000)}`;
	const out = facts(long);
	assert.ok(JSON.stringify(out).length < 500, `facts must stay small, got ${JSON.stringify(out).length}`);
	assert.ok(out.paths.every((entry) => entry.path.length <= 200));
	const manyHosts = facts("curl https://a.example.tld https://b.example.tld https://c.example.tld https://d.example.tld https://e.example.tld");
	assert.ok(manyHosts.hosts.length <= 4, JSON.stringify(manyHosts.hosts));
});

test("commandFacts: inline code and prose are neither paths nor destinations", () => {
	assert.deepEqual(facts("sed -i 's/foo/bar/g' docs/a.md"), { paths: [{ path: "docs/a.md" }] });
	assert.deepEqual(facts('python3 -c "print(1/2)"'), null);
	assert.deepEqual(facts('git commit -m "fix: see docs.example.com:8080"'), null);
	// ... but a network command's quoted target IS a destination
	assert.deepEqual(facts('rsync -a ./d/ "deploy@prod.example.tld:/srv"').hosts, ["prod.example.tld"]);
});

test("commandFacts: URL userinfo is stripped and ssh-like targets are found", () => {
	assert.deepEqual(facts("curl https://user:pass@host.example.tld/v1/x").hosts, ["host.example.tld"]);
	assert.deepEqual(facts("ssh deploy@prod.example.tld").hosts, ["prod.example.tld"]);
	assert.deepEqual(facts("nc db.internal.tld 5432").hosts, ["db.internal.tld"]);
	assert.deepEqual(facts("git push git@github.com:owner/repo.git").hosts, ["github.com"]);
	assert.deepEqual(facts("curl http://[::1]:8080/x"), null);
});
