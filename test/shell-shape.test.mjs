import { test } from "node:test";
import assert from "node:assert/strict";
import {
	classifyCommand,
	forbiddenOptionHit,
	isShellTool,
	isWorkspaceRelativePath,
	positionalArgs,
	recursiveDeleteFlags
} from "../shell-shape.js";

/**
 * shell-shape tests: the recognizer that decides whether a command's text may
 * be trusted for a deterministic allow. Regression cases come from the
 * 2026-09-22 approval audit, where every "simple" string below was previously
 * auto-approved through a `Bash(cat *)` / `Bash(echo *)` style prefix rule.
 */

test("classifyCommand: plain single commands are simple with a usable argv", () => {
	const shape = classifyCommand("bash", "git status --short");
	assert.equal(shape.shape, "simple");
	assert.deepEqual(shape.argv, ["git", "status", "--short"]);
	assert.equal(shape.reason, null);

	assert.equal(classifyCommand("bash", "cat file.txt").shape, "simple");
	assert.equal(classifyCommand("bash", "ls -la").shape, "simple");
	assert.equal(classifyCommand("bash", "git log --oneline -5").shape, "simple");
});

test("classifyCommand: quotes do not leak expansion", () => {
	// single quotes never expand → the literal string is a plain word
	const literal = classifyCommand("bash", "echo '$(rm -rf /)'");
	assert.equal(literal.shape, "simple");
	assert.deepEqual(literal.argv, ["echo", "$(rm -rf /)"]);
	// double quotes DO expand → opaque
	assert.equal(classifyCommand("bash", 'echo "$(rm -rf /)"').shape, "opaque");
	assert.equal(classifyCommand("bash", 'echo "${HOME}"').shape, "opaque");
	assert.equal(classifyCommand("bash", 'echo "`id`"').shape, "opaque");
});

test("classifyCommand: command substitution, redirection and assignment are opaque", () => {
	assert.equal(classifyCommand("bash", "echo $(touch /tmp/x)").shape, "opaque");
	assert.equal(classifyCommand("bash", "cat /dev/null > /tmp/x").shape, "opaque");
	assert.equal(classifyCommand("bash", "cat < /etc/shadow").shape, "opaque");
	assert.equal(classifyCommand("bash", "FOO=bar ls").shape, "opaque");
	assert.equal(classifyCommand("bash", "echo `id`").shape, "opaque");
	assert.equal(classifyCommand("bash", "cat ~/.ssh/id_rsa").shape, "opaque");
	assert.equal(classifyCommand("bash", "cat *.pem").shape, "opaque");
	assert.equal(classifyCommand("bash", "ls /tmp | wc -l").shape, "compound");
});

test("classifyCommand: separators produce compound, never simple", () => {
	const compound = classifyCommand("bash", "git status; rm -rf /tmp/x");
	assert.equal(compound.shape, "compound");
	assert.deepEqual(compound.parts, [["git", "status"], ["rm", "-rf", "/tmp/x"]]);

	assert.equal(classifyCommand("bash", "git status && rm -rf /tmp/x").shape, "compound");
	assert.equal(classifyCommand("bash", "git status || true").shape, "compound");
	assert.equal(classifyCommand("bash", "false & git status").shape, "opaque"); // background
	assert.equal(classifyCommand("bash", ";; ls").shape, "opaque");
});

test("classifyCommand: malformed or exotic input is opaque, never simple", () => {
	assert.equal(classifyCommand("bash", "").shape, "opaque");
	assert.equal(classifyCommand("bash", "   ").shape, "opaque");
	assert.equal(classifyCommand("bash", "echo 'unterminated").shape, "opaque");
	assert.equal(classifyCommand("bash", "ls\nrm -rf /").shape, "opaque");
	assert.equal(classifyCommand("bash", "ls # comment").shape, "opaque");
	assert.equal(classifyCommand("bash", "eval ls").shape, "simple"); // harmless: `eval ls` is not in any allow rule
});

test("classifyCommand: pwsh is stricter than bash (no compound verdict)", () => {
	assert.equal(classifyCommand("pwsh", "Get-ChildItem -Path src").shape, "simple");
	assert.equal(classifyCommand("pwsh", "git status").shape, "simple");
	assert.equal(classifyCommand("pwsh", "Get-ChildItem .; Remove-Item x -Recurse -Force").shape, "opaque");
	assert.equal(classifyCommand("pwsh", "Remove-Item x | Out-Null").shape, "opaque");
	assert.equal(classifyCommand("pwsh", "Get-ChildItem $(whoami)").shape, "opaque");
	assert.equal(classifyCommand("pwsh", 'Get-ChildItem "$env:USERPROFILE"').shape, "opaque");
	assert.equal(classifyCommand("pwsh", "Get-ChildItem `-Path x").shape, "opaque");
	assert.equal(classifyCommand("pwsh", "Get-ChildItem a,b").shape, "opaque");
});

test("classifyCommand: non-shell tools are not classified", () => {
	const shape = classifyCommand("write_file", '{"path":"/etc/passwd"}');
	assert.equal(shape.shape, "not-shell");
	assert.equal(shape.argv, null);
	assert.equal(isShellTool("bash"), true);
	assert.equal(isShellTool("PWSH"), true);
	assert.equal(isShellTool("write_file"), false);
});

test("positionalArgs: options are skipped, path targets survive", () => {
	assert.deepEqual(positionalArgs(["cat", "-n", "file.txt"], 1), ["file.txt"]);
	assert.deepEqual(positionalArgs(["Get-Content", "-Path", "x"], 1), ["x"]);
	assert.deepEqual(positionalArgs(["git", "status"], 2), []);
});

test("positionalArgs: `--` terminator and inline option values are never dropped", () => {
	// PowerShell's documented colon form — the value *is* the argument, so the
	// path is inside it (`Get-Content -Path:..\secret` == `-Path ..\secret`).
	assert.deepEqual(positionalArgs(["Get-Content", "-Path:..\\secret.txt"], 1), ["..\\secret.txt"]);
	assert.deepEqual(positionalArgs(["Get-Content", "-Path:ok.txt"], 1), ["ok.txt"]);
	assert.deepEqual(positionalArgs(["cat", "-Path:..\\secret.txt"], 1), ["..\\secret.txt"]);
	// GNU-style `--flag=value`
	assert.deepEqual(positionalArgs(["cat", "--file=/etc/passwd"], 1), ["/etc/passwd"]);
	// `--` ends option parsing: everything after it is a path, dash or not
	assert.deepEqual(positionalArgs(["cat", "--", "-../../../etc/passwd"], 1), ["-../../../etc/passwd"]);
	assert.deepEqual(positionalArgs(["cat", "--file", "x", "--", "-y"], 1), ["x", "-y"]);
	// a bare `-` is not an option name either: PowerShell reads it as a path
	// (`-LiteralPath '-'`), so it must be resolved, not waved through
	assert.deepEqual(positionalArgs(["cat", "-", "file.txt"], 1), ["-", "file.txt"]);
	// a dash-prefixed argument that is not an option *name* is a path
	assert.deepEqual(positionalArgs(["Get-Content", "-/../../x"], 1), ["-/../../x"]);
	// an inline value stays a path candidate unless it is a *named* count switch
	assert.deepEqual(positionalArgs(["Get-Content", "-ReadCount:0", "README.md"], 1), ["README.md"]);
	assert.deepEqual(positionalArgs(["Get-Content", "-Path:0"], 1), ["0"]);
	assert.deepEqual(positionalArgs(["Get-ChildItem", "-Recurse:true", "x"], 1), ["true", "x"]);
});

test("isWorkspaceRelativePath: rejects anything that can escape the workspace", () => {
	assert.equal(isWorkspaceRelativePath("file.txt"), true);
	assert.equal(isWorkspaceRelativePath("src/app.js"), true);
	assert.equal(isWorkspaceRelativePath("/etc/passwd"), false);
	assert.equal(isWorkspaceRelativePath("~/.ssh/id_rsa"), false);
	assert.equal(isWorkspaceRelativePath("../outside"), false);
	assert.equal(isWorkspaceRelativePath("a/../../b"), false);
	assert.equal(isWorkspaceRelativePath("C:\\Users\\x"), false);
	assert.equal(isWorkspaceRelativePath("\\\\server\\share"), false);
	assert.equal(isWorkspaceRelativePath(""), false);
});

test("forbiddenOptionHit: long, attached and short option forms are all caught", () => {
	assert.equal(forbiddenOptionHit(["git", "diff", "--output=/tmp/x"], ["--output"]), "--output=/tmp/x");
	assert.equal(forbiddenOptionHit(["git", "diff", "--output", "/tmp/x"], ["--output"]), "--output");
	assert.equal(forbiddenOptionHit(["git", "diff", "-O/tmp/order"], ["-O"]), "-O/tmp/order");
	assert.equal(forbiddenOptionHit(["git", "diff"], ["--output", "-O"]), null);
	assert.equal(forbiddenOptionHit(["git", "diff", "--outline"], ["--output"]), null);
});

// ---- recursiveDeleteFlags (2026-10-06) ------------------------------------

test("recursiveDeleteFlags: every bundled spelling of `rm -rf` is one command", () => {
	const recursive = { recursive: true, force: true };
	for (const argv of [
		["rm", "-rf", "x"],
		["rm", "-rfv", "x"],
		["rm", "-rvf", "x"],
		["rm", "-vrf", "x"],
		["rm", "-fr", "x"],
		["rm", "-fvr", "x"],
		["rm", "-r", "-f", "x"],
		["rm", "-f", "-r", "x"],
		["rm", "-rf", "-v", "x"],
		["rm", "--recursive", "--force", "x"],
		["/bin/rm", "-rvf", "x"],
		["rm", "-r", "-v", "-i", "-f", "x"]
	]) {
		assert.deepEqual(recursiveDeleteFlags(argv, "bash"), recursive, JSON.stringify(argv));
	}
});

test("recursiveDeleteFlags: recursive without force still counts, and `-f` alone does not", () => {
	// `rm -r dir` takes the whole tree without prompting for the writable ones:
	// the switch a rule has to see is `-r`, not `-f`
	assert.deepEqual(recursiveDeleteFlags(["rm", "-r", "dir"], "bash"), { recursive: true, force: false });
	assert.deepEqual(recursiveDeleteFlags(["rm", "-R", "dir"], "bash"), { recursive: true, force: false });
	assert.deepEqual(recursiveDeleteFlags(["rm", "--recursive", "dir"], "bash"), { recursive: true, force: false });
	assert.deepEqual(recursiveDeleteFlags(["rm", "-f", "file"], "bash"), { recursive: false, force: true });
	// `--` ends option parsing: a later `-rf` is a path
	assert.deepEqual(recursiveDeleteFlags(["rm", "--", "-rf"], "bash"), { recursive: false, force: false });
});

test("recursiveDeleteFlags: programs that are not a deletion, or not `rm`, are null", () => {
	assert.deepEqual(recursiveDeleteFlags(["rm", "file.txt"], "bash"), { recursive: false, force: false });
	assert.equal(recursiveDeleteFlags(["cp", "-rf", "a", "b"], "bash"), null);
	assert.equal(recursiveDeleteFlags(["rmdir", "-p", "a/b"], "bash"), null);
	assert.equal(recursiveDeleteFlags(["find", ".", "-delete"], "bash"), null);
	assert.equal(recursiveDeleteFlags([], "bash"), null);
	assert.equal(recursiveDeleteFlags(null, "bash"), null);
	// a non-shell tool never reaches this judgement, even with rm-looking argv
	assert.equal(recursiveDeleteFlags(["rm", "-rf", "x"], "write"), null);
});

test("recursiveDeleteFlags: pwsh Remove-Item and its aliases count `-Recurse`", () => {
	assert.deepEqual(recursiveDeleteFlags(["Remove-Item", "-Recurse", "-Force", "C:\\x"], "pwsh"), { recursive: true, force: true });
	// PowerShell accepts any unique prefix of the parameter name
	assert.deepEqual(recursiveDeleteFlags(["Remove-Item", "-r", "C:\\x"], "pwsh"), { recursive: true, force: false });
	assert.deepEqual(recursiveDeleteFlags(["Remove-Item", "-Force", "C:\\x"], "pwsh"), { recursive: false, force: true });
	for (const program of ["rm", "rd", "rmdir", "ri", "del", "erase"]) {
		assert.deepEqual(recursiveDeleteFlags([program, "-Recurse", "x"], "pwsh"), { recursive: true, force: false }, program);
	}
	assert.deepEqual(recursiveDeleteFlags(["Remove-Item", "C:\\x"], "pwsh"), { recursive: false, force: false });
	assert.equal(recursiveDeleteFlags(["Get-ChildItem", "-Recurse"], "pwsh"), null);
	assert.equal(recursiveDeleteFlags(["Remove-Item", "-Recurse"], "bash"), null);
});
