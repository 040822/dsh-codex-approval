import { test } from "node:test";
import assert from "node:assert/strict";
import { wildcardMatch, matchableText, evaluateRules, foldQuotedLiterals, classifyRequest } from "../rules.js";

test("wildcardMatch: basic cases", () => {
	assert.equal(wildcardMatch("Bash(git *)", "Bash(git status --short)"), true);
	assert.equal(wildcardMatch("Bash(git *)", "Bash(rm -rf /)"), false);
	assert.equal(wildcardMatch("*", "anything at all"), true);
	assert.equal(wildcardMatch("Bash(ls)", "Bash(ls)"), true);
	assert.equal(wildcardMatch("Bash(ls)", "Bash(ls -la)"), false);
	assert.equal(wildcardMatch("Bash(ls?)", "Bash(lsa)"), true);
	assert.equal(wildcardMatch("Bash(ls?)", "Bash(ls)"), false);
});

test("wildcardMatch: destructive patterns", () => {
	assert.equal(wildcardMatch("Bash(rm -rf /*)", "Bash(rm -rf /home/u/x)"), true);
	assert.equal(wildcardMatch("Bash(rm -rf /*)", "Bash(rm -rf /)"), true);
	assert.equal(wildcardMatch("Bash(rm -rf ~*)", "Bash(rm -rf ~/Downloads)"), true);
	assert.equal(wildcardMatch("reason:*curl*", "reason:escalate sandbox to danger-full-access: need curl to fetch config"), true);
});

test("matchableText: combines tool(args) and reason", () => {
	const text = matchableText({ toolName: "bash", argsText: "git status", reason: "escalate: need write" });
	assert.equal(text, "bash(git status) reason:escalate: need write");
});

test("wildcardMatch: tool-name casing is not significant", () => {
	assert.equal(wildcardMatch("Bash(git *)", "bash(git status)"), true);
	assert.equal(wildcardMatch("reason:*Password*", "reason:need the password to proceed"), true);
});

test("evaluateRules: deny beats allow regardless of order", () => {
	const rules = [
		{ match: "Bash(*)", action: "allow" },
		{ match: "Bash(rm *)", action: "deny" }
	];
	const rule = evaluateRules(rules, { toolName: "bash", argsText: "rm -rf /tmp/x", reason: "" });
	assert.equal(rule.action, "deny");
	assert.equal(rule.match, "Bash(rm *)");
});

test("evaluateRules: ask beats allow (explicit ask over blanket allow)", () => {
	const rules = [
		{ match: "Bash(git *)", action: "allow" },
		{ match: "Bash(git push*)", action: "ask" }
	];
	const rule = evaluateRules(rules, { toolName: "bash", argsText: "git push origin main", reason: "" });
	assert.equal(rule.action, "ask");
});

test("evaluateRules: deny beats ask", () => {
	const rules = [
		{ match: "Bash(rm *)", action: "ask" },
		{ match: "Bash(rm -rf /*)", action: "deny" }
	];
	const rule = evaluateRules(rules, { toolName: "bash", argsText: "rm -rf /tmp/x", reason: "" });
	assert.equal(rule.action, "deny");
});

test("evaluateRules: reason glob matches via combined text", () => {
	const rules = [{ match: "reason:*curl*", action: "ask" }];
	const rule = evaluateRules(rules, { toolName: "bash", argsText: "git status", reason: "escalate: need curl for config fetch" });
	assert.equal(rule.action, "ask");
});

test("evaluateRules: no match returns null", () => {
	assert.equal(evaluateRules([{ match: "Bash(nope*)", action: "allow" }], { toolName: "bash", argsText: "ls", reason: "" }), null);
});

test("evaluateRules: empty text returns null (no matchable surface)", () => {
	assert.equal(evaluateRules([{ match: "*", action: "allow" }], { toolName: "", argsText: "", reason: "" }), null);
});

test("evaluateRules: first matching rule within same priority wins", () => {
	const rules = [
		{ match: "Bash(git push*)", action: "ask" },
		{ match: "Bash(git *)", action: "ask" }
	];
	const rule = evaluateRules(rules, { toolName: "bash", argsText: "git push origin main", reason: "" });
	assert.equal(rule.match, "Bash(git push*)");
});

test("evaluateRules: Pwsh rule matches pwsh tool calls (Windows)", () => {
	const rules = [
		{ match: "Bash(git status*)", action: "ask" },
		{ match: "Pwsh(git status*)", action: "allow" }
	];
	const rule = evaluateRules(
		rules,
		{ toolName: "pwsh", argsText: "git status --short", reason: "" },
		{ shape: "simple", argv: ["git", "status", "--short"] }
	);
	assert.equal(rule.action, "allow");
	assert.equal(rule.match, "Pwsh(git status*)");
});

test("evaluateRules: Bash rule does not match pwsh calls and vice versa", () => {
	const rules = [
		{ match: "Bash(git *)", action: "allow" },
		{ match: "Pwsh(Get-ChildItem *)", action: "allow" }
	];
	// pwsh call never matches the Bash rule (platform isolation)
	assert.equal(evaluateRules(rules, { toolName: "pwsh", argsText: "git status", reason: "" }), null);
	// bash call never matches the Pwsh rule
	assert.equal(evaluateRules(rules, { toolName: "bash", argsText: "Get-ChildItem /tmp", reason: "" }), null);
});

test("foldQuotedLiterals: a glued quote is folded, a standalone argument is not", () => {
	assert.equal(foldQuotedLiterals('bash(rm -r"f" /tmp/x)'), "bash(rm -rf /tmp/x)");
	assert.equal(foldQuotedLiterals("bash(cat ~/.ss''h/i''d_rsa)"), "bash(cat ~/.ssh/id_rsa)");
	// a quoted block that stands on its own keeps its quotes: `echo 'rm -rf /'`
	// prints that text, it does not run it, and the fold must not pretend it does
	assert.equal(foldQuotedLiterals("bash(echo 'rm -rf /')"), "bash(echo 'rm -rf /')");
	assert.equal(foldQuotedLiterals('bash(cat "a b")'), 'bash(cat "a b")');
	assert.equal(foldQuotedLiterals(""), "");
});

test("evaluateRules: spliced-token rewrites still reach the safety rules", () => {
	const rules = [
		{ match: "*rm -rf /*", action: "deny" },
		{ match: "Bash(npm publish*)", action: "ask" }
	];
	const hit = (command) => {
		const shape = classifyRequest("bash", command);
		return evaluateRules(rules, { toolName: "bash", argsText: command, reason: "" }, shape)?.action;
	};
	// an extra space or a tab: the shell runs `npm publish`
	assert.equal(hit("npm  publish"), "ask");
	assert.equal(hit("npm\tpublish"), "ask");
	// a spliced option letter: the shell runs `rm -rf /tmp/x`
	assert.equal(hit('rm -r"f" /tmp/x'), "deny");
	// the folded surface reaches an opaque command, which has no argv to rebuild
	const opaque = "cat ~/.ss''h/i''d_rsa";
	assert.equal(
		evaluateRules([{ match: "*id_rsa*", action: "ask" }], { toolName: "bash", argsText: opaque, reason: "" }, classifyRequest("bash", opaque))?.action,
		"ask"
	);
	// the rebuilt-argv surface also keeps a legitimately quoted call matched
	assert.equal(
		evaluateRules([{ match: "Bash(git status)", action: "allow" }], { toolName: "bash", argsText: 'git "status"', reason: "" }, classifyRequest("bash", 'git "status"'))?.action,
		"allow"
	);
});
