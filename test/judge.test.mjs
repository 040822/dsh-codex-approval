import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJudgeMessages, parseVerdict, decidePolicy, POLICY_RULES, judgeWith } from "../judge.js";

test("buildJudgeMessages: policy is a system message, the request a user message", () => {
	const [system, user] = buildJudgeMessages({ toolName: "bash", argsText: "git status", reason: "escalate" });
	assert.equal(system.role, "system");
	assert.equal(user.role, "user");
	assert.equal(system.content.length, 1);
	assert.match(system.content[0].text, /approval judge/);
	// The untrusted request text must not sit on the instruction level.
	assert.doesNotMatch(system.content[0].text, /"git status"|"escalate"/);
	assert.match(user.content[0].text, /"git status"/);
	assert.match(user.content[0].text, /"escalate"/);
});

test("parseVerdict: valid verdict", () => {
	assert.deepEqual(parseVerdict('{"risk":"high","authorization":"deny","reason":"rm -rf /"}'), {
		risk: "high",
		authorization: "deny",
		reason: "rm -rf /"
	});
});

test("parseVerdict: tolerates surrounding prose and code fences", () => {
	const text = 'Sure, here you go:\n```json\n{"risk":"low","authorization":"allow","reason":"read-only"}\n```\ndone';
	assert.deepEqual(parseVerdict(text), { risk: "low", authorization: "allow", reason: "read-only" });
});

test("parseVerdict: pure JSON string parses as a whole", () => {
	const text = '{"risk":"medium","authorization":"ask","reason":"network fetch"}';
	assert.deepEqual(parseVerdict(text), { risk: "medium", authorization: "ask", reason: "network fetch" });
});

test("parseVerdict: balanced scan handles nested braces inside string values", () => {
	const text = 'The risk is {"risk":"high","authorization":"deny","reason":"removes {important} data {a} {b}"} trust me';
	assert.deepEqual(parseVerdict(text), { risk: "high", authorization: "deny", reason: "removes {important} data {a} {b}" });
});

test("parseVerdict: two verdict objects are ambiguous and rejected outright", () => {
	const text = '{"risk":"low","authorization":"allow","reason":"one"} then {"risk":"high","authorization":"deny","reason":"two"}';
	assert.equal(parseVerdict(text), null);
});

test("parseVerdict: one verdict plus an unrelated object still parses", () => {
	const text = 'meta {"note":"not a verdict"} verdict {"risk":"high","authorization":"deny","reason":"rm -rf /"}';
	assert.deepEqual(parseVerdict(text), { risk: "high", authorization: "deny", reason: "rm -rf /" });
});

test("parseVerdict: a verdict wrapped in another object is rejected (fail-safe)", () => {
	const text = '{"wrapper":{"risk":"low","authorization":"ask","reason":"nested"}}';
	assert.equal(parseVerdict(text), null);
});

test("parseVerdict: bare JSON with escaped quotes inside reason", () => {
	const text = '{"risk":"medium","authorization":"ask","reason":"writes \\"config\\" file"}';
	assert.deepEqual(parseVerdict(text), { risk: "medium", authorization: "ask", reason: 'writes "config" file' });
});

test("parseVerdict: rejects invalid enums", () => {
	assert.equal(parseVerdict('{"risk":"extreme","authorization":"allow"}'), null);
	assert.equal(parseVerdict('{"risk":"low","authorization":"maybe"}'), null);
	assert.equal(parseVerdict('{"risk":"low"}'), null);
});

test("parseVerdict: rejects malformed / non-object", () => {
	assert.equal(parseVerdict("not json at all"), null);
	assert.equal(parseVerdict('{"risk":'), null);
	assert.equal(parseVerdict('[]'), null);
	assert.equal(parseVerdict(null), null);
	assert.equal(parseVerdict(undefined), null);
});

test("parseVerdict: reason truncated", () => {
	const long = "r".repeat(500);
	const parsed = parseVerdict(`{"risk":"low","authorization":"allow","reason":"${long}"}`);
	assert.equal(parsed.reason.length, 200);
});

/**
 * The policy matrix: every branch of decidePolicy at every tolerance, asserting
 * both the action AND the branch that produced it. The second half matters as
 * much as the first — a branch that quietly starts reading the tolerance would
 * still return the right action in most rows.
 */
const POLICY_CASES = [
	// judge-deny: the judge's refusal is final at every tolerance
	{ name: "deny/low", verdict: { risk: "low", authorization: "deny" }, tolerance: "low", action: "deny", rule: "judge-deny" },
	{ name: "deny/medium", verdict: { risk: "low", authorization: "deny" }, tolerance: "medium", action: "deny", rule: "judge-deny" },
	{ name: "deny/high", verdict: { risk: "low", authorization: "deny" }, tolerance: "high", action: "deny", rule: "judge-deny" },
	// high risk without a strong user authorization: a human, whatever the tolerance
	{ name: "high-allow-none/low", verdict: { risk: "high", authorization: "allow", userAuthorization: "none" }, tolerance: "low", action: "ask", rule: "high-risk-insufficient-authorization" },
	{ name: "high-allow-weak/medium", verdict: { risk: "high", authorization: "allow", userAuthorization: "weak" }, tolerance: "medium", action: "ask", rule: "high-risk-insufficient-authorization" },
	{ name: "high-allow-unknown/high", verdict: { risk: "high", authorization: "allow" }, tolerance: "high", action: "ask", rule: "high-risk-insufficient-authorization" },
	// a judge "allow" above the tolerance needs the user to have asked for it
	{ name: "medium-allow-weak/low", verdict: { risk: "medium", authorization: "allow", userAuthorization: "weak" }, tolerance: "low", action: "ask", rule: "judge-allow-above-tolerance" },
	{ name: "medium-allow-weak/medium", verdict: { risk: "medium", authorization: "allow", userAuthorization: "weak" }, tolerance: "medium", action: "allow", rule: "judge-allow" },
	{ name: "medium-allow-none/high", verdict: { risk: "medium", authorization: "allow", userAuthorization: "none" }, tolerance: "high", action: "allow", rule: "judge-allow" },
	// judge allow within the tolerance
	{ name: "low-allow/low", verdict: { risk: "low", authorization: "allow" }, tolerance: "low", action: "allow", rule: "judge-allow" },
	{ name: "low-allow/medium", verdict: { risk: "low", authorization: "allow" }, tolerance: "medium", action: "allow", rule: "judge-allow" },
	{ name: "low-allow/high", verdict: { risk: "low", authorization: "allow" }, tolerance: "high", action: "allow", rule: "judge-allow" },
	// a judge "ask" about a LOW-risk action: the tolerance decides, as always
	{ name: "low-ask/low", verdict: { risk: "low", authorization: "ask" }, tolerance: "low", action: "allow", rule: "judge-ask" },
	{ name: "low-ask/medium", verdict: { risk: "low", authorization: "ask" }, tolerance: "medium", action: "allow", rule: "judge-ask" },
	{ name: "low-ask/high", verdict: { risk: "low", authorization: "ask" }, tolerance: "high", action: "allow", rule: "judge-ask" },
	// ... but a judge that doubts a medium-or-worse action nobody authorized does
	// not get waved through, whatever the tolerance says
	{ name: "medium-ask-none/low", verdict: { risk: "medium", authorization: "ask", userAuthorization: "none" }, tolerance: "low", action: "ask", rule: "ask-without-authorization" },
	{ name: "medium-ask-none/medium", verdict: { risk: "medium", authorization: "ask", userAuthorization: "none" }, tolerance: "medium", action: "ask", rule: "ask-without-authorization" },
	{ name: "medium-ask-none/high", verdict: { risk: "medium", authorization: "ask", userAuthorization: "none" }, tolerance: "high", action: "ask", rule: "ask-without-authorization" },
	{ name: "medium-ask-unknown/low", verdict: { risk: "medium", authorization: "ask" }, tolerance: "low", action: "ask", rule: "ask-without-authorization" },
	{ name: "medium-ask-weak/high", verdict: { risk: "medium", authorization: "ask", userAuthorization: "weak" }, tolerance: "high", action: "ask", rule: "ask-without-authorization" },
	// ... unless the user asked for exactly this action, and then the tolerance is back
	{ name: "medium-ask-strong/medium", verdict: { risk: "medium", authorization: "ask", userAuthorization: "strong" }, tolerance: "medium", action: "allow", rule: "judge-ask" },
	{ name: "medium-ask-strong/low", verdict: { risk: "medium", authorization: "ask", userAuthorization: "strong" }, tolerance: "low", action: "ask", rule: "judge-ask" },
	{ name: "high-ask-strong/low", verdict: { risk: "high", authorization: "ask", userAuthorization: "strong" }, tolerance: "low", action: "ask", rule: "judge-ask" },
	{ name: "high-ask-strong/high", verdict: { risk: "high", authorization: "ask", userAuthorization: "strong" }, tolerance: "high", action: "allow", rule: "judge-ask" },
	// explicit user authorization is what carries an above-tolerance allow
	{ name: "medium-allow-strong/low", verdict: { risk: "medium", authorization: "allow", userAuthorization: "strong" }, tolerance: "low", action: "allow", rule: "judge-allow" },
	{ name: "high-allow-strong/low", verdict: { risk: "high", authorization: "allow", userAuthorization: "strong" }, tolerance: "low", action: "allow", rule: "judge-allow" }
];

test("decidePolicy: the full branch × tolerance matrix", () => {
	for (const item of POLICY_CASES) {
		const decision = decidePolicy(item.verdict, { tolerance: item.tolerance });
		assert.equal(decision.action, item.action, `${item.name}: action`);
		assert.equal(decision.rule, item.rule, `${item.name}: branch`);
	}
});

test("decidePolicy: every branch name is exported", () => {
	for (const item of POLICY_CASES) assert.ok(POLICY_RULES.includes(item.rule), item.rule);
});

test("decidePolicy: a judge's allow no longer overrides the tolerance by itself", () => {
	// The old mapping took `{risk: high, authorization: allow}` at face value.
	assert.equal(decidePolicy({ risk: "high", authorization: "allow" }, { tolerance: "low" }).action, "ask");
	assert.equal(decidePolicy({ risk: "high", authorization: "allow" }, { tolerance: "high" }).action, "ask");
	assert.equal(decidePolicy({ risk: "medium", authorization: "allow" }, { tolerance: "low" }).action, "ask");
	// ... and an unknown authorization field is the conservative reading
	assert.equal(decidePolicy({ risk: "medium", authorization: "allow" }, { tolerance: "high" }).action, "allow");
	assert.equal(decidePolicy({ risk: "medium", authorization: "ask" }, { tolerance: "low" }).rule, "ask-without-authorization");
	// ... and a judge's own doubt about a medium-risk action is not waved through
	// just because the tolerance is wide enough.
	assert.equal(decidePolicy({ risk: "medium", authorization: "ask" }, { tolerance: "high" }).action, "ask");
	assert.equal(decidePolicy({ risk: "medium", authorization: "ask" }, { tolerance: "high" }).enforced, true);
});

test("decidePolicy: a missing tolerance falls back to medium", () => {
	// medium + ask + no authorization is an enforced human decision now; what the
	// default tolerance still decides is the low-risk case.
	assert.equal(decidePolicy({ risk: "low", authorization: "ask" }).action, "allow");
	assert.equal(decidePolicy({ risk: "medium", authorization: "ask" }).action, "ask");
	assert.equal(decidePolicy({ risk: "high", authorization: "ask" }).action, "ask");
	assert.equal(decidePolicy({ risk: "low", authorization: "ask" }, {}).action, "allow");
});

test("judgeWith: happy path returns parsed verdict", async () => {
	const runner = async () => ({ ok: true, text: '{"risk":"low","authorization":"allow","reason":"fine"}' });
	const result = await judgeWith({ runner, input: { toolName: "bash", argsText: "ls", reason: "" } });
	assert.equal(result.ok, true);
	assert.deepEqual(result.verdict, { risk: "low", authorization: "allow", reason: "fine" });
});

test("judgeWith: runner failure surfaces error", async () => {
	const runner = async () => ({ ok: false, error: "timeout" });
	const result = await judgeWith({ runner, input: { toolName: "bash", argsText: "ls", reason: "" } });
	assert.equal(result.ok, false);
	assert.equal(result.error, "timeout");
});

test("judgeWith: runner failure preserves structured stream details", async () => {
	const failure = { code: "TIMEOUT", message: "upstream request timed out" };
	const runner = async () => ({
		ok: false,
		error: "judge stream finished with error [TIMEOUT]: upstream request timed out",
		finishKind: "error",
		failure
	});
	const result = await judgeWith({ runner, input: { toolName: "bash", argsText: "ls", reason: "" } });
	assert.equal(result.ok, false);
	assert.equal(result.finishKind, "error");
	assert.deepEqual(result.failure, failure);
});

test("judgeWith: thrown runner error is caught", async () => {
	const runner = async () => {
		throw new Error("boom");
	};
	const result = await judgeWith({ runner, input: { toolName: "bash", argsText: "ls", reason: "" } });
	assert.equal(result.ok, false);
	assert.match(result.error, /boom/);
});

test("judgeWith: unparseable output fails with ok:false", async () => {
	const runner = async () => ({ ok: true, text: "I refuse to answer" });
	const result = await judgeWith({ runner, input: { toolName: "bash", argsText: "ls", reason: "" } });
	assert.equal(result.ok, false);
	assert.equal(result.error, "unparseable judge output (no verdict)");
	assert.equal(result.rawText, "I refuse to answer");
	assert.equal(result.textChars, "I refuse to answer".length);
});

test("judgeWith: an empty reply fails as an empty reply, not as a bare parse error", async () => {
	const runner = async () => ({ ok: true, text: "" });
	const result = await judgeWith({ runner, input: { toolName: "bash", argsText: "ls", reason: "" } });
	assert.equal(result.ok, false);
	assert.equal(result.error, "unparseable judge output (empty reply)");
	assert.equal(result.rawText, "");
	assert.equal(result.textChars, 0);
});

test("judgeWith: a whitespace-only reply is an empty reply too", async () => {
	const runner = async () => ({ ok: true, text: " \n " });
	const result = await judgeWith({ runner, input: { toolName: "bash", argsText: "ls", reason: "" } });
	assert.equal(result.ok, false);
	assert.equal(result.error, "unparseable judge output (empty reply)");
	assert.equal(result.textChars, 3);
});

test("judgeWith: candidate diagnostics are carried through the failure path", async () => {
	const runner = async () => ({
		ok: false,
		error: "unparseable judge output (empty reply)",
		rawText: "",
		textChars: 0,
		endedWithoutFinish: true,
		judgeAttempts: 2,
		judgeTried: ["a/b", "c/d"]
	});
	const result = await judgeWith({ runner, input: { toolName: "bash", argsText: "ls", reason: "" } });
	assert.equal(result.ok, false);
	assert.equal(result.error, "unparseable judge output (empty reply)");
	assert.equal(result.rawText, "");
	assert.equal(result.textChars, 0);
	assert.equal(result.endedWithoutFinish, true);
	assert.equal(result.judgeAttempts, 2);
	assert.deepEqual(result.judgeTried, ["a/b", "c/d"]);
});

test("buildJudgeMessages: allowAsk=false forbids ask in the prompt", () => {
	const [message] = buildJudgeMessages({ toolName: "bash", argsText: "ls", reason: "" }, { allowAsk: false });
	const text = message.content[0].text;
	assert.equal(message.role, "system");
	assert.match(text, /"ask" is NOT available/);
	assert.match(text, /"authorization":"allow\|deny"/);
	assert.doesNotMatch(text, /When uncertain, prefer "ask"/);
});

test("buildJudgeMessages: default prompt still allows ask", () => {
	const [message] = buildJudgeMessages({ toolName: "bash", argsText: "ls", reason: "" });
	const text = message.content[0].text;
	assert.match(text, /"authorization":"allow\|ask\|deny"/);
	assert.match(text, /When uncertain, prefer "ask"/);
});

test("judgeWith: allowAsk=false is forwarded to the messages", async () => {
	const seen = [];
	const runner = async (messages) => {
		seen.push(messages);
		return { ok: true, text: '{"risk":"low","authorization":"allow","reason":"fine"}' };
	};
	const result = await judgeWith({ runner, input: { toolName: "bash", argsText: "ls", reason: "" }, allowAsk: false });
	assert.equal(result.ok, true);
	assert.equal(seen[0][0].role, "system");
	assert.match(seen[0][0].content[0].text, /"ask" is NOT available/);
	assert.equal(seen[0][1].role, "user");
});

test("buildJudgeMessages: context block appended after the request JSON", () => {
	const [, message] = buildJudgeMessages({ toolName: "pwsh", argsText: "Remove-Item x", reason: "r", context: "[U] 用户: 清理\n[T] pwsh(ls) → ok" });
	const text = message.content[0].text;
	const blockIdx = text.indexOf("\nContext:\n");
	assert.ok(blockIdx > text.indexOf("Remove-Item"), "context comes after the request JSON");
	assert.match(text, /Context:\n\[U\] 用户: 清理/);
});

test("buildJudgeMessages: empty context is omitted entirely", () => {
	const [, withCtx] = buildJudgeMessages({ toolName: "pwsh", argsText: "ls", reason: "" });
	assert.doesNotMatch(withCtx.content[0].text, /\nContext:\n/);
	const [, withEmpty] = buildJudgeMessages({ toolName: "pwsh", argsText: "ls", reason: "", context: "" });
	assert.doesNotMatch(withEmpty.content[0].text, /\nContext:\n/);
});

test("buildJudgeMessages: intent-first rule present in prompt", () => {
	const [message] = buildJudgeMessages({ toolName: "pwsh", argsText: "ls", reason: "" });
	assert.match(message.content[0].text, /User intent matters/);
});

test("buildJudgeMessages: NO_ASK variant keeps intent rule and context", () => {
	const [system, user] = buildJudgeMessages({ toolName: "pwsh", argsText: "ls", reason: "", context: "[U] 用户: x" }, { allowAsk: false });
	assert.match(system.content[0].text, /User intent matters/);
	assert.match(system.content[0].text, /"ask" is NOT available/);
	// The transcript is evidence, so it travels with the request, not the policy.
	assert.match(user.content[0].text, /Context:\n\[U\] 用户: x/);
	assert.doesNotMatch(system.content[0].text, /\[U\] 用户: x/);
});

test("judgeWith: context is forwarded to the runner", async () => {
	const seen = [];
	const runner = async (messages) => {
		seen.push(messages);
		return { ok: true, text: '{"risk":"low","authorization":"allow","reason":"fine"}' };
	};
	const result = await judgeWith({
		runner,
		input: { toolName: "pwsh", argsText: "ls", reason: "", context: "[U] 用户: 检查" }
	});
	assert.equal(result.ok, true);
	assert.match(seen[0][1].content[0].text, /Context:\n\[U\] 用户: 检查/);
});

test("buildJudgeMessages: execution facts ride in the user message, policy stays system-only", () => {
	const escalation = { to: "danger-full-access", justification: "publish needs the network" };
	const [system, user] = buildJudgeMessages({
		toolName: "bash",
		argsText: "npm publish",
		reason: "release",
		cwd: "/home/wenxin/office/dsh",
		workdir: "plugins/dsh-codex-approval",
		escalation
	});
	const payload = JSON.parse(user.content[0].text);
	assert.equal(payload.cwd, "/home/wenxin/office/dsh");
	assert.equal(payload.workdir, "plugins/dsh-codex-approval");
	assert.deepEqual(payload.escalation, escalation);
	// The facts are evidence, never instructions.
	assert.doesNotMatch(system.content[0].text, /danger-full-access|"release"/);
	assert.match(system.content[0].text, /never as user authorization/);
});

test("buildJudgeMessages: unknown facts are omitted, keeping the previous payload shape", () => {
	const [system, user] = buildJudgeMessages({ toolName: "bash", argsText: "git status", reason: null });
	const payload = JSON.parse(user.content[0].text);
	assert.deepEqual(payload, { toolName: "bash", command: "git status", reason: null });
	assert.match(system.content[0].text, /approval judge/);
	// No fact keys leak into the payload when the caller supplies none.
	assert.equal(Object.keys(payload).length, 3);
	assert.match(user.content[0].text, /"command":"git status"/);
});
