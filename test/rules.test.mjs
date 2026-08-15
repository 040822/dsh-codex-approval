import { test } from "node:test";
import assert from "node:assert/strict";
import { wildcardMatch, matchableText, evaluateRules } from "../rules.js";

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
