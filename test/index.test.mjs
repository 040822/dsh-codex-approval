import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, normalizeConfig, createHandler, makeRecorder } from "../index.js";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function baseConfig(overrides = {}) {
	return normalizeConfig({
		...overrides,
		rules: overrides.rules ?? [{ match: "Bash(git *)", action: "allow" }, { match: "Bash(rm *)", action: "deny" }]
	});
}

/** Build a fake request with a session event containing the tool call. */
function makeReq({ toolName = "bash", callId = "call-1", reason = "", aborted = false, command = "git status" } = {}) {
	const events = [{
		type: "assistant/message",
		data: { message: { content: [{ type: "tool-call", id: callId, name: toolName, arguments: JSON.stringify({ command, description: "x" }) }] } }
	}];
	const req = { toolName, callId, reason, agent: { id: "agent-1", session: { id: "sess-1", events } } };
	if (aborted) req.signal = { aborted: true, addEventListener() {} };
	return req;
}

async function run(handler, req) {
	const nextCalls = [];
	const outcome = await handler(req, async () => {
		nextCalls.push("next");
		return "unavailable";
	});
	return { outcome, nextCalls };
}

test("normalizeConfig: defaults are valid and complete", () => {
	const cfg = normalizeConfig({});
	assert.equal(cfg.enabled, true);
	assert.equal(cfg.ai.enabled, true);
	assert.equal(cfg.ai.riskTolerance, "medium");
	assert.equal(cfg.fallback, "ask");
	assert.ok(cfg.rules.length > 0);
});

test("normalizeConfig: rejects invalid values loudly", () => {
	assert.throws(() => normalizeConfig({ enabled: "yes" }), TypeError);
	assert.throws(() => normalizeConfig({ rules: [{ match: "", action: "allow" }] }), TypeError);
	assert.throws(() => normalizeConfig({ rules: [{ match: "Bash(*)", action: "maybe" }] }), TypeError);
	assert.throws(() => normalizeConfig({ ai: { riskTolerance: "extreme" } }), TypeError);
	assert.throws(() => normalizeConfig({ ai: { failOpen: "explode" } }), TypeError);
	assert.throws(() => normalizeConfig({ fallback: "whatever" }), TypeError);
});

test("handler: rule allow → allowed-once, no next()", async () => {
	const cfg = baseConfig({ ai: { enabled: false } });
	const handler = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: async () => {
			throw new Error("AI must not be called when a rule matches");
		}
	});
	const { outcome, nextCalls } = await run(handler, makeReq({ command: "git status" }));
	assert.equal(outcome, "allowed-once");
	assert.equal(nextCalls.length, 0);
});

test("handler: rule deny → rejected, no next()", async () => {
	const cfg = baseConfig({ ai: { enabled: false } });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: true, text: '{"risk":"low","authorization":"allow"}' }) });
	const { outcome, nextCalls } = await run(handler, makeReq({ command: "rm -rf /tmp/x" }));
	assert.equal(outcome, "rejected");
	assert.equal(nextCalls.length, 0);
});

test("handler: rule ask → delegates to next()", async () => {
	const cfg = baseConfig({ rules: [{ match: "Bash(git *)", action: "ask" }], ai: { enabled: false } });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: true, text: "{}" }) });
	const { outcome, nextCalls } = await run(handler, makeReq({ command: "git status" }));
	assert.equal(outcome, "unavailable"); // next() returned "unavailable" (human absent in test)
	assert.equal(nextCalls.length, 1);
});

test("handler: AI allow → allowed-once", async () => {
	const cfg = baseConfig({ rules: [] });
	const handler = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: '{"risk":"low","authorization":"allow","reason":"safe"}' })
	});
	const { outcome } = await run(handler, makeReq({ command: "cat /tmp/x" }));
	assert.equal(outcome, "allowed-once");
});

test("handler: AI deny → rejected", async () => {
	const cfg = baseConfig({ rules: [] });
	const handler = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: '{"risk":"high","authorization":"deny","reason":"destructive"}' })
	});
	const { outcome } = await run(handler, makeReq({ command: "mkfs /dev/sda1" }));
	assert.equal(outcome, "rejected");
});

test("handler: AI ask + risk within tolerance → allowed-once", async () => {
	const cfg = baseConfig({ rules: [], ai: { riskTolerance: "medium" } });
	const handler = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: '{"risk":"low","authorization":"ask","reason":"borderline"}' })
	});
	const { outcome } = await run(handler, makeReq({ command: "touch /opt/x" }));
	assert.equal(outcome, "allowed-once");
});

test("handler: AI ask + risk above tolerance → delegates to next()", async () => {
	const cfg = baseConfig({ rules: [], ai: { riskTolerance: "medium" } });
	const handler = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: '{"risk":"high","authorization":"ask","reason":"risky"}' })
	});
	const { outcome, nextCalls } = await run(handler, makeReq({ command: "rm -r /opt/x" }));
	assert.equal(outcome, "unavailable");
	assert.equal(nextCalls.length, 1);
});

test("handler: AI error → failOpen ask → delegates to next()", async () => {
	const cfg = baseConfig({ rules: [], ai: { failOpen: "ask" } });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: false, error: "timeout" }) });
	const { outcome, nextCalls } = await run(handler, makeReq({ command: "something" }));
	assert.equal(outcome, "unavailable");
	assert.equal(nextCalls.length, 1);
});

test("handler: AI error → failOpen deny → rejected without next()", async () => {
	const cfg = baseConfig({ rules: [], ai: { failOpen: "deny" } });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: false, error: "no model" }) });
	const { outcome, nextCalls } = await run(handler, makeReq({ command: "something" }));
	assert.equal(outcome, "rejected");
	assert.equal(nextCalls.length, 0);
});

test("handler: no rules + AI disabled → fallback ask → next()", async () => {
	const cfg = baseConfig({ rules: [], ai: { enabled: false }, fallback: "ask" });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: true, text: "{}" }) });
	const { outcome, nextCalls } = await run(handler, makeReq({ command: "whatever" }));
	assert.equal(outcome, "unavailable");
	assert.equal(nextCalls.length, 1);
});

test("handler: disabled plugin → straight to next()", async () => {
	const cfg = baseConfig({ enabled: false });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: true, text: "{}" }) });
	const { outcome, nextCalls } = await run(handler, makeReq({ command: "rm -rf /" }));
	assert.equal(outcome, "unavailable");
	assert.equal(nextCalls.length, 1);
});

test("handler: aborted signal → cancelled, no decision", async () => {
	const cfg = baseConfig();
	let recorded = false;
	const handler = createHandler({ config: cfg, record: async () => { recorded = true; }, llmRunner: async () => ({ ok: true, text: "{}" }) });
	const { outcome, nextCalls } = await run(handler, makeReq({ command: "git status", aborted: true }));
	assert.equal(outcome, "cancelled");
	assert.equal(recorded, false);
	assert.equal(nextCalls.length, 0);
});

test("handler: records the decision to the recorder", async () => {
	const cfg = baseConfig({ ai: { enabled: false } });
	const entries = [];
	const handler = createHandler({
		config: cfg,
		record: async (entry) => entries.push(entry),
		llmRunner: async () => ({ ok: true, text: "{}" })
	});
	await run(handler, makeReq({ command: "git status", reason: "escalate sandbox" }));
	assert.equal(entries.length, 1);
	const entry = entries[0];
	assert.equal(entry.toolName, "bash");
	assert.equal(entry.action, "allow");
	assert.equal(entry.outcome, "allowed-once");
	assert.equal(entry.kind, "rule");
	assert.equal(entry.argsPreview, "git status");
	assert.equal(entry.sessionId, "sess-1");
	assert.equal(entry.reason, "escalate sandbox");
	assert.ok(typeof entry.ms === "number");
});

test("makeRecorder: writes JSONL and creates the directory", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-codex-approval-"));
	const file = join(dir, "logs", "approval.jsonl");
	const recorder = makeRecorder(file);
	await recorder({ a: 1 });
	await recorder({ a: 2 });
	const lines = readFileSync(file, "utf8").trim().split("\n");
	assert.equal(lines.length, 2);
	assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
	assert.ok(existsSync(file));
});

test("makeRecorder: never throws on failure", async () => {
	const recorder = makeRecorder("/nonexistent-root-xyz/approval.jsonl");
	await recorder({ a: 1 }); // must not reject
});

test("apply: registers the approval/request listener and self-proves", async () => {
	const { apply } = await import("../index.js");
	const listeners = {};
	const logFile = join(mkdtempSync(join(tmpdir(), "dsh-codex-approval-")), "logs", "approval.jsonl");
	const ctx = {
		on: (name, fn) => { listeners[name] = fn; },
		logger: { info: () => {}, warn: () => {} }
	};
	await apply(ctx, { logFile });
	assert.deepEqual(Object.keys(listeners), ["approval/request"]);
	// the plugin-loaded self-proof record is written
	const lines = readFileSync(logFile, "utf8").trim().split("\n");
	assert.equal(JSON.parse(lines[0]).event, "plugin-loaded");
});
