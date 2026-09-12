import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJudgeMessages, parseVerdict, decideAuthorization, judgeWith } from "../judge.js";

test("buildJudgeMessages: single user message with strict instruction", () => {
	const [message] = buildJudgeMessages({ toolName: "bash", argsText: "git status", reason: "escalate" });
	assert.equal(message.role, "user");
	assert.equal(message.content.length, 1);
	assert.match(message.content[0].text, /approval judge/);
	assert.match(message.content[0].text, /"git status"/);
	assert.match(message.content[0].text, /"escalate"/);
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

test("parseVerdict: balanced scan takes the first complete object", () => {
	const text = '{"risk":"low","authorization":"allow","reason":"one"} then {"risk":"high","authorization":"deny","reason":"two"}';
	assert.deepEqual(parseVerdict(text), { risk: "low", authorization: "allow", reason: "one" });
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

test("decideAuthorization: direct allow/deny respected regardless of tolerance", () => {
	assert.equal(decideAuthorization({ risk: "high", authorization: "allow" }, "low"), "allow");
	assert.equal(decideAuthorization({ risk: "low", authorization: "deny" }, "high"), "deny");
});

test("decideAuthorization: ask verdict falls back to tolerance", () => {
	assert.equal(decideAuthorization({ risk: "low", authorization: "ask" }, "medium"), "allow");
	assert.equal(decideAuthorization({ risk: "medium", authorization: "ask" }, "medium"), "allow");
	assert.equal(decideAuthorization({ risk: "high", authorization: "ask" }, "medium"), "ask");
	assert.equal(decideAuthorization({ risk: "high", authorization: "ask" }, "high"), "allow");
	assert.equal(decideAuthorization({ risk: "medium", authorization: "ask" }, "low"), "ask");
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
	assert.equal(result.error, "unparseable judge output");
});

test("buildJudgeMessages: allowAsk=false forbids ask in the prompt", () => {
	const [message] = buildJudgeMessages({ toolName: "bash", argsText: "ls", reason: "" }, { allowAsk: false });
	const text = message.content[0].text;
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
	assert.match(seen[0][0].content[0].text, /"ask" is NOT available/);
});

test("buildJudgeMessages: context block appended after the request JSON", () => {
	const [message] = buildJudgeMessages({ toolName: "pwsh", argsText: "Remove-Item x", reason: "r", context: "[U] 用户: 清理\n[T] pwsh(ls) → ok" });
	const text = message.content[0].text;
	const blockIdx = text.indexOf("\nContext:\n");
	assert.ok(blockIdx > text.indexOf("Remove-Item"), "context comes after the request JSON");
	assert.match(text, /Context:\n\[U\] 用户: 清理/);
});

test("buildJudgeMessages: empty context is omitted entirely", () => {
	const [withCtx] = buildJudgeMessages({ toolName: "pwsh", argsText: "ls", reason: "" });
	assert.doesNotMatch(withCtx.content[0].text, /\nContext:\n/);
	const [withEmpty] = buildJudgeMessages({ toolName: "pwsh", argsText: "ls", reason: "", context: "" });
	assert.doesNotMatch(withEmpty.content[0].text, /\nContext:\n/);
});

test("buildJudgeMessages: intent-first rule present in prompt", () => {
	const [message] = buildJudgeMessages({ toolName: "pwsh", argsText: "ls", reason: "" });
	assert.match(message.content[0].text, /User intent matters/);
});

test("buildJudgeMessages: NO_ASK variant keeps intent rule and context", () => {
	const [message] = buildJudgeMessages({ toolName: "pwsh", argsText: "ls", reason: "", context: "[U] 用户: x" }, { allowAsk: false });
	const text = message.content[0].text;
	assert.match(text, /User intent matters/);
	assert.match(text, /Context:\n\[U\] 用户: x/);
	assert.match(text, /"ask" is NOT available/);
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
	assert.match(seen[0][0].content[0].text, /Context:\n\[U\] 用户: 检查/);
});
