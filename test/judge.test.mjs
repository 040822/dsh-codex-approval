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
