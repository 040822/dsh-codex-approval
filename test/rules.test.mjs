import { test } from "node:test";
import assert from "node:assert/strict";
import { wildcardMatch, matchableText, evaluateRules, foldQuotedLiterals, classifyRequest, isStructuredRule, ruleLabel } from "../rules.js";

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

// ---- flagGuard rules (2026-10-06) -----------------------------------------

const GUARD = [{ tool: "bash", flagGuard: "recursive-delete", action: "ask" }];

test("flagGuard: a semantic rule matches on argv, not on a text prefix", () => {
	const hit = (command, toolName = "bash", rules = GUARD) => {
		const shape = classifyRequest(toolName, command);
		return evaluateRules(rules, { toolName, argsText: command, reason: "" }, shape)?.action;
	};
	// every spelling a glob list cannot enumerate — one rule
	for (const command of [
		"rm -rf ./dist",
		"rm -rvf ./dist",
		"rm -vrf ./dist",
		"rm -r -f ./dist",
		"rm --recursive --force ./dist",
		"/bin/rm -rvf ./dist",
		"rm -R ./dist",
		"cd packages/app && rm -rvf node_modules"
	]) {
		assert.equal(hit(command), "ask", command);
	}
	// not a recursive delete: the rule says nothing about it
	assert.equal(hit("rm ./dist"), undefined);
	assert.equal(hit("rm -f ./dist"), undefined);
	assert.equal(hit("cp -rf a b"), undefined);
});

test("flagGuard: an opaque command has no argv, so only the text rules can fire", () => {
	// `$DIR` makes the command opaque — the argv never exists, and the guard
	// deliberately stays silent rather than guessing
	assert.equal(evaluateRules(GUARD, { toolName: "bash", argsText: "rm -rf $DIR/x", reason: "" }, classifyRequest("bash", "rm -rf $DIR/x")), null);
	// `{}` in a `find -exec` is grouping to the recognizer, so that command is
	// opaque too — the literal in the text is what catches it
	const findExec = "find . -type d -exec rm -rf {} +";
	assert.equal(evaluateRules(GUARD, { toolName: "bash", argsText: findExec, reason: "" }, classifyRequest("bash", findExec)), null);
	for (const command of ["rm -rf $DIR/x", findExec]) {
		const withTextRule = [...GUARD, { match: "Bash(*rm -rf*)", action: "ask" }];
		assert.equal(
			evaluateRules(withTextRule, { toolName: "bash", argsText: command, reason: "" }, classifyRequest("bash", command))?.action,
			"ask",
			command
		);
	}
});

test("flagGuard: the rule only ever speaks for its own tool", () => {
	const rules = [{ tool: "pwsh", flagGuard: "recursive-delete", action: "ask" }];
	assert.equal(evaluateRules(rules, { toolName: "bash", argsText: "rm -rf x", reason: "" }, classifyRequest("bash", "rm -rf x")), null);
	assert.equal(
		evaluateRules(rules, { toolName: "pwsh", argsText: "Remove-Item -Recurse -Force C:\\x", reason: "" }, classifyRequest("pwsh", "Remove-Item -Recurse -Force C:\\x"))?.action,
		"ask"
	);
});

test("isStructuredRule / ruleLabel: the flagGuard form is a structured rule and labels itself", () => {
	const rule = { tool: "bash", flagGuard: "recursive-delete", action: "ask" };
	assert.equal(isStructuredRule(rule), true);
	assert.equal(ruleLabel(rule), "Bash(flagGuard:recursive-delete)");
	assert.equal(ruleLabel({ tool: "pwsh", flagGuard: "recursive-delete", action: "ask" }), "Pwsh(flagGuard:recursive-delete)");
	// a pattern rule keeps its old label
	assert.equal(ruleLabel({ tool: "bash", pattern: ["rm"], action: "ask" }), "Bash(rm*)");
});

// ---- glob options: caseSensitive / unless (2026-10-06) --------------------

test("wildcardMatch: caseSensitive stops the folding that makes -D and -d one rule", () => {
	assert.equal(wildcardMatch("*git branch -D *", "git branch -D feature"), true);
	assert.equal(wildcardMatch("*git branch -D *", "git branch -d feature"), true, "folds by default");
	assert.equal(wildcardMatch("*git branch -D *", "git branch -d feature", true), false);
	assert.equal(wildcardMatch("*git branch -D *", "git branch -D feature", true), true);
	// folding is still the default for everything else
	assert.equal(wildcardMatch("RM -RF *", "rm -rf /x"), true);
});

test("evaluateRules: unless exempts a request from the rule that matched it", () => {
	const rules = [{ match: "Bash(*git restore*)", action: "deny", unless: "Bash(*git restore --staged*)" }];
	const hit = (command) => {
		const shape = classifyRequest("bash", command);
		return evaluateRules(rules, { toolName: "bash", argsText: command, reason: "" }, shape)?.action;
	};
	assert.equal(hit("git restore ."), "deny");
	assert.equal(hit("git restore src/app.js"), "deny");
	// the exempted form is not claimed by anything, so it falls through to the
	// judge rather than being refused
	assert.equal(hit("git restore --staged ."), undefined);
	assert.equal(hit("git restore --staged src/app.js"), undefined);
	// a list of patterns works, and the exemption is evaluated on the same
	// surfaces the rule matched (a spliced spelling included)
	const listed = [{ match: "*git restore*", action: "deny", unless: ["*--staged*"] }];
	const bare = "git restore --staged .";
	assert.equal(evaluateRules(listed, { toolName: "bash", argsText: bare, reason: "" }, classifyRequest("bash", bare)), null);
	// the exemption does not leak: another rule with no `unless` still refuses it
	const both = [{ match: "*git restore*", action: "deny", unless: "*--staged*" }, { match: "*staged*", action: "deny" }];
	assert.equal(evaluateRules(both, { toolName: "bash", argsText: bare, reason: "" }, classifyRequest("bash", bare))?.action, "deny");
});

test("evaluateRules: same-action rules keep list order, which is how a narrower deny wins", () => {
	// the restored-with-worktree form must be named before the `unless` rule,
	// otherwise the exemption would swallow it
	const rules = [
		{ match: "Bash(*git restore*--worktree*)", action: "deny" },
		{ match: "Bash(*git restore*)", action: "deny", unless: "Bash(*git restore --staged*)" }
	];
	const hit = (command) => {
		const shape = classifyRequest("bash", command);
		return evaluateRules(rules, { toolName: "bash", argsText: command, reason: "" }, shape)?.match;
	};
	assert.equal(hit("git restore --staged --worktree ."), "Bash(*git restore*--worktree*)");
	assert.equal(hit("git restore --staged ."), undefined);
});
