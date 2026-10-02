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
