import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, normalizeConfig, applyConfigSettings, createHandler, makeLlmRunner, makeRecorder, makeModeStore } from "../index.js";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function baseConfig(overrides = {}) {
	return normalizeConfig({
		...overrides,
		rules: overrides.rules ?? [{ match: "Bash(git *)", action: "allow" }, { match: "Bash(rm *)", action: "deny" }]
	});
}

/** Build a fake request with a session event containing the tool call. */
function makeReq({ toolName = "bash", callId = "call-1", reason = "", aborted = false, command = "git status", sessionShape = "both" } = {}) {
	const events = [{
		type: "assistant/message",
		data: { message: { content: [{ type: "tool-call", id: callId, name: toolName, arguments: JSON.stringify({ command, description: "x" }) }] } }
	}];
	const session = { id: "sess-1" };
	if (sessionShape === "legacy" || sessionShape === "both") session.events = events;
	if (sessionShape === "current" || sessionShape === "both") session.snapshotEvents = () => events;
	const req = { toolName, callId, reason, agent: { id: "agent-1", session } };
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

/** A reply that parses into a verdict — the only shape the judge chain accepts. */
const VERDICT_TEXT = '{"risk":"low","authorization":"allow","reason":"read-only"}';

/**
 * A stub `ctx.llm` answering per `provider/model`, recording every call.
 * `{ text }` streams that text and a normal `finish`; `{ text, noFinish: true }`
 * ends the stream without any finish chunk (an AbortSignal cutoff or a dropped
 * connection); `{ error }` reports a provider failure.
 */
function makeStubLlm(answerByModel, calls = []) {
	return {
		async prepareCall(config) {
			calls.push(config);
			const answer = answerByModel[`${config.provider}/${config.model}`] ?? {};
			return {
				config,
				stream: async function* () {
					if (answer.error !== undefined) {
						yield { type: "finish", reason: { kind: "error", failure: answer.error } };
						return;
					}
					yield { type: "text-delta", text: answer.text ?? "" };
					if (answer.noFinish !== true) yield { type: "finish", reason: { kind: "stop" } };
				}
			};
		}
	};
}

test("normalizeConfig: defaults are valid and complete", () => {
	const cfg = normalizeConfig({});
	assert.equal(cfg.enabled, true);
	assert.equal(cfg.ai.enabled, true);
	assert.equal(cfg.ai.riskTolerance, "medium");
	assert.equal(cfg.fallback, "ask");
	assert.ok(cfg.rules.length > 0);
});

test("applyConfigSettings: projects UI settings onto the runtime config", () => {
	const cfg = applyConfigSettings(normalizeConfig({}), {
		provider: "cpa-wx301",
		model: "codex/gpt-5.6-luna",
		riskTolerance: "low",
		failOpen: "deny",
		mode3OnAsk: "allow",
		timeoutMs: 7000,
		maxTokens: 256,
		hardAskOnUnattended: "ask",
		evidenceFetch: "off",
		evidenceMaxFiles: 4,
		evidenceMaxBytes: 8192,
		denyFeedback: false
	});
	assert.equal(cfg.ai.provider, "cpa-wx301");
	assert.equal(cfg.ai.model, "codex/gpt-5.6-luna");
	assert.equal(cfg.ai.riskTolerance, "low");
	assert.equal(cfg.ai.failOpen, "deny");
	assert.equal(cfg.mode3OnAsk, "allow");
	assert.equal(cfg.ai.timeoutMs, 7000);
	assert.equal(cfg.ai.maxTokens, 256);
	assert.equal(cfg.ai.hardAskOnUnattended, "ask");
	assert.equal(cfg.ai.evidenceFetch, "off");
	assert.equal(cfg.ai.evidenceMaxFiles, 4);
	assert.equal(cfg.ai.evidenceMaxBytes, 8192);
	assert.equal(cfg.denyFeedback, false);
});

test("normalizeConfig: rejects invalid values loudly", () => {
	assert.throws(() => normalizeConfig({ enabled: "yes" }), TypeError);
	assert.throws(() => normalizeConfig({ rules: [{ match: "", action: "allow" }] }), TypeError);
	assert.throws(() => normalizeConfig({ rules: [{ match: "Bash(*)", action: "maybe" }] }), TypeError);
	assert.throws(() => normalizeConfig({ ai: { riskTolerance: "extreme" } }), TypeError);
	assert.throws(() => normalizeConfig({ ai: { failOpen: "explode" } }), TypeError);
	assert.throws(() => normalizeConfig({ fallback: "whatever" }), TypeError);
});

test("normalizeConfig: denyFeedback defaults and validation", () => {
	const cfg = normalizeConfig({});
	assert.equal(cfg.denyFeedback, true);
	assert.equal(cfg.denyFeedbackMax, 3);
	assert.throws(() => normalizeConfig({ denyFeedback: "yes" }), TypeError);
	assert.throws(() => normalizeConfig({ denyFeedbackMax: 0 }), TypeError);
	assert.throws(() => normalizeConfig({ denyFeedbackMax: 11 }), TypeError);
	assert.throws(() => normalizeConfig({ denyFeedbackMax: 1.5 }), TypeError);
});

test("normalizeConfig: transcript defaults and validation", () => {
	const cfg = normalizeConfig({});
	assert.equal(cfg.transcript, "off");
	assert.equal(cfg.transcriptMaxChars, 4000);
	assert.throws(() => normalizeConfig({ transcript: "full" }), TypeError);
	assert.throws(() => normalizeConfig({ transcriptMaxChars: 99 }), TypeError);
	assert.throws(() => normalizeConfig({ transcriptMaxChars: 16001 }), TypeError);
	assert.throws(() => normalizeConfig({ transcriptMaxChars: 1.5 }), TypeError);
});

test("DEFAULT_CONFIG: includes Pwsh read-only allow rules for Windows", () => {
	const cfg = normalizeConfig({});
	const pwshRules = cfg.rules.filter((r) => typeof r.tool === "string" && r.tool.toLowerCase() === "pwsh");
	assert.ok(pwshRules.length >= 8, `expected Pwsh rules, got ${pwshRules.length}`);
	assert.ok(pwshRules.every((r) => r.action === "allow"));
	const bashRules = cfg.rules.filter((r) => typeof r.tool === "string" && r.tool.toLowerCase() === "bash");
	assert.ok(bashRules.length > 0, "Bash family must remain for Linux/Raspberry Pi");
});

test("handler: denial is staged into an injected denialFeed", async () => {
	const cfg = baseConfig({ ai: { enabled: false } });
	const denialFeed = new Map();
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: true, text: "{}" }), denialFeed });
	const { outcome } = await run(handler, makeReq({ command: "rm -rf /tmp/x" }));
	assert.equal(outcome, "rejected");
	const queue = denialFeed.get("sess-1");
	assert.ok(Array.isArray(queue) && queue.length === 1);
	assert.equal(queue[0].source, "rule");
});

test("makeLlmRunner: sends the prepared config and messages to the DSH LLM API", async () => {
	const calls = [];
	const llm = {
		async prepareCall(config, signal) {
			calls.push({ config, signal });
			return {
				config,
				stream: async function* ({ messages, signal }) {
					assert.equal(messages[0].content[0].text, "judge");
					assert.ok(signal instanceof AbortSignal);
					yield { type: "text-delta", text: VERDICT_TEXT };
					yield { type: "finish", reason: { kind: "stop" } };
				}
			};
		}
	};
	const runner = makeLlmRunner(llm, { provider: "p", model: "m", timeoutMs: 1000, maxTokens: 7 });
	const result = await runner([{ role: "user", content: [{ type: "text", text: "judge" }] }]);
	assert.equal(result.ok, true);
	assert.equal(result.text, VERDICT_TEXT);
	assert.equal(result.textChars, VERDICT_TEXT.length);
	assert.equal(result.endedWithoutFinish, undefined);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].config, { provider: "p", model: "m", temperature: 0, maxTokens: 7 });
	assert.ok(calls[0].signal instanceof AbortSignal);
});

test("makeLlmRunner: preserves structured provider failure details", async () => {
	const llm = {
		async prepareCall(config) {
			return {
				config,
				stream: async function* () {
					yield {
						type: "finish",
						reason: {
							kind: "error",
							failure: {
								code: "TIMEOUT",
								message: "upstream request timed out",
								status: 504,
								requestId: "req-123"
							}
						}
					};
				}
			};
		}
	};
	const runner = makeLlmRunner(llm, { provider: "p", model: "m", timeoutMs: 1000, maxTokens: 7 });
	const result = await runner([]);
	assert.equal(result.ok, false);
	assert.equal(result.finishKind, "error");
	assert.deepEqual(result.failure, {
		code: "TIMEOUT",
		message: "upstream request timed out",
		status: 504,
		requestId: "req-123"
	});
	assert.match(result.error, /TIMEOUT/);
	assert.match(result.error, /upstream request timed out/);
});

test("makeLlmRunner: falls back safely when provider failure details are missing", async () => {
	const llm = {
		async prepareCall(config) {
			return {
				config,
				stream: async function* () {
					yield { type: "finish", reason: { kind: "error", failure: { code: 42, message: null } } };
				}
			};
		}
	};
	const result = await makeLlmRunner(llm, { provider: "p", model: "m", timeoutMs: 1000, maxTokens: 7 })([]);
	assert.equal(result.ok, false);
	assert.equal(result.finishKind, "error");
	assert.equal(result.failure, undefined);
	assert.equal(result.error, "judge stream finished with error");
});

test("makeLlmRunner: bounds long provider failure messages", async () => {
	const llm = {
		async prepareCall(config) {
			return {
				config,
				stream: async function* () {
					yield { type: "finish", reason: { kind: "error", failure: { code: "SERVER", message: "x".repeat(700) } } };
				}
			};
		}
	};
	const result = await makeLlmRunner(llm, { provider: "p", model: "m", timeoutMs: 1000, maxTokens: 7 })([]);
	assert.equal(result.ok, false);
	assert.equal(result.failure.message.length, 500);
	assert.equal(result.failure.message.endsWith("…"), true);
});

test("makeLlmRunner: redacts credentials in provider failure diagnostics", async () => {
	const llm = {
		async prepareCall(config) {
			return {
				config,
				stream: async function* () {
					yield {
						type: "finish",
						reason: {
							kind: "error",
							failure: {
								code: "AUTH",
								message: "Bearer super-secret-token apiKey=hidden-value https://example.test/?token=query-secret"
							}
						}
					};
				}
			};
		}
	};
	const runner = makeLlmRunner(llm, { provider: "p", model: "m", timeoutMs: 1000, maxTokens: 7 });
	const result = await runner([]);
	assert.equal(result.ok, false);
	assert.match(result.error, /Bearer \[REDACTED\]/);
	assert.match(result.error, /apiKey=\[REDACTED\]/);
	assert.match(result.error, /token=\[REDACTED\]/);
	assert.doesNotMatch(result.error, /super-secret-token|hidden-value|query-secret/);
});

test("makeLlmRunner: preserves aborted finish details", async () => {
	const llm = {
		async prepareCall(config) {
			return {
				config,
				stream: async function* () {
					yield {
						type: "finish",
						reason: { kind: "aborted", failure: { code: "ABORTED", message: "request canceled" } }
					};
				}
			};
		}
	};
	const result = await makeLlmRunner(llm, { provider: "p", model: "m", timeoutMs: 1000, maxTokens: 7 })([]);
	assert.equal(result.ok, false);
	assert.equal(result.finishKind, "aborted");
	assert.deepEqual(result.failure, { code: "ABORTED", message: "request canceled" });
});

test("handler: current Session shape still matches rules", async () => {
	const cfg = baseConfig({ ai: { enabled: false } });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: false, error: "AI must not run" }) });
	const { outcome } = await run(handler, makeReq({ command: "git status", sessionShape: "current" }));
	assert.equal(outcome, "allowed-once");
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

test("handler: AI stream failure is recorded without changing failOpen", async () => {
	const cfg = baseConfig({ rules: [], ai: { failOpen: "deny" } });
	const entries = [];
	const handler = createHandler({
		config: cfg,
		record: async (entry) => entries.push(entry),
		llmRunner: async () => ({
			ok: false,
			error: "judge stream finished with error [RATE_LIMIT]: quota exceeded",
			finishKind: "error",
			failure: { code: "RATE_LIMIT", message: "quota exceeded", status: 429 }
		})
	});
	const { outcome, nextCalls } = await run(handler, makeReq({ command: "npx tinyfish" }));
	assert.equal(outcome, "rejected");
	assert.equal(nextCalls.length, 0);
	assert.equal(entries[0].kind, "ai-error");
	assert.equal(entries[0].finishKind, "error");
	assert.deepEqual(entries[0].failure, { code: "RATE_LIMIT", message: "quota exceeded", status: 429 });
	assert.match(entries[0].error, /RATE_LIMIT/);
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
		inject: () => {},
		logger: { info: () => {}, warn: () => {} }
	};
	await apply(ctx, { logFile });
	// `loader/volatile-update` 是 0.2.0 的 volatile 热更新回调：设置页改动经
	// `updateVolatile` 原地写快照后触发它，用来同步 sessionOverrides 并留审计。
	assert.deepEqual(Object.keys(listeners), ["approval/request", "loader/volatile-update", "agent/pre-step"]);
	assert.equal(typeof listeners["loader/volatile-update"], "function");
	// the plugin-loaded self-proof record is written
	const lines = readFileSync(logFile, "utf8").trim().split("\n");
	assert.equal(JSON.parse(lines[0]).event, "plugin-loaded");
});

// ---------- approval-mode dimension (v0.2.0) ----------

function modeConfig(overrides = {}) {
	return normalizeConfig({
		...overrides,
		rules: overrides.rules ?? [{ match: "Bash(git *)", action: "allow" }, { match: "Bash(rm *)", action: "deny" }, { match: "Bash(askme *)", action: "ask" }],
		ai: { enabled: false }
	});
}

async function runWith(handler, req) {
	const nextCalls = [];
	const outcome = await handler(req, async () => {
		nextCalls.push("next");
		return "unavailable";
	});
	return { outcome, nextCalls };
}

test("handler: manual mode bypasses entirely (no decision, no record)", async () => {
	const cfg = modeConfig({ mode: "manual" });
	let recorded = false;
	const handler = createHandler({ config: cfg, record: async () => { recorded = true; }, llmRunner: async () => ({ ok: true, text: "{}" }) });
	const { outcome, nextCalls } = await runWith(handler, makeReq({ command: "rm -rf /" }));
	assert.equal(outcome, "unavailable");
	assert.equal(nextCalls.length, 1);
	assert.equal(recorded, false);
});

test("handler: ai mode routes rule-ask to the human (next)", async () => {
	const cfg = modeConfig({ mode: "ai" });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: true, text: "{}" }) });
	const { outcome, nextCalls } = await runWith(handler, makeReq({ command: "askme something" }));
	assert.equal(outcome, "unavailable");
	assert.equal(nextCalls.length, 1);
});

test("handler: ai-auto resolves rule-ask via mode3OnAsk=deny without next", async () => {
	const cfg = modeConfig({ mode: "ai-auto", mode3OnAsk: "deny" });
	const entries = [];
	const handler = createHandler({ config: cfg, record: async (e) => entries.push(e), llmRunner: async () => ({ ok: true, text: "{}" }) });
	const { outcome, nextCalls } = await runWith(handler, makeReq({ command: "askme something" }));
	assert.equal(outcome, "rejected");
	assert.equal(nextCalls.length, 0);
	assert.equal(entries[0].mode, "ai-auto");
	assert.equal(entries[0].viaAskResolution, true);
	assert.equal(entries[0].action, "deny");
});

test("handler: ai-auto resolves rule-ask via mode3OnAsk=allow", async () => {
	const cfg = modeConfig({ mode: "ai-auto", mode3OnAsk: "allow" });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: true, text: "{}" }) });
	const { outcome, nextCalls } = await runWith(handler, makeReq({ command: "askme something" }));
	assert.equal(outcome, "allowed-once");
	assert.equal(nextCalls.length, 0);
});

test("handler: ai-auto resolves AI-ask over tolerance via mode3OnAsk", async () => {
	const cfg = modeConfig({ mode: "ai-auto", ai: { enabled: true, riskTolerance: "medium" } });
	const handler = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: '{"risk":"high","authorization":"ask","reason":"risky"}' })
	});
	const { outcome, nextCalls } = await runWith(handler, makeReq({ command: "something" }));
	assert.equal(outcome, "rejected");
	assert.equal(nextCalls.length, 0);
});

test("handler: ai-auto resolves AI failure with failOpen=ask via mode3OnAsk", async () => {
	const cfg = modeConfig({ mode: "ai-auto", ai: { enabled: true, failOpen: "ask" } });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: false, error: "timeout" }) });
	const { outcome, nextCalls } = await runWith(handler, makeReq({ command: "something" }));
	assert.equal(outcome, "rejected");
	assert.equal(nextCalls.length, 0);
});

test("handler: ai-auto keeps rule allow and rule deny unchanged", async () => {
	const cfg = modeConfig({ mode: "ai-auto" });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: true, text: "{}" }) });
	const allowed = await runWith(handler, makeReq({ command: "git status" }));
	assert.equal(allowed.outcome, "allowed-once");
	assert.equal(allowed.nextCalls.length, 0);
	const denied = await runWith(handler, makeReq({ command: "rm -rf /tmp/x" }));
	assert.equal(denied.outcome, "rejected");
	assert.equal(denied.nextCalls.length, 0);
});

test("handler: getSessionMode override switches the effective mode", async () => {
	const cfg = modeConfig({ mode: "ai" });
	const handler = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: "{}" }),
		getSessionMode: async (sessionId) => (sessionId === "sess-1" ? "ai-auto" : undefined)
	});
	const { outcome, nextCalls } = await runWith(handler, makeReq({ command: "askme something" }));
	assert.equal(outcome, "rejected"); // sess-1 override → ai-auto → ask resolves deny
	assert.equal(nextCalls.length, 0);
});

test("handler: record carries the effective mode", async () => {
	const cfg = modeConfig({ mode: "ai" });
	const entries = [];
	const handler = createHandler({ config: cfg, record: async (e) => entries.push(e), llmRunner: async () => ({ ok: true, text: "{}" }) });
	await runWith(handler, makeReq({ command: "rm -rf /tmp/x" }));
	assert.equal(entries[0].mode, "ai");
});

test("normalizeConfig: mode defaults and validation", () => {
	assert.equal(normalizeConfig({}).mode, "ai");
	assert.equal(normalizeConfig({}).mode3OnAsk, "deny");
	assert.equal(normalizeConfig({ mode: "ai-auto", mode3OnAsk: "allow" }).mode3OnAsk, "allow");
	assert.throws(() => normalizeConfig({ mode: "auto" }), TypeError);
	assert.throws(() => normalizeConfig({ mode3OnAsk: "ask" }), TypeError);
});

test("makeModeStore: memory-only when settings service is absent", async () => {
	const store = makeModeStore({ inject: () => {} }, undefined);
	assert.equal(await store.get("s1"), undefined);
	assert.equal(await store.set("s1", "ai-auto"), "memory-only");
	assert.equal(await store.get("s1"), "ai-auto");
	assert.equal(await store.clear("s1"), "memory-only");
	assert.equal(await store.get("s1"), undefined);
});

test("registerModeCommand: registers the command and switches modes (en default)", async () => {
	const { registerModeCommand } = await import("../index.js");
	const store = {
		get: async () => undefined,
		set: async (id, mode) => { lastSet = { id, mode }; return "memory-only"; },
		clear: async () => { cleared = true; return "memory-only"; }
	};
	let lastSet, cleared;
	let registered = null;
	const ctx = {
		inject: (deps, fn) => {
			assert.deepEqual(deps, ["commands"]);
			fn({ commands: { register: (def) => { registered = def; } } });
		}
	};
	const cfg = normalizeConfig({});
	registerModeCommand(ctx, cfg, store); // no getLocale → English
	assert.equal(registered.name, "approval-mode");
	assert.match(registered.description, /Show or switch/);

	// show current
	const shown = await registered.handler({ agent: { session: { id: "s1" } }, rawInput: "" });
	assert.equal(shown.kind, "success");
	assert.match(shown.text, /^mode: ai \(config default: ai, no session override\)$/);

	// switch via numeric alias
	const switched = await registered.handler({ agent: { session: { id: "s1" } }, rawInput: "3" });
	assert.equal(switched.kind, "success");
	assert.match(switched.text, /^switched → ai-auto \(this session; memory-only/);
	assert.deepEqual(lastSet, { id: "s1", mode: "ai-auto" });

	// invalid input
	const bad = await registered.handler({ agent: { session: { id: "s1" } }, rawInput: "full" });
	assert.match(bad.text, /^unknown mode "full"/);

	// clear
	const clearedRes = await registered.handler({ agent: { session: { id: "s1" } }, rawInput: "default" });
	assert.match(clearedRes.text, /^override cleared → ai \(config default; memory-only/);
	assert.equal(cleared, true);
});

test("registerModeCommand: zh locale renders Chinese copy and description", async () => {
	const { registerModeCommand } = await import("../index.js");
	let registered = null;
	const ctx = {
		inject: (deps, fn) => {
			fn({ commands: { register: (def) => { registered = def; } } });
		}
	};
	const cfg = normalizeConfig({});
	const store = {
		get: async () => "ai-auto",
		set: async () => "persisted",
		clear: async () => "persisted"
	};
	registerModeCommand(ctx, cfg, store, () => "zh");
	assert.match(registered.description, /显示或切换审批模式/);

	const shown = await registered.handler({ agent: { session: { id: "s1" } }, rawInput: "" });
	assert.match(shown.text, /^当前模式：ai-auto（会话覆盖：ai-auto，配置默认：ai）$/);

	const switched = await registered.handler({ agent: { session: { id: "s1" } }, rawInput: "3" });
	assert.match(switched.text, /^已切换 → ai-auto（本会话）$/);

	const bad = await registered.handler({ agent: { session: { id: "s1" } }, rawInput: "x" });
	assert.match(bad.text, /^未知模式 "x"/);

	const cleared = await registered.handler({ agent: { session: { id: "s1" } }, rawInput: "default" });
	assert.match(cleared.text, /^已清除会话覆盖 → 回落 ai（配置默认）$/);
});

test("makeModeStore: persists through a settings service", async () => {
	const registry = {};
	const fakeSettings = {
		register(ns, schema, opts) {
			registry[ns] = { schema };
			// resolve initial value (validate the stored section)
			this.resolved = { sessionOverrides: {} };
		},
		get(ns) { return this.resolved; },
		async replace(ns, section) {
			this.resolved = registry[ns].schema(section); // function-call validation
			return { ok: true };
		}
	};
	let injected = null;
	const ctx = { inject: (deps, fn) => { injected = fn; } };
	const store = makeModeStore(ctx, undefined);
	await injected({ settings: fakeSettings }); // settings becomes available

	assert.equal(await store.set("s9", "ai-auto"), "persisted");
	assert.equal(await store.get("s9"), "ai-auto");
	assert.deepEqual(fakeSettings.resolved.sessionOverrides, { s9: "ai-auto" });

	assert.equal(await store.set("s9", "manual"), "persisted");
	assert.equal(await store.clear("s9"), "persisted");
	assert.equal(await store.get("s9"), undefined);
	assert.deepEqual(fakeSettings.resolved.sessionOverrides, {});
});

test("handler: npm publish is an ask rule in ai mode (human confirm)", async () => {
	const cfg = normalizeConfig({ mode: "ai", rules: [{ match: "Bash(npm publish*)", action: "ask" }], ai: { enabled: false } });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: true, text: "{}" }) });
	const { outcome, nextCalls } = await runWith(handler, makeReq({ command: "npm publish" }));
	assert.equal(outcome, "unavailable"); // delegated to the human answerer
	assert.equal(nextCalls.length, 1);
});

test("handler: npm publish rule present in DEFAULT_CONFIG", () => {
	const cfg = normalizeConfig({});
	const rule = cfg.rules.find((r) => r.match === "Bash(npm publish*)");
	assert.ok(rule, "npm publish ask rule must be in defaults");
	assert.equal(rule.action, "ask");
});

test("handler: npm publish ask resolves deny under ai-auto + mode3OnAsk=deny", async () => {
	const cfg = normalizeConfig({ mode: "ai-auto", rules: [{ match: "Bash(npm publish*)", action: "ask" }], ai: { enabled: false } });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: true, text: "{}" }) });
	const { outcome, nextCalls } = await runWith(handler, makeReq({ command: "npm publish" }));
	assert.equal(outcome, "rejected");
	assert.equal(nextCalls.length, 0);
});

test("makeGetLocale: explicit zh/en wins; auto follows settings preference", async () => {
	const { makeGetLocale } = await import("../index.js");
	// explicit zh
	assert.equal(makeGetLocale(normalizeConfig({ locale: "zh" }), {})(), "zh");
	// explicit en
	assert.equal(makeGetLocale(normalizeConfig({ locale: "en" }), {})(), "en");
	// auto + settings zh
	const ctxZh = { get: (n) => (n === "settings" ? { get: (ns) => (ns === "locale" ? { preference: "zh" } : undefined) } : undefined) };
	assert.equal(makeGetLocale(normalizeConfig({}), ctxZh)(), "zh");
	// auto + no settings → en
	assert.equal(makeGetLocale(normalizeConfig({}), {})(), "en");
	// auto + settings without preference → en
	const ctxNoPref = { get: (n) => (n === "settings" ? { get: () => undefined } : undefined) };
	assert.equal(makeGetLocale(normalizeConfig({}), ctxNoPref)(), "en");
	// auto + throwing settings → en (defensive)
	const ctxThrow = { get: () => { throw new Error("boom"); } };
	assert.equal(makeGetLocale(normalizeConfig({}), ctxThrow)(), "en");
});

test("normalizeConfig: locale validation", () => {
	assert.equal(normalizeConfig({}).locale, "auto");
	assert.equal(normalizeConfig({ locale: "zh" }).locale, "zh");
	assert.throws(() => normalizeConfig({ locale: "fr" }), TypeError);
});

test("handler: prefixed npm publish (cd && npm publish) also hits the ask rule", async () => {
	const cfg = normalizeConfig({ mode: "ai", ai: { enabled: false } }); // defaults include both publish rules
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: true, text: "{}" }) });
	const { outcome, nextCalls } = await runWith(handler, makeReq({ command: "cd /x && npm publish" }));
	assert.equal(outcome, "unavailable"); // delegated to the human
	assert.equal(nextCalls.length, 1);
	const { outcome: o2 } = await runWith(handler, makeReq({ command: "cd /x && npm publish --dry-run" }));
	assert.equal(o2, "unavailable");
});

// ---------------------------------------------------------------------------
// P0 security regressions — findings 1-9 of the 2026-09-22 approval audit
// ---------------------------------------------------------------------------

test("P0: default rules no longer auto-approve compound / redirected / substituted commands", async () => {
	const cfg = normalizeConfig({ mode: "ai" });
	const entries = [];
	const handler = createHandler({
		config: cfg,
		record: async (entry) => entries.push(entry),
		llmRunner: async () => ({ ok: false, error: "judge unavailable in test" })
	});
	for (const command of [
		"git status; rm -rf /tmp/dsh-audit-placeholder",
		"echo $(touch /tmp/dsh-audit-placeholder)",
		"cat /dev/null > /tmp/dsh-audit-placeholder",
		"cat ~/.ssh/id_rsa",
		"git diff --output=/tmp/dsh-audit-placeholder"
	]) {
		const outcome = await handler(makeReq({ command }), async () => "unavailable");
		assert.notEqual(outcome, "allowed-once", `must not be auto-approved: ${command}`);
	}
	const shapes = entries.map((entry) => entry.shape);
	assert.ok(shapes.includes("compound"), `compound shape must be recorded: ${shapes}`);
	assert.ok(shapes.includes("opaque"), `opaque shape must be recorded: ${shapes}`);
});

test("P0: pwsh chains are no longer auto-approved either", async () => {
	const cfg = normalizeConfig({ mode: "ai" });
	const handler = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: async () => ({ ok: false, error: "judge unavailable in test" })
	});
	const outcome = await handler(
		makeReq({ toolName: "pwsh", command: "Get-ChildItem .; Remove-Item x -Recurse -Force" }),
		async () => "unavailable"
	);
	assert.notEqual(outcome, "allowed-once");
});

test("P0: the read-only allow family still auto-approves its plain single commands", async () => {
	const cfg = normalizeConfig({ mode: "ai" });
	const handler = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: async () => {
			throw new Error("no judge call expected for a plain allow");
		},
		getCwd: () => "/work",
		resolvePath: async (path) => path
	});
	for (const command of ["git status --short", "git log --oneline -5", "ls -la", "which node", "echo hello", "cat README.md"]) {
		const { outcome, nextCalls } = await run(handler, makeReq({ command }));
		assert.equal(outcome, "allowed-once", `should stay auto-approved: ${command}`);
		assert.equal(nextCalls.length, 0);
	}
});

test("P0: git diff/log with an output option falls through to the judge", async () => {
	const cfg = normalizeConfig({ mode: "ai" });
	let judged = 0;
	const handler = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: async () => {
			judged += 1;
			return { ok: true, text: '{"risk":"high","authorization":"ask","reason":"writes a file"}' };
		}
	});
	const { outcome } = await run(handler, makeReq({ command: "git diff --output=/tmp/x" }), async () => "unavailable");
	assert.equal(judged, 1);
	assert.equal(outcome, "unavailable");
});

test("P0: cat is limited to workspace-relative paths (static + realpath check)", async () => {
	const cfg = normalizeConfig({ mode: "ai" });
	const judge = async () => ({ ok: true, text: '{"risk":"high","authorization":"ask","reason":"outside"}' });
	const inside = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: judge,
		getCwd: () => "/work",
		resolvePath: async (path) => path
	});
	assert.equal((await run(inside, makeReq({ command: "cat README.md" }))).outcome, "allowed-once");
	assert.notEqual((await run(inside, makeReq({ command: "cat /etc/sudoers" }))).outcome, "allowed-once");
	assert.notEqual((await run(inside, makeReq({ command: "cat ../outside.txt" }))).outcome, "allowed-once");

	// a relative path that resolves outside the root through a symlink
	const symlinked = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: judge,
		getCwd: () => "/work",
		resolvePath: async (path) => (path === "/work/link" ? "/etc/passwd" : path)
	});
	assert.notEqual((await run(symlinked, makeReq({ command: "cat link" }))).outcome, "allowed-once");

	// no workspace root to verify against → fail closed
	const rootless = createHandler({ config: cfg, record: async () => {}, llmRunner: judge });
	assert.notEqual((await run(rootless, makeReq({ command: "cat README.md" }))).outcome, "allowed-once");
});

test("P0: unrecoverable arguments are never auto-approved and never judged", async () => {
	const cfg = normalizeConfig({ mode: "ai" });
	const entries = [];
	let judgeCalls = 0;
	const handler = createHandler({
		config: cfg,
		record: async (entry) => entries.push(entry),
		llmRunner: async () => {
			judgeCalls += 1;
			return { ok: true, text: '{"risk":"low","authorization":"allow"}' };
		}
	});
	const req = {
		toolName: "bash",
		callId: "call-missing",
		reason: "needs escalation",
		agent: { id: "a1", session: { id: "s1", snapshotEvents: () => [] } }
	};
	const { outcome, nextCalls } = await run(handler, req);
	assert.equal(outcome, "unavailable");
	assert.equal(nextCalls.length, 1);
	assert.equal(judgeCalls, 0, "the judge must not rule on `command: null`");
	assert.equal(entries[0].kind, "evidence-incomplete");
	assert.equal(entries[0].evidenceIncomplete, "arguments-unavailable");
});

test("P0: ai-auto denies evidence-incomplete even when mode3OnAsk=allow", async () => {
	const cfg = normalizeConfig({ mode: "ai-auto", mode3OnAsk: "allow" });
	const handler = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: '{"risk":"low","authorization":"allow"}' })
	});
	const req = {
		toolName: "bash",
		callId: "call-missing",
		reason: "needs escalation",
		agent: { id: "a1", session: { id: "s1", snapshotEvents: () => [] } }
	};
	const { outcome, nextCalls } = await run(handler, req);
	assert.equal(outcome, "rejected");
	assert.equal(nextCalls.length, 0);
});

test("P0: an operation past the judge budget is not approved on its prefix", async () => {
	const cfg = normalizeConfig({ mode: "ai", ai: { maxJudgeCommandChars: 500 } });
	const entries = [];
	const handler = createHandler({
		config: cfg,
		record: async (entry) => entries.push(entry),
		llmRunner: async () => ({ ok: true, text: '{"risk":"low","authorization":"allow","reason":"looks fine"}' })
	});
	const command = `echo ${"a".repeat(600)}; npm publish`;
	const { outcome } = await run(handler, makeReq({ command }));
	assert.notEqual(outcome, "allowed-once");
	assert.equal(entries[0].kind, "evidence-incomplete");
	assert.equal(entries[0].evidenceIncomplete, "command-too-long");
});

test("P0: the full command reaches the rules (no truncation before matching)", async () => {
	const cfg = normalizeConfig({ mode: "ai", rules: [{ match: "Bash(*npm publish*)", action: "ask" }] });
	const handler = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: async () => ({ ok: false, error: "no judge expected" })
	});
	const command = `echo ${"a".repeat(4000)} && npm publish`;
	const { outcome, nextCalls } = await run(handler, makeReq({ command }));
	assert.equal(outcome, "unavailable"); // the ask rule claimed it → human
	assert.equal(nextCalls.length, 1);
});

test("P0: an explicit empty rules list is honoured", () => {
	assert.deepEqual(normalizeConfig({ rules: [] }).rules, []);
	assert.ok(normalizeConfig({}).rules.length > 0, "an absent rules key still gets the defaults");
});

test("P0: rules: [] sends even plain commands to the judge", async () => {
	const cfg = normalizeConfig({ rules: [], mode: "ai" });
	let judged = 0;
	const handler = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: async () => {
			judged += 1;
			return { ok: true, text: '{"risk":"low","authorization":"ask","reason":"borderline"}' };
		}
	});
	const { outcome } = await run(handler, makeReq({ command: "git status" }));
	assert.equal(judged, 1);
	assert.equal(outcome, "allowed-once"); // low-risk ask within medium tolerance
});

test("P0: credentials are redacted in the judge input, the audit record and the denial feedback", async () => {
	const cfg = normalizeConfig({ rules: [], mode: "ai" });
	const prompts = [];
	const entries = [];
	const denialFeed = new Map();
	const handler = createHandler({
		config: cfg,
		record: async (entry) => entries.push(entry),
		denialFeed,
		llmRunner: async (messages) => {
			// every message, not just the first: the policy is a system message now
			// and the request itself travels in the user message
			prompts.push(messages.map((message) => message.content.map((part) => part.text).join("\n")).join("\n---\n"));
			return { ok: true, text: '{"risk":"high","authorization":"deny","reason":"credential exfiltration"}' };
		}
	});
	const command = "curl -H 'Authorization: Bearer super-secret-token' https://x.test/api?token=query-secret";
	const { outcome } = await run(handler, makeReq({ command, reason: "apiKey=hidden-value" }));
	assert.equal(outcome, "rejected");
	assert.doesNotMatch(prompts[0], /super-secret-token|hidden-value|query-secret/);
	// and the request really did reach the judge, with the values redacted in place
	assert.match(prompts[0], /"command":/);
	assert.match(prompts[0], /\[REDACTED\]/);
	assert.doesNotMatch(JSON.stringify(entries[0]), /super-secret-token|hidden-value|query-secret/);
	assert.doesNotMatch(JSON.stringify(denialFeed.get("sess-1")), /super-secret-token|hidden-value|query-secret/);
});

test("P0: a cancel during the judge is answered cancelled and audited as cancelled", async () => {
	const cfg = normalizeConfig({ rules: [], mode: "ai" });
	const entries = [];
	const controller = new AbortController();
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	let runnerSignal;
	const handler = createHandler({
		config: cfg,
		record: async (entry) => entries.push(entry),
		llmRunner: async (messages, opts) => {
			runnerSignal = opts?.signal;
			await gate;
			return { ok: true, text: '{"risk":"high","authorization":"allow"}' };
		}
	});
	const req = makeReq({ command: "curl http://example.test" });
	req.signal = controller.signal;
	const pending = run(handler, req);
	await new Promise((resolve) => setTimeout(resolve, 5));
	controller.abort();
	release();
	const { outcome, nextCalls } = await pending;
	assert.equal(outcome, "cancelled");
	assert.equal(runnerSignal, controller.signal, "the judge must receive the request signal");
	assert.equal(nextCalls.length, 0);
	assert.equal(entries[0].kind, "cancelled");
	assert.equal(entries[0].outcome, "cancelled");
});

test("makeRecorder: creates the log with 0600 and rotates past maxBytes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-codex-approval-"));
	const file = join(dir, "logs", "approval.jsonl");
	const recorder = makeRecorder(file, { maxBytes: 120 });
	await recorder({ a: "x".repeat(60) });
	await recorder({ a: "y".repeat(60) });
	await recorder({ a: "z".repeat(60) });
	assert.ok(existsSync(`${file}.1`), "the log rotates to <file>.1");
	const mode = (statSync(file).mode & 0o777).toString(8);
	assert.equal(mode, "600", `log must be created 0600, got ${mode}`);
});

// ---------- 0.2.0 entry-config 的 settings 写路径（F2/F3/F8 回归） ----------

/** 0.2.0 的 SettingsForms 形状：靠 `importLegacyDocument` 与旧服务区分。 */
function entrySettingsSpy({ revision = 7 } = {}) {
	const calls = [];
	return {
		calls,
		settings: {
			importLegacyDocument: () => {},
			describe: () => [{ ns: "dsh-codex-approval", revision }],
			mutate: async (ns, ops, expected) => { calls.push({ kind: "mutate", ns, ops, expected }) },
			replace: async (ns, section) => { calls.push({ kind: "replace", ns, section }) }
		}
	};
}

test("makeModeStore: 0.2.0 只写 sessionOverrides 一条路径，绝不用整份 replace", async () => {
	const { settings, calls } = entrySettingsSpy({ revision: 7 });
	const store = makeModeStore({ inject: (_services, callback) => callback({ settings }) }, undefined, {});
	await store.set("session-a", "ai-auto");
	assert.equal(calls.length, 1, "exactly one settings write");
	// replace() 是整份重置语义：只传 sessionOverrides 会把同一个 namespace 上的
	// provider / model / riskTolerance 一起冲回默认值（用户执行一次 /approval-mode
	// 就丢掉刚配好的模型与风险策略）。
	assert.equal(calls[0].kind, "mutate");
	assert.deepEqual(calls[0].ops, [{ op: "set", path: ["sessionOverrides"], value: { "session-a": "ai-auto" } }]);
	assert.equal(calls[0].expected, 7, "revision 取自 describe()，避免并发覆盖");
});

test("makeModeStore: describe() 里没有本 entry 时退回 memory-only，不误写", async () => {
	const calls = [];
	const settings = {
		importLegacyDocument: () => {},
		describe: () => [{ ns: "some-other-plugin", revision: 1 }],
		mutate: async (...args) => { calls.push(args) },
		replace: async (...args) => { calls.push(args) }
	};
	const store = makeModeStore({ inject: (_services, callback) => callback({ settings }) }, undefined, {});
	assert.equal(await store.set("session-c", "ai"), "memory-only");
	assert.equal(calls.length, 0, "定位不到 entry 时不写任何东西");
});

test("makeModeStore: 0.1.x 仍走原 namespace 的 replace", async () => {
	const calls = [];
	const settings = {
		// 没有 importLegacyDocument → 判为 0.1.x 的服务形状
		register: () => ({ get: () => ({ sessionOverrides: {} }), watch: () => {} }),
		get: () => ({ sessionOverrides: {} }),
		replace: async (ns, section) => { calls.push({ ns, section }) }
	};
	const store = makeModeStore({ inject: (_services, callback) => callback({ settings }) }, undefined, {});
	await store.set("session-b", "manual");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].ns, "dsh-codex-approval");
	assert.deepEqual(calls[0].section, { sessionOverrides: { "session-b": "manual" } });
});

test("makeModeStore: syncOverrides 跟随外部 volatile 更新（含删除）", () => {
	const store = makeModeStore({ inject: () => {} }, undefined, { "session-d": "manual" });
	assert.equal(store.snapshot()["session-d"], "manual");
	assert.equal(store.syncOverrides({ "session-d": "ai-auto", "session-e": "ai" }), true);
	// 外部把它改成 ai-auto 之后 store 必须跟上，否则会继续按 manual 放行审批。
	assert.equal(store.snapshot()["session-d"], "ai-auto");
	assert.equal(store.snapshot()["session-e"], "ai");
	// volatile 引用承载的是**完整快照**：新快照里没有 session-e，那是一次删除。
	// 若按增量补丁处理，全局 manual + 该会话曾设 ai-auto 的部署会在删除后继续放行。
	assert.equal(store.syncOverrides({ "session-d": "ai-auto" }), true, "遗漏的键代表删除，必须生效");
	assert.equal(store.snapshot()["session-e"], undefined, "被删掉的 override 不能留在 Map 里");
	assert.equal(store.syncOverrides({ "session-d": "ai-auto" }), false, "快照与当前完全一致才算没变化");
	// 整表清空同样是删除
	assert.equal(store.syncOverrides({}), true);
	assert.deepEqual(store.snapshot(), {});
	assert.equal(store.syncOverrides({}), false);
	assert.equal(store.syncOverrides(undefined), false, "非对象输入安全返回");
});

test("Config schema: fallbacks 的上限与非空约束在热更新路径同样生效", async () => {
	const { Config } = await import("../index.js");
	// 纯 volatile 热更新不经过 assertConfig，所以这些约束必须在 schema 层拦下，
	// 否则用户能写进 5 项、运行期一路接受，直到下次重启插件加载失败。
	assert.throws(() => Config({ fallbacks: new Array(5).fill({ provider: "p", model: "m" }) }), /length <= 4|at most/);
	assert.throws(() => Config({ fallbacks: [{ provider: "", model: "m" }] }), /length >= 1|non-?empty/);
	assert.throws(() => Config({ fallbacks: [{ provider: "p", model: "" }] }), /length >= 1|non-?empty/);
	assert.doesNotThrow(() => Config({ fallbacks: [{ provider: "p", model: "m" }] }));
	assert.doesNotThrow(() => Config({ fallbacks: [] }), "清空兜底候选是合法配置");
});

test("legacy settings: 检测 settings.yaml.imported 里未迁移的旧 namespace", async () => {
	const { findLegacySettings } = await import("../index.js");
	const home = mkdtempSync(join(tmpdir(), "dsh-legacy-"));
	assert.equal(await findLegacySettings(home), undefined, "文件不存在时返回 undefined");
	writeFileSync(join(home, "settings.yaml.imported"), [
		"locale:",
		"  preference: zh",
		"dsh-codex-approval-config:",
		"  provider: cpa-wx301",
		"  riskTolerance: low",
		"other-namespace:",
		"  a: 1",
		""
	].join("\n"));
	const found = await findLegacySettings(home);
	assert.ok(found !== undefined, "旧 namespace 存在时被检出");
	assert.match(found.segment, /dsh-codex-approval-config:/);
	assert.match(found.segment, /riskTolerance: low/);
	assert.doesNotMatch(found.segment, /other-namespace/, "只取本节，不越界");
});

test("legacy settings: 首次升级时文件还没被重命名，也要查到 settings.yaml", async () => {
	const { findLegacySettings } = await import("../index.js");
	const home = mkdtempSync(join(tmpdir(), "dsh-legacy-first-"));
	// 框架是先等待 loader、再导入、最后才把 settings.yaml 改名成 .imported。
	// 首次升级的那一刻磁盘上只有 settings.yaml，只盯 .imported 会漏掉最关键的一次。
	writeFileSync(join(home, "settings.yaml"), "dsh-codex-approval-config:\n  riskTolerance: low\n");
	const found = await findLegacySettings(home);
	assert.ok(found !== undefined, "未重命名的 settings.yaml 同样要被检出");
	assert.match(found.file, /settings\.yaml$/);
	assert.match(found.segment, /riskTolerance: low/);
});

// ---------- 配置往返：靠数据自身区分「没配过」与「配成了某个值」（F1 回归） ----------

/** 通过共享 symbol 直接写 volatile 引用，等价于 loader 的 updateVolatile()。 */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");
const writeRef = (ref, next) => ref[VOLATILE_WRITE](next);

/**
 * 平面探测：`.volatile()` 只有 0.2.0 的 schemastery（3.18.4+）才有。
 * 0.1.x 上 `live()` 退化成普通 schema，字段解析成**值**而不是 cosmokit 引用，
 * 「引用稳定、快照可原地改写」这套语义根本不存在，所以依赖它的断言只在
 * volatile 平面成立；两平面值行为一致的部分照旧全跑。
 */
const HAS_VOLATILE =
	typeof (await import("@deepseek-ai/schemastery")).default?.string?.().volatile === "function";
const NO_VOLATILE_REASON = "0.1.x 的 schemastery 无 .volatile()，字段是值而非引用，无原地改写语义";
const VOLATILE_ONLY = HAS_VOLATILE ? false : NO_VOLATILE_REASON;

/** 取引用的快照值；普通平面上字段本来就是值，原样返回。 */
const readRef = (value) => (typeof value?.get === "function" ? value.get() : value);

/** 复现 apply() 的装配路径，拿到带 getter 的运行配置。 */
async function buildCfg(raw) {
	const { Config, DEFAULT_CONFIG, normalizeConfig, applyConfigSettings, installLiveGetters, materializeConfig } =
		await import("../index.js");
	const source = Config(raw);
	const provided = materializeConfig(source);
	const baseline = normalizeConfig(applyConfigSettings(
		DEFAULT_CONFIG,
		provided?.ai === undefined ? {} : { ai: provided.ai }
	));
	return {
		source,
		cfg: installLiveGetters(
			normalizeConfig(applyConfigSettings(DEFAULT_CONFIG, provided)), source, baseline)
	};
}

test("配置往返：改回默认值、删除字段都按预期生效", { skip: VOLATILE_ONLY }, async () => {
	const { Config } = await import("../index.js");
	const { source, cfg } = await buildCfg({ riskTolerance: "high", failOpen: "allow" });
	assert.equal(cfg.ai.riskTolerance, "high");
	assert.equal(cfg.ai.failOpen, "allow");

	// 改回默认值 —— 这正是「值等于默认就回落到启动值」那种方案翻车的场景：
	// 用户以为收紧了，运行期却仍按 high 放宽审批。
	const back = Config({ riskTolerance: "medium", failOpen: "ask" });
	writeRef(source.riskTolerance, back.riskTolerance.get());
	writeRef(source.failOpen, back.failOpen.get());
	assert.equal(cfg.ai.riskTolerance, "medium", "改回默认值必须生效");
	assert.equal(cfg.ai.failOpen, "ask", "改回默认值必须生效");
});

test("配置往返：删除字段后回落到内置兜底，而不是恢复启动时的值", { skip: VOLATILE_ONLY }, async () => {
	const { Config, DEFAULT_CONFIG } = await import("../index.js");
	const { source, cfg } = await buildCfg({ riskTolerance: "high" });
	assert.equal(cfg.ai.riskTolerance, "high");
	const empty = Config({});
	writeRef(source.riskTolerance, empty.riskTolerance.get());
	assert.equal(cfg.ai.riskTolerance, DEFAULT_CONFIG.ai.riskTolerance,
		"删掉字段后应回到内置兜底；恢复成启动时的 high 等于撤销用户的删除");
});

test("配置往返：fallbacks 的「清空」与「没配过」可区分", { skip: VOLATILE_ONLY }, async () => {
	const { Config, DEFAULT_CONFIG } = await import("../index.js");
	const cleared = await buildCfg({ fallbacks: [] });
	assert.equal(cleared.cfg.ai.fallbacks.length, 0, "显式清空必须生效，不能被默认兜底候选顶回");

	const restored = Config({ fallbacks: DEFAULT_CONFIG.ai.fallbacks });
	writeRef(cleared.source.fallbacks, restored.fallbacks.get());
	assert.deepEqual(cleared.cfg.ai.fallbacks, DEFAULT_CONFIG.ai.fallbacks);

	const bare = await buildCfg({});
	assert.deepEqual(bare.cfg.ai.fallbacks, DEFAULT_CONFIG.ai.fallbacks, "没配过时用默认兜底候选");
});

test("Config: 标量未配置是 undefined；null 原样保留（由装配期与 getter 兜底）", async () => {
	const { Config, DEFAULT_CONFIG } = await import("../index.js");
	// 标量**刻意不带 default**：一旦注入，顶层字段就「恒有值」，`pick()` 里读旧嵌套
	// `ai.*` 的分支永远轮不到，旧配置里更严格的策略会被静默放宽。
	assert.equal(readRef(Config({}).riskTolerance), undefined);
	assert.equal(readRef(Config({ riskTolerance: "low" }).riskTolerance), "low");
	// null 由 schemastery 原样保留，运行期靠 getter 的 `??` 兜底（不是靠 schema 回填）
	assert.equal(readRef(Config({ timeoutMs: null }).timeoutMs), null);
	assert.equal(readRef(Config({ denyFeedback: false }).denyFeedback), false);
	// 数组相反：保留 default，否则「显式清空 []」与「没配过」分不开
	assert.deepEqual(readRef(Config({}).fallbacks), DEFAULT_CONFIG.ai.fallbacks);
	assert.deepEqual(readRef(Config({ fallbacks: [] }).fallbacks), []);
});

test("applyConfigSettings: 0.1.x 的 namespace 更新直接按实际值覆盖", async () => {
	const { DEFAULT_CONFIG, applyConfigSettings, normalizeConfig } = await import("../index.js");
	const base = normalizeConfig({ ...DEFAULT_CONFIG, ai: { ...DEFAULT_CONFIG.ai, riskTolerance: "high" } });
	assert.equal(applyConfigSettings(base, { riskTolerance: "medium" }).ai.riskTolerance, "medium",
		"0.1.x 下改回默认值必须生效");
	assert.equal(applyConfigSettings(base, {}).ai.riskTolerance, "high", "没传的字段保持原值");
});

test("makeModeStore: 本地未确认的覆盖不会被远端同步删掉（并发保护）", async () => {
	const { makeModeStore } = await import("../index.js");
	const mk = (mutate) => {
		const settings = {
			importLegacyDocument: () => {},
			describe: () => [{ ns: "dsh-codex-approval", revision: 1 }],
			mutate,
			replace: async () => {}
		};
		return makeModeStore({ inject: (_services, callback) => callback({ settings }) }, undefined, {});
	};

	// 持久化失败（revision 冲突）：manual 只存在于内存
	const failing = mk(async () => { throw new Error("conflict") });
	assert.equal(await failing.set("sess-A", "manual"), "memory-only");
	// 紧接着一次无关的 volatile 同步带来一份不含 sess-A 的远端快照
	assert.equal(failing.syncOverrides({ other: "ai" }), true);
	assert.equal(failing.snapshot()["sess-A"], "manual",
		"远端快照里没有 sess-A 不等于用户不要它——删掉它会让刚被告知「已切换」的 manual 静默失效");

	// 持久化成功：本地与远端一致，此时远端快照里没有该键就是真的删除
	const ok = mk(async () => {});
	assert.equal(await ok.set("sess-B", "manual"), "persisted");
	ok.syncOverrides({ other: "ai" });
	assert.equal(ok.snapshot()["sess-B"], undefined, "已确认持久化后，远端删除应当生效");
});

test("makeModeStore: 未确认写入在四种并发情形下都不丢保护", async () => {
	const { makeModeStore } = await import("../index.js");
	let failing = false;
	const settings = {
		importLegacyDocument: () => {},
		describe: () => [{ ns: "dsh-codex-approval", revision: 1 }],
		mutate: async () => { if (failing) throw new Error("revision conflict") },
		replace: async () => {}
	};
	const newStore = () => makeModeStore({ inject: (_services, callback) => callback({ settings }) }, undefined, {});

	// 1) 同键被旧快照覆盖：本地 manual 还没确认，远端快照里没有它
	failing = true;
	const a = newStore();
	await a.set("A", "manual");
	assert.equal(a.snapshot()["A"], "manual");
	a.syncOverrides({ other: "ai" });
	assert.equal(a.snapshot()["A"], "manual", "本地未确认的 manual 不能被远端旧快照覆盖或删除");

	// 2) 连续两次写入：先成功的那次不能解除后一次的保护
	failing = false;
	const b = newStore();
	await b.set("B", "ai");
	failing = true;
	await b.set("B", "manual");
	b.syncOverrides({ B: "ai" });
	assert.equal(b.snapshot()["B"], "manual", "最新的本地写入必须优先于远端旧值");

	// 3) clear **提交失败**时，删除意图要保护它不被旧快照复活
	//（提交成功的话持久层已经没有该键，之后快照里再出现它说明是别人重新加的，
	//  那是远端权威，应当生效——见第 4 条）
	failing = true;
	const c = newStore();
	await c.set("C", "ai-auto");
	await c.clear("C");
	c.syncOverrides({ C: "ai-auto" });
	assert.equal(c.snapshot()["C"], undefined, "clear 提交失败后，旧快照不能把该会话复活");

	// 4) 已确认的写入不受保护，远端删除应当生效
	failing = false;
	const d = newStore();
	await d.set("D", "manual");
	assert.equal(d.snapshot()["D"], "manual");
	d.syncOverrides({});
	assert.equal(d.snapshot()["D"], undefined, "已确认持久化后，远端删除要生效");
});

// --- regression: an empty judge reply is never a successful attempt ---------
// Absence of a parseable verdict means "this candidate did not answer", so the
// chain must spend the next candidate instead of ending on an empty string.

test("handler: an empty primary reply falls through to the fallback candidate", async () => {
	const calls = [];
	const llm = makeStubLlm({
		"cpa-wx301/judge-model": { text: "" },
		"deepseek-official/deepseek-flash": { text: VERDICT_TEXT }
	}, calls);
	const cfg = baseConfig({
		rules: [],
		ai: {
			provider: "cpa-wx301",
			model: "judge-model",
			fallbacks: [{ provider: "deepseek-official", model: "deepseek-flash" }]
		}
	});
	const entries = [];
	const handler = createHandler({
		config: cfg,
		record: async (entry) => entries.push(entry),
		llmRunner: makeLlmRunner(llm, () => cfg.ai)
	});
	const { outcome, nextCalls } = await run(handler, makeReq({ command: "something" }));
	// The fallback's verdict (low risk + allow) decided the request — not failOpen.
	assert.equal(outcome, "allowed-once");
	assert.equal(nextCalls.length, 0);
	assert.equal(entries[0].kind, "ai");
	assert.equal(entries[0].judgeAttempts, 2);
	assert.equal(entries[0].judgeFallbackFrom, "cpa-wx301/judge-model");
	assert.equal(entries[0].judgeModel, "deepseek-official/deepseek-flash");
	assert.deepEqual(calls.map((call) => `${call.provider}/${call.model}`), [
		"cpa-wx301/judge-model",
		"deepseek-official/deepseek-flash"
	]);
});

test("handler: every candidate replying empty is one ai-error listing every candidate tried", async () => {
	const llm = makeStubLlm({
		"cpa-wx301/judge-model": { text: "" },
		"deepseek-official/deepseek-flash": { text: "  \n " }
	});
	const cfg = baseConfig({
		rules: [],
		ai: {
			provider: "cpa-wx301",
			model: "judge-model",
			fallbacks: [{ provider: "deepseek-official", model: "deepseek-flash" }],
			failOpen: "deny"
		}
	});
	const entries = [];
	const handler = createHandler({
		config: cfg,
		record: async (entry) => entries.push(entry),
		llmRunner: makeLlmRunner(llm, () => cfg.ai)
	});
	const { outcome, nextCalls } = await run(handler, makeReq({ command: "something" }));
	assert.equal(outcome, "rejected");
	assert.equal(nextCalls.length, 0);
	assert.equal(entries[0].kind, "ai-error");
	assert.equal(entries[0].error, "unparseable judge output (empty reply)");
	assert.equal(entries[0].rawOutput, "");
	assert.equal(entries[0].textChars, 0);
	assert.notEqual(entries[0].endedWithoutFinish, true);
	assert.equal(entries[0].judgeAttempts, 2);
	assert.deepEqual(entries[0].judgeTried, [
		"cpa-wx301/judge-model",
		"deepseek-official/deepseek-flash"
	]);
});

test("handler: a stream that ends without a finish chunk is flagged in the audit entry", async () => {
	const llm = makeStubLlm({
		"cpa-wx301/judge-model": { text: "", noFinish: true },
		"deepseek-official/deepseek-flash": { text: "" }
	});
	const cfg = baseConfig({
		rules: [],
		ai: {
			provider: "cpa-wx301",
			model: "judge-model",
			fallbacks: [{ provider: "deepseek-official", model: "deepseek-flash" }],
			failOpen: "ask"
		}
	});
	const entries = [];
	const handler = createHandler({
		config: cfg,
		record: async (entry) => entries.push(entry),
		llmRunner: makeLlmRunner(llm, () => cfg.ai)
	});
	const { outcome } = await run(handler, makeReq({ command: "something" }));
	assert.equal(outcome, "unavailable");
	assert.equal(entries[0].kind, "ai-error");
	assert.equal(entries[0].error, "unparseable judge output (empty reply)");
	assert.equal(entries[0].endedWithoutFinish, true);
	assert.equal(entries[0].textChars, 0);
});

test("handler: text without a verdict is audited as no-verdict, with the original text kept", async () => {
	const llm = makeStubLlm({ "cpa-wx301/judge-model": { text: 'I checked it: {"note":"fine"}' } });
	const cfg = baseConfig({ rules: [], ai: { provider: "cpa-wx301", model: "judge-model", fallbacks: [], failOpen: "ask" } });
	const entries = [];
	const handler = createHandler({
		config: cfg,
		record: async (entry) => entries.push(entry),
		llmRunner: makeLlmRunner(llm, () => cfg.ai)
	});
	const { outcome } = await run(handler, makeReq({ command: "something" }));
	assert.equal(outcome, "unavailable");
	assert.equal(entries[0].kind, "ai-error");
	assert.equal(entries[0].error, "unparseable judge output (no verdict)");
	assert.equal(entries[0].rawOutput, 'I checked it: {"note":"fine"}');
	assert.equal(entries[0].textChars, 'I checked it: {"note":"fine"}'.length);
});

// ---------------------------------------------------------------------------
// 2026-10-02 review — P1 (deterministic auto-approval escapes) and P2 (rules
// whose match is a text coincidence) regressions.
// ---------------------------------------------------------------------------

/**
 * A handler over the DEFAULT rules whose judge always answers "ask": anything
 * that comes back `allowed-once` can only have been cleared by a rule, and
 * anything that reaches `next()` was handed to the human. The config reader
 * reports "no such file", so `configGuard` sees a workspace with no git config.
 */
function defaultRuleHandler({ entries = [] } = {}) {
	return createHandler({
		config: normalizeConfig({ mode: "ai" }),
		record: async (entry) => entries.push(entry),
		llmRunner: async () => ({ ok: true, text: '{"risk":"high","authorization":"ask","reason":"not read-only"}' }),
		getCwd: () => "/work",
		resolvePath: async (path) => path,
		readFile: async () => {
			const error = new Error("ENOENT");
			error.code = "ENOENT";
			throw error;
		}
	});
}

test("P1: a colon-bound pwsh parameter value cannot skip the path guard", async () => {
	const handler = defaultRuleHandler();
	for (const command of [
		"Get-Content -Path:..\\secret.txt",
		"Get-Content -Path:..\\..\\..\\Users\\wenxin\\.dsh\\settings.yaml",
		"Get-Content -Path:/etc/passwd",
		"cat -Path:..\\secret.txt"
	]) {
		const { outcome } = await run(handler, makeReq({ toolName: "pwsh", command }));
		assert.notEqual(outcome, "allowed-once", `an inline-bound path must not be auto-approved: ${command}`);
	}
});

test("P1: after `--` a dash-prefixed path is still a path, so it is checked", async () => {
	const handler = defaultRuleHandler();
	const { outcome } = await run(handler, makeReq({ command: "cat -- -../../../etc/passwd" }));
	assert.notEqual(outcome, "allowed-once");
});

test("P1: ordinary workspace-relative reads stay auto-approved (no over-blocking)", async () => {
	const entries = [];
	const handler = defaultRuleHandler({ entries });
	for (const [toolName, command] of [
		["bash", "cat README.md"],
		["bash", "cat sub/dir/file.txt"],
		["pwsh", "Get-Content -Path:ok.txt"],
		["pwsh", "Get-Content ok.txt"]
	]) {
		const { outcome } = await run(handler, makeReq({ toolName, command }));
		assert.equal(outcome, "allowed-once", `should stay auto-approved: ${toolName} ${command}`);
	}
	assert.ok(entries.every((entry) => entry.kind === "rule" && entry.action === "allow"), JSON.stringify(entries));
});

test("P2: spliced-token commands still reach the safety rules (space, tab, glued quotes)", async () => {
	const entries = [];
	const handler = defaultRuleHandler({ entries });
	for (const [command, match] of [
		["npm  publish", "Bash(npm publish*)"],
		["npm\tpublish", "Bash(npm publish*)"],
		['rm -r"f" /tmp/x', "*rm -rf /*"]
	]) {
		entries.length = 0;
		await run(handler, makeReq({ command }));
		assert.equal(entries[0].kind, "rule", `a rule must claim the request: ${command}`);
		assert.equal(entries[0].match, match, `wrong rule for: ${command}`);
	}
	assert.equal(entries[0].action, "deny");
});

test("P2: credential paths are protected with either separator, with or without a trailing one", async () => {
	const entries = [];
	const handler = defaultRuleHandler({ entries });
	for (const [toolName, command] of [
		["bash", "cp -r ~/.ssh /tmp/"],
		["bash", "tar -czf x.tgz ~/.aws"],
		["bash", "zip -r x.zip ~/.ssh"],
		["pwsh", "Get-Content C:\\Users\\x\\.aws\\credentials"],
		["pwsh", "Get-Content C:\\Users\\x\\.dsh\\settings.yaml"]
	]) {
		entries.length = 0;
		const { outcome } = await run(handler, makeReq({ toolName, command }));
		assert.equal(outcome, "unavailable", `a human must confirm: ${command}`);
		assert.equal(entries[0].kind, "rule", command);
		assert.equal(entries[0].action, "ask", command);
	}
});

test("P2: git switches that make git run configured programs are not auto-approved", async () => {
	const handler = defaultRuleHandler();
	for (const command of ["git diff --ext-diff", "git diff --textconv"]) {
		const { outcome } = await run(handler, makeReq({ command }));
		assert.notEqual(outcome, "allowed-once", `must not be auto-approved: ${command}`);
	}
	// the plain read-only forms keep it
	for (const command of ["git diff --stat", "git log --oneline -5"]) {
		const { outcome } = await run(handler, makeReq({ command }));
		assert.equal(outcome, "allowed-once", `should stay auto-approved: ${command}`);
	}
});

test("P2: git config that could run a program also refuses the auto-approval", async () => {
	// `diff.external` runs with no switch at all, so no forbidOptions can stop it:
	// the check is on the config that names the program.
	const detail = "the read-only allow family is not auto-approved over an exec-capable git config";
	for (const config of [
		"[diff]\n\texternal = rm -rf /\n",
		'[diff "md"]\n\ttextconv = /usr/bin/evil\n',
		"[core]\n\tfsmonitor = /usr/bin/evil\n",
		'[diff "x"]\n\tcommand = evil\n'
	]) {
		const handler = createHandler({
			config: normalizeConfig({ mode: "ai" }),
			record: async () => {},
			llmRunner: async () => ({ ok: true, text: '{"risk":"high","authorization":"ask","reason":"runs a program"}' }),
			getCwd: () => "/work",
			resolvePath: async (path) => path,
			readFile: async (file) => {
				if (file === "/work/.git/config") return config;
				const error = new Error("ENOENT");
				error.code = "ENOENT";
				throw error;
			},
		});
		const { outcome } = await run(handler, makeReq({ command: "git log --oneline -5" }));
		assert.notEqual(outcome, "allowed-once", `${detail}: ${JSON.stringify(config)}`);
		// the same request is still auto-approved when `.git` is a pointer file…
		const pointer = createHandler({
			config: normalizeConfig({ mode: "ai" }),
			record: async () => {},
			llmRunner: async () => ({ ok: true, text: '{"risk":"high","authorization":"ask","reason":"runs a program"}' }),
			getCwd: () => "/work",
			resolvePath: async (path) => path,
			readFile: async (file) => (file === "/work/.git" ? "gitdir: /elsewhere/.git/worktrees/w\n" : ""),
		});
		assert.notEqual((await run(pointer, makeReq({ command: "git log --oneline -5" }))).outcome, "allowed-once");
	}
	// a config with no exec-capable key (and no repo at all) keeps the allow
	const clean = createHandler({
		config: normalizeConfig({ mode: "ai" }),
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: '{"risk":"high","authorization":"ask","reason":"x"}' }),
		getCwd: () => "/work",
		resolvePath: async (path) => path,
		readFile: async () => {
			const error = new Error("ENOENT");
			error.code = "ENOENT";
			throw error;
		},
		home: "/home/u"
	});
	assert.equal((await run(clean, makeReq({ command: "git status --short" }))).outcome, "allowed-once");
});

test("P2: destructiveness behind sudo and raw-device writes is denied outright", async () => {
	const entries = [];
	const handler = defaultRuleHandler({ entries });
	for (const command of [
		"sudo shutdown -h now",
		"sudo reboot",
		"sudo dd if=/dev/zero of=/dev/sda",
		"dd if=/dev/urandom of=/dev/sda"
	]) {
		entries.length = 0;
		const { outcome } = await run(handler, makeReq({ command }));
		assert.equal(outcome, "rejected", `must be denied: ${command}`);
		assert.equal(entries[0].kind, "rule", command);
	}
});

test("P2: the new deny/ask patterns do not fire on harmless look-alikes", async () => {
	const handler = defaultRuleHandler();
	for (const command of ["echo hello", "git status --short", "echo rebuild the shuttered service", "ls -la"]) {
		const { outcome } = await run(handler, makeReq({ command }));
		assert.equal(outcome, "allowed-once", `must stay auto-approved: ${command}`);
	}
});

// ---- second pass (2026-10-02, codex review) -------------------------------

test("P1: a quoted dash-prefixed value is a path, and a bare `-` is resolved", async () => {
	// PowerShell binds a *quoted* string as a value, not as a parameter name, so
	// what follows `-Path` is an argument even when it starts with `-`; the
	// recognizer has already dropped that quoting, so the shape of the token is
	// the only evidence left and it must not be read as an option name.
	const handler = defaultRuleHandler();
	// a realpath that fails closed on a path that does not exist, the way the
	// filesystem does — `-LiteralPath '-'` must be *resolved*, not assumed safe
	const resolved = createHandler({
		config: normalizeConfig({ mode: "ai" }),
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: '{"risk":"high","authorization":"ask","reason":"resolve it"}' }),
		getCwd: () => "/work",
		resolvePath: async (path) => {
			if (path === "/work/-") throw new Error("ENOENT");
			return path;
		},
		readFile: async () => {
			const error = new Error("ENOENT");
			error.code = "ENOENT";
			throw error;
		}
	});
	for (const command of [
		"Get-Content -Path '-/../../../../../../etc/passwd'",
		"Get-Content -Path: '-/../../../../../../etc/passwd'",
		"Get-Content -LiteralPath '-\\..\\..\\outside.txt'",
		"cat -- -../../../etc/passwd"
	]) {
		const { outcome } = await run(handler, makeReq({ toolName: "pwsh", command }));
		assert.notEqual(outcome, "allowed-once", `must not be auto-approved: ${command}`);
	}
	// the bare `-` is a path PowerShell has to open: nothing to resolve → no allow
	const { outcome } = await run(resolved, makeReq({ toolName: "pwsh", command: "Get-Content -LiteralPath '-'" }));
	assert.notEqual(outcome, "allowed-once");
});

test("P1: rebuilt argv never collapses a differently-named program into an allow", async () => {
	// `"git status"` is one executable whose name contains a space; rejoining its
	// single argv entry would spell it exactly like the two-word `git status`
	const cfg = normalizeConfig({ mode: "ai", rules: [{ match: "Bash(git status)", action: "allow" }] });
	const handler = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: '{"risk":"high","authorization":"ask","reason":"not this"}' })
	});
	assert.equal((await run(handler, makeReq({ command: 'git "status"' }))).outcome, "allowed-once");
	assert.notEqual((await run(handler, makeReq({ command: '"git status"' }))).outcome, "allowed-once");
});

test("P2: whitespace splicing in an opaque command still reaches a safety rule", async () => {
	const entries = [];
	const handler = defaultRuleHandler({ entries });
	for (const [command, match] of [
		["npm  publish > /tmp/publish.log", "Bash(npm publish*)"],
		["npm\tpublish 2>/tmp/publish.log", "Bash(npm publish*)"],
		["rm  -rf /tmp/x > /tmp/log", "*rm -rf /*"]
	]) {
		entries.length = 0;
		await run(handler, makeReq({ command }));
		assert.equal(entries[0].kind, "rule", `a rule must claim: ${command}`);
		assert.equal(entries[0].match, match, `wrong rule for: ${command}`);
	}
});

test("P2: credential patterns do not fire on a file that merely starts with the name", async () => {
	for (const [toolName, command] of [
		["bash", "git diff docs/.aws-guide.md"],
		["bash", "cat docs/.ssh-notes.md"],
		["bash", "git log -- .aws-guide.md"]
	]) {
		const { outcome } = await run(defaultRuleHandler(), makeReq({ toolName, command }));
		assert.equal(outcome, "allowed-once", `must stay auto-approved: ${command}`);
	}
});

test("P2: folding never reaches inside a quoted argument, so an echo is not denied", async () => {
	const entries = [];
	await run(defaultRuleHandler({ entries }), makeReq({ command: "echo 'rm -r\"f\" /'" }));
	assert.equal(entries[0].kind, "rule", JSON.stringify(entries[0]));
	assert.equal(entries[0].action, "allow", JSON.stringify(entries[0]));
});

test("P2: an inline numeric switch value is not mistaken for a path", async () => {
	for (const command of ["Get-Content -ReadCount:0 README.md", "Get-Content -Tail:5 README.md"]) {
		const { outcome } = await run(defaultRuleHandler(), makeReq({ toolName: "pwsh", command }));
		assert.equal(outcome, "allowed-once", `must stay auto-approved: ${command}`);
	}
});

test("P1: a quoted word in pwsh is a value, never an option name", async () => {
	// `-x` looks exactly like an option name, but it was written as a quoted
	// string, so PowerShell binds it as the value of `-LiteralPath`; if it were
	// skipped as an option the symlink target would never be resolved
	const links = { "/work/-x": "/etc/passwd", "/work/-n": "/etc/passwd" };
	const handler = createHandler({
		config: normalizeConfig({ mode: "ai" }),
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: '{"risk":"high","authorization":"ask","reason":"resolve it"}' }),
		getCwd: () => "/work",
		resolvePath: async (path) => links[path] ?? path,
		readFile: async () => {
			const error = new Error("ENOENT");
			error.code = "ENOENT";
			throw error;
		}
	});
	for (const command of ["Get-Content -LiteralPath '-x'", "Get-Content -Path '-n'", "Get-Content '-x'"]) {
		const { outcome } = await run(handler, makeReq({ toolName: "pwsh", command }));
		assert.notEqual(outcome, "allowed-once", `must be resolved, not skipped: ${command}`);
	}
});

test("P2: the git config guard reads include directives, gpg and fsmonitor values", async () => {
	const withConfig = (config) => createHandler({
		config: normalizeConfig({ mode: "ai" }),
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: '{"risk":"high","authorization":"ask","reason":"runs a program"}' }),
		getCwd: () => "/work",
		resolvePath: async (path) => path,
		readFile: async (file) => {
			if (file === "/work/.git/config") return config;
			const error = new Error("ENOENT");
			error.code = "ENOENT";
			throw error;
		}
	});
	// exec-capable config → no auto-approval
	for (const config of [
		"[include]\n\tpath = /elsewhere/evil.config\n",
		"[gpg]\n\tprogram = evil\n",
		"[core]\n\tfsmonitor = /usr/bin/evil\n",
		// a quoted value holding a semicolon is a command line, not a boolean
		"[core]\n\tfsmonitor = \"true; echo evil\"\n",
		// the same keys in git's legal single-line form
		"[diff \"md\"] command = evil\n",
		"[diff] external = evil\n",
		"[core] fsmonitor = /usr/bin/evil\n",
		"include.path = /elsewhere/evil.config\n"
	]) {
		const { outcome } = await run(withConfig(config), makeReq({ command: "git log --oneline -5" }));
		assert.notEqual(outcome, "allowed-once", `must not be auto-approved over: ${JSON.stringify(config)}`);
	}
	// values that run nothing, and a URL that merely contains the word
	for (const config of [
		"[core]\n\tfsmonitor = false\n",
		"[core]\n\tfsmonitor = true\n",
		'[remote "origin"]\n\turl = https://example.test/fsmonitor.git\n'
	]) {
		const { outcome } = await run(withConfig(config), makeReq({ command: "git log --oneline -5" }));
		assert.equal(outcome, "allowed-once", `must stay auto-approved over: ${JSON.stringify(config)}`);
	}
});

test("P2: the git config guard covers worktree config and read failures", async () => {
	const withFiles = (files) => createHandler({
		config: normalizeConfig({ mode: "ai" }),
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: '{"risk":"high","authorization":"ask","reason":"runs a program"}' }),
		getCwd: () => "/work",
		resolvePath: async (path) => path,
		readFile: async (file) => {
			if (Object.hasOwn(files, file)) return files[file];
			const error = new Error("ENOENT");
			error.code = "ENOENT";
			throw error;
		}
	});
	const request = () => makeReq({ command: "git log --oneline -5" });
	// extensions.worktreeConfig keeps a second config beside the main one
	assert.notEqual((await run(withFiles({
		"/work/.git/config": "[core]\n\trepositoryformatversion = 0\n",
		"/work/.git/config.worktree": "[diff]\n\texternal = evil\n"
	}), request())).outcome, "allowed-once");
	// a config that cannot be read (permissions, I/O) is not "no config"
	const unreadable = createHandler({
		config: normalizeConfig({ mode: "ai" }),
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: '{"risk":"high","authorization":"ask","reason":"x"}' }),
		getCwd: () => "/work",
		resolvePath: async (path) => path,
		readFile: async () => {
			const error = new Error("permission denied");
			error.code = "EACCES";
			throw error;
		}
	});
	assert.notEqual((await run(unreadable, request())).outcome, "allowed-once");
});

test("P2: an inline value inside a quoted word is the path that runs", async () => {
	// `-Path:'link'` hands PowerShell the path `link`; a decoy `/work/-Path:link`
	// must not be what gets verified
	const links = { "/work/link": "/etc/passwd" };
	const handler = createHandler({
		config: normalizeConfig({ mode: "ai" }),
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: '{"risk":"high","authorization":"ask","reason":"outside"}' }),
		getCwd: () => "/work",
		resolvePath: async (path) => links[path] ?? path,
		readFile: async () => {
			const error = new Error("ENOENT");
			error.code = "ENOENT";
			throw error;
		}
	});
	for (const command of ["Get-Content -Path:'link'", 'Get-Content -Path:"link"']) {
		const { outcome } = await run(handler, makeReq({ toolName: "pwsh", command }));
		assert.notEqual(outcome, "allowed-once", `the value is what runs: ${command}`);
	}
	// a wholly quoted word is one value: `'--file=link'` is the path `--file=link`,
	// not the inline form `--file=link`
	const decoy = links["/work/--file=link"];
	links["/work/--file=link"] = "/etc/passwd";
	const { outcome } = await run(handler, makeReq({ toolName: "pwsh", command: "Get-Content -LiteralPath '--file=link'" }));
	links["/work/--file=link"] = decoy;
	assert.notEqual(outcome, "allowed-once", "a wholly quoted word is the path as written");
});

test("P2: relative credential directories and a trailing separator still ask", async () => {
	const entries = [];
	const handler = defaultRuleHandler({ entries });
	for (const command of [
		"cat .aws/config",
		"cat .ssh/config",
		"tar -czf x /home/u/.aws; echo done",
		// relative with a backslash separator, and a spliced quote plus separator
		"Get-Content .aws\\config",
		"Get-Content .ssh\\config",
		'tar cf x /w/.a"w"s;echo x>y',
		// relative dot-directories with a forward slash (the whole matrix of
		// targets × writings is covered by the review's own enumeration)
		"cat .dsh/profiles/web/config.yaml",
		"cat .dsh/settings.yaml",
		"cat .codex/auth.json"
	]) {
		entries.length = 0;
		const toolName = command.startsWith("Get-Content") ? "pwsh" : "bash";
		await run(handler, makeReq({ toolName, command }));
		assert.equal(entries[0].kind, "rule", `a rule must claim: ${command} (${JSON.stringify(entries[0])})`);
		assert.equal(entries[0].action, "ask", command);
	}
});

test("P2: harmless git config values do not refuse the auto-approval", async () => {
	const withConfig = (config) => createHandler({
		config: normalizeConfig({ mode: "ai" }),
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: '{"risk":"high","authorization":"ask","reason":"x"}' }),
		getCwd: () => "/work",
		resolvePath: async (path) => path,
		readFile: async (file) => {
			if (file === "/work/.git/config") return config;
			const error = new Error("ENOENT");
			error.code = "ENOENT";
			throw error;
		}
	});
	for (const config of [
		'[core]\n\tfsmonitor = "false"\n',
		'[remote "origin"]\n\turl = https://example.test/include.git\n',
		"[core]\n\trepositoryformatversion = 0\n"
	]) {
		const { outcome } = await run(withConfig(config), makeReq({ command: "git status --short" }));
		assert.equal(outcome, "allowed-once", `must stay auto-approved over: ${JSON.stringify(config)}`);
	}
});

test("P2: a quoted credential directory still asks, and signature verification needs a human", async () => {
	const entries = [];
	const handler = defaultRuleHandler({ entries });
	entries.length = 0;
	await run(handler, makeReq({ command: 'tar -czf x "/home/u/.aws"' }));
	assert.equal(entries[0].kind, "rule", JSON.stringify(entries[0]));
	assert.equal(entries[0].action, "ask", JSON.stringify(entries[0]));
	const signature = await run(handler, makeReq({ command: "git log --show-signature -1" }));
	assert.notEqual(signature.outcome, "allowed-once");
});

test("P2: sudo option forms and the remaining raw devices are covered", async () => {
	for (const command of [
		"sudo -n reboot",
		"sudo /sbin/shutdown -h now",
		"dd if=/dev/zero of=/dev/mapper/root",
		"dd if=/dev/zero of=/dev/md0"
	]) {
		const { outcome } = await run(defaultRuleHandler(), makeReq({ command }));
		assert.equal(outcome, "rejected", `must be denied: ${command}`);
	}
	// an unrecognised raw-device write asks a human rather than denying outright
	const { outcome } = await run(defaultRuleHandler(), makeReq({ command: "dd if=x of=/dev/weird" }));
	assert.notEqual(outcome, "allowed-once");
});


test("handler: a bash escalation reaches the judge and the audit with cwd, workdir and escalation", async () => {
	const cfg = baseConfig({ rules: [] });
	const records = [];
	const seen = [];
	const events = [{
		type: "assistant/message",
		data: { message: { content: [{
			type: "tool-call",
			id: "call-esc",
			name: "bash",
			arguments: JSON.stringify({
				command: "npm publish",
				description: "release",
				workdir: "plugins/dsh-codex-approval",
				sandbox_permissions: "danger-full-access",
				justification: "publishing needs the network"
			})
		}] } }
	}];
	const req = {
		toolName: "bash",
		callId: "call-esc",
		reason: "release",
		agent: { id: "agent-1", session: { id: "sess-1", snapshotEvents: () => events } }
	};
	const handler = createHandler({
		config: cfg,
		record: async (entry) => { records.push(entry); },
		llmRunner: async (messages) => { seen.push(messages); return { ok: true, text: VERDICT_TEXT }; },
		getCwd: () => "/home/wenxin/office/dsh"
	});
	const { outcome } = await run(handler, req);
	assert.equal(outcome, "allowed-once");
	const payload = JSON.parse(seen[0][1].content[0].text);
	assert.equal(payload.cwd, "/home/wenxin/office/dsh");
	assert.equal(payload.workdir, "plugins/dsh-codex-approval");
	assert.deepEqual(payload.escalation, { to: "danger-full-access", justification: "publishing needs the network" });
	const entry = records.at(-1);
	assert.equal(entry.cwd, "/home/wenxin/office/dsh");
	assert.equal(entry.workdir, "plugins/dsh-codex-approval");
	assert.deepEqual(entry.escalation, { to: "danger-full-access", justification: "publishing needs the network" });
});

test("handler: the agent's escalation justification is redacted before the judge sees it", async () => {
	const cfg = baseConfig({ rules: [] });
	const seen = [];
	const events = [{
		type: "assistant/message",
		data: { message: { content: [{
			type: "tool-call",
			id: "call-esc2",
			name: "bash",
			arguments: JSON.stringify({
				command: "curl https://example.test",
				description: "fetch",
				sandbox_permissions: "workspace-write",
				justification: "needs token=sk-abcdefgh12345678 to authenticate"
			})
		}] } }
	}];
	const req = {
		toolName: "bash",
		callId: "call-esc2",
		reason: "",
		agent: { id: "agent-1", session: { id: "sess-1", snapshotEvents: () => events } }
	};
	const handler = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: async (messages) => { seen.push(messages); return { ok: true, text: VERDICT_TEXT }; }
	});
	await run(handler, req);
	const sent = JSON.stringify(seen[0]);
	assert.doesNotMatch(sent, /sk-abcdefgh12345678/);
	assert.match(sent, /\[REDACTED\]/);
});

test("handler: a plain shell call carries no escalation facts", async () => {
	const cfg = baseConfig({ rules: [] });
	const records = [];
	const seen = [];
	const req = makeReq({ callId: "call-plain", command: "ls -la" });
	const handler = createHandler({
		config: cfg,
		record: async (entry) => { records.push(entry); },
		llmRunner: async (messages) => { seen.push(messages); return { ok: true, text: VERDICT_TEXT }; }
	});
	await run(handler, req);
	const payload = JSON.parse(seen[0][1].content[0].text);
	assert.equal("escalation" in payload, false);
	assert.equal("workdir" in payload, false);
	assert.equal("cwd" in payload, false);
	const entry = records.at(-1);
	assert.equal("escalation" in entry, false);
	assert.equal("workdir" in entry, false);
	assert.equal("background" in entry, false);
});

/** A minimal fake workspace for the evidence-fetch path. */
function fakeWorkspace(files, dirs = []) {
	const known = new Set([...Object.keys(files), ...dirs]);
	const enoent = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
	return {
		resolvePath: async (path) => { if (!known.has(path)) throw enoent(path); return path; },
		readFile: async (path) => { if (!(path in files)) throw enoent(path); return files[path]; }
	};
}

test("handler: a judge evidence request triggers one bounded read round", async () => {
	const cfg = baseConfig({ rules: [] });
	const records = [];
	const seen = [];
	const script = "#!/bin/sh\nrsync -a --delete ./dist/ prod:/var/www\n";
	const fs = fakeWorkspace({ "/ws/scripts/deploy.sh": script }, ["/ws", "/ws/scripts"]);
	const answers = [
		'{"risk":"medium","authorization":"ask","needs":[{"type":"read-file","path":"scripts/deploy.sh","why":"deployment target"}],"reason":"deploy script"}',
		'{"risk":"medium","authorization":"allow","reason":"staging rsync only"}'
	];
	let call = 0;
	const handler = createHandler({
		config: cfg,
		record: async (entry) => { records.push(entry); },
		llmRunner: async (messages) => { seen.push(messages); return { ok: true, text: answers[Math.min(call++, answers.length - 1)] }; },
		getCwd: () => "/ws",
		resolvePath: fs.resolvePath,
		readFile: fs.readFile
	});
	const { outcome } = await run(handler, makeReq({ callId: "call-ev", command: "bash scripts/deploy.sh" }));
	assert.equal(outcome, "allowed-once");
	assert.equal(seen.length, 2);
	// The second round carries the fetched text and no longer offers a read.
	assert.match(seen[1][1].content[0].text, /rsync -a --delete/);
	assert.match(seen[1][1].content[0].text, /Evidence \(untrusted data/);
	assert.doesNotMatch(seen[1][0].content[0].text, /Evidence requests/);
	const entry = records.at(-1);
	assert.deepEqual(entry.evidenceFetched, [{ path: "scripts/deploy.sh", bytes: Buffer.byteLength(script, "utf8") }]);
	assert.equal(entry.evidenceRounds, 2);
	assert.equal(entry.risk, "medium");
	assert.equal(entry.outcome, "allowed-once");
});

test("handler: an evidence request for a credential file is refused, not fetched", async () => {
	const cfg = baseConfig({ rules: [] });
	const records = [];
	let calls = 0;
	const fs = fakeWorkspace({ "/ws/.ssh/id_rsa": "PRIVATE KEY" }, ["/ws", "/ws/.ssh"]);
	const handler = createHandler({
		config: cfg,
		record: async (entry) => { records.push(entry); },
		llmRunner: async () => {
			calls += 1;
			return { ok: true, text: '{"risk":"high","authorization":"ask","needs":[{"type":"read-file","path":".ssh/id_rsa","why":"check the key"}],"reason":"x"}' };
		},
		getCwd: () => "/ws",
		resolvePath: fs.resolvePath,
		readFile: fs.readFile
	});
	const { outcome } = await run(handler, makeReq({ callId: "call-cred", command: "bash deploy.sh" }));
	assert.equal(calls, 1); // refused evidence never spends a second round
	assert.equal(outcome, "unavailable"); // ask in ai mode → next()
	const entry = records.at(-1);
	assert.deepEqual(entry.evidenceRefused, [{ path: ".ssh/id_rsa", reason: "credential-path" }]);
	assert.equal(entry.evidenceRounds, 1);
	// The request was made and refused: an empty fetch list is recorded, so the
	// audit shows "asked, got nothing" instead of looking like "never asked".
	assert.deepEqual(entry.evidenceFetched, []);
});

test("handler: evidenceFetch off keeps the single-round judge", async () => {
	const cfg = baseConfig({ rules: [], ai: { evidenceFetch: "off" } });
	const records = [];
	let calls = 0;
	const fs = fakeWorkspace({ "/ws/scripts/deploy.sh": "echo hi" }, ["/ws", "/ws/scripts"]);
	const handler = createHandler({
		config: cfg,
		record: async (entry) => { records.push(entry); },
		llmRunner: async () => {
			calls += 1;
			return { ok: true, text: '{"risk":"low","authorization":"allow","needs":[{"type":"read-file","path":"scripts/deploy.sh","why":"x"}],"reason":"x"}' };
		},
		getCwd: () => "/ws",
		resolvePath: fs.resolvePath,
		readFile: fs.readFile
	});
	const { outcome } = await run(handler, makeReq({ callId: "call-off", command: "bash deploy.sh" }));
	assert.equal(outcome, "allowed-once");
	assert.equal(calls, 1);
	const entry = records.at(-1);
	assert.equal("evidenceFetched" in entry, false);
	assert.equal("evidenceRefused" in entry, false);
	assert.equal("evidenceRounds" in entry, false);
});

test("handler: a failed evidence round keeps the first verdict and says so", async () => {
	const cfg = baseConfig({ rules: [] });
	const records = [];
	const fs = fakeWorkspace({ "/ws/scripts/deploy.sh": "echo hi" }, ["/ws", "/ws/scripts"]);
	let call = 0;
	const handler = createHandler({
		config: cfg,
		record: async (entry) => { records.push(entry); },
		llmRunner: async () => {
			call += 1;
			if (call === 1) return { ok: true, text: '{"risk":"high","authorization":"ask","needs":[{"type":"read-file","path":"scripts/deploy.sh","why":"x"}],"reason":"x"}' };
			return { ok: false, error: "provider down" };
		},
		getCwd: () => "/ws",
		resolvePath: fs.resolvePath,
		readFile: fs.readFile
	});
	const { outcome } = await run(handler, makeReq({ callId: "call-fail", command: "bash deploy.sh" }));
	assert.equal(call, 2);
	assert.equal(outcome, "unavailable"); // the first round's ask still decides
	const entry = records.at(-1);
	assert.equal(entry.evidenceRoundFailed, true);
	assert.equal(entry.evidenceRounds, 1);
	assert.deepEqual(entry.evidenceFetched, [{ path: "scripts/deploy.sh", bytes: 7 }]);
});

test("handler: a hardAsk rule marks the verdict and ai-auto cannot resolve it", async () => {
	const records = [];
	// ai-auto is configured to allow every ask — the red line must ignore that.
	const cfg = baseConfig({ mode: "ai-auto", mode3OnAsk: "allow", rules: [{ match: "Bash(git push*)", action: "ask", hardAsk: true }], ai: { enabled: false } });
	const handler = createHandler({ config: cfg, record: async (entry) => { records.push(entry); }, llmRunner: async () => ({ ok: false, error: "AI must not run" }) });
	const { outcome } = await run(handler, makeReq({ callId: "call-hard", command: "git push origin main" }));
	assert.equal(outcome, "rejected");
	const entry = records.at(-1);
	assert.equal(entry.hardAsk, true);
	assert.equal(entry.action, "deny");
	assert.equal(entry.viaAskResolution, true);
});

test("handler: the same ai-auto config does resolve a plain ask rule", async () => {
	const records = [];
	const cfg = baseConfig({ mode: "ai-auto", mode3OnAsk: "allow", rules: [{ match: "Bash(git status*)", action: "ask" }], ai: { enabled: false } });
	const handler = createHandler({ config: cfg, record: async (entry) => { records.push(entry); }, llmRunner: async () => ({ ok: false, error: "AI must not run" }) });
	const { outcome } = await run(handler, makeReq({ callId: "call-plain-ask", command: "git status" }));
	assert.equal(outcome, "allowed-once"); // mode3OnAsk: allow
	const entry = records.at(-1);
	assert.equal("hardAsk" in entry, false);
});

test("handler: in ai mode a hardAsk rule still asks the human", async () => {
	const records = [];
	const cfg = baseConfig({ rules: [{ match: "Bash(git push*)", action: "ask", hardAsk: true }], ai: { enabled: false } });
	const handler = createHandler({ config: cfg, record: async (entry) => { records.push(entry); }, llmRunner: async () => ({ ok: false, error: "AI must not run" }) });
	const { outcome, nextCalls } = await run(handler, makeReq({ callId: "call-hard-ai", command: "git push" }));
	assert.equal(outcome, "unavailable"); // next() — the human
	assert.equal(nextCalls.length, 1);
	assert.equal(records.at(-1).hardAsk, true);
});

test("handler: hardAskOnUnattended can keep a red line waiting for a human", async () => {
	const records = [];
	const cfg = baseConfig({ mode: "ai-auto", mode3OnAsk: "allow", rules: [{ match: "Bash(git push*)", action: "ask", hardAsk: true }], ai: { enabled: false, hardAskOnUnattended: "ask" } });
	const handler = createHandler({ config: cfg, record: async (entry) => { records.push(entry); }, llmRunner: async () => ({ ok: false, error: "AI must not run" }) });
	const { outcome } = await run(handler, makeReq({ callId: "call-hard-wait", command: "git push" }));
	assert.equal(outcome, "unavailable");
	assert.equal(records.at(-1).hardAsk, true);
});

test("default rules: publishing and credential paths are red lines, .dsh is not", () => {
	const redLines = DEFAULT_CONFIG.rules.filter((rule) => rule.hardAsk === true && typeof rule.match === "string").map((rule) => rule.match);
	for (const expected of ["Bash(git push*)", "Bash(*npm publish*)", "Pwsh(*docker push*)", "Bash(gh release create*)", "*/.ssh/*", "*\\.aws", "*/.codex/auth.json*", "*id_rsa*"]) {
		assert.ok(redLines.includes(expected), `${expected} should be a red line`);
	}
	assert.equal(redLines.some((match) => match.includes(".dsh")), false, ".dsH paths stay plain asks (dsh is used to repair dsh)");
	for (const match of ["*/.dsh/profiles/*", "*/.dsh/settings.yaml*", "*/.dsh/logs/approval.jsonl*"]) {
		const rule = DEFAULT_CONFIG.rules.find((candidate) => candidate.match === match);
		assert.equal(rule?.action, "ask");
		assert.equal(rule?.hardAsk, undefined);
	}
});

test("normalizeConfig: hardAskOnUnattended only accepts deny/ask", () => {
	assert.equal(normalizeConfig({}).ai.hardAskOnUnattended, "deny");
	assert.equal(normalizeConfig({ ai: { hardAskOnUnattended: "ask" } }).ai.hardAskOnUnattended, "ask");
	// "allow" is not a legal value anywhere: a red line is never auto-granted.
	assert.throws(() => normalizeConfig({ ai: { hardAskOnUnattended: "allow" } }), /hardAskOnUnattended/);
	assert.throws(() => normalizeConfig({ ai: { evidenceMaxFiles: 0 } }), /evidenceMaxFiles/);
	assert.throws(() => normalizeConfig({ ai: { evidenceFetch: "all" } }), /evidenceFetch/);
	assert.throws(() => normalizeConfig({ rules: [{ match: "Bash(x)", action: "ask", hardAsk: "yes" }] }), /hardAsk/);
});

// ---------- 第 2 条：总预算 / 拒绝熔断 / 一次性人工放行 ----------

test("makeLlmRunner: a spent budget stops the chain before any model call", async () => {
	const calls = [];
	const llm = makeStubLlm({ "p/m": { text: VERDICT_TEXT } }, calls);
	const runner = makeLlmRunner(llm, { provider: "p", model: "m", timeoutMs: 1000, maxTokens: 7, fallbacks: [{ provider: "q", model: "n" }] });
	const result = await runner([], { deadline: Date.now() - 1 });
	assert.equal(result.ok, false);
	assert.equal(result.budgetExhausted, true);
	assert.match(result.error, /budget exhausted/);
	assert.equal(calls.length, 0, "an exhausted budget must not reach the provider");
});

test("makeLlmRunner: a budget still in the future leaves the chain unchanged", async () => {
	const llm = makeStubLlm({ "p/m": { text: VERDICT_TEXT } });
	const runner = makeLlmRunner(llm, { provider: "p", model: "m", timeoutMs: 1000, maxTokens: 7 });
	const result = await runner([], { deadline: Date.now() + 60_000 });
	assert.equal(result.ok, true);
	assert.equal(result.budgetExhausted, undefined);
});

test("handler: an exhausted judge budget is surfaced in the audit", async () => {
	const cfg = baseConfig({ rules: [] });
	const records = [];
	const handler = createHandler({
		config: cfg,
		record: async (entry) => { records.push(entry); },
		llmRunner: async () => ({ ok: false, error: "judge budget exhausted before any attempt", budgetExhausted: true })
	});
	const { outcome } = await run(handler, makeReq({ callId: "call-budget", command: "bash deploy.sh" }));
	assert.equal(outcome, "unavailable"); // failOpen ask → next()
	assert.equal(records.at(-1).budgetExhausted, true);
});

test("handler: the duplicate-action breaker refuses a repeatedly denied action without a model call", async () => {
	const cfg = baseConfig({ rules: [], denialBreaker: { consecutive: 0, duplicate: 2, cooldownMs: 60_000 } });
	const records = [];
	const breakerStore = new Map();
	let calls = 0;
	const handler = createHandler({
		config: cfg,
		record: async (entry) => { records.push(entry); },
		llmRunner: async () => { calls += 1; return { ok: true, text: '{"risk":"high","authorization":"deny","reason":"no"}' }; },
		breakerStore
	});
	assert.equal((await run(handler, makeReq({ callId: "d1", command: "rm -rf /tmp/x" }))).outcome, "rejected");
	assert.equal((await run(handler, makeReq({ callId: "d2", command: "rm -rf /tmp/x" }))).outcome, "rejected");
	const third = await run(handler, makeReq({ callId: "d3", command: "rm -rf /tmp/x" }));
	assert.equal(third.outcome, "rejected");
	assert.equal(calls, 2, "the third request is refused by the breaker, not by the model");
	assert.equal(records.at(-1).breaker, "duplicate-action");
	// A different action is unaffected.
	assert.equal((await run(handler, makeReq({ callId: "d4", command: "rm -rf /tmp/y" }))).outcome, "rejected");
	assert.equal(calls, 3);
});

test("handler: consecutive denials cool the session down, and a breaker refusal never extends it", async () => {
	const cfg = baseConfig({ rules: [], denialBreaker: { consecutive: 2, duplicate: 0, cooldownMs: 60_000 } });
	const records = [];
	const breakerStore = new Map();
	let calls = 0;
	const handler = createHandler({
		config: cfg,
		record: async (entry) => { records.push(entry); },
		llmRunner: async () => { calls += 1; return { ok: true, text: '{"risk":"high","authorization":"deny","reason":"no"}' }; },
		breakerStore
	});
	await run(handler, makeReq({ callId: "c1", command: "rm -rf /tmp/a" }));
	await run(handler, makeReq({ callId: "c2", command: "rm -rf /tmp/b" }));
	const afterTrip = calls;
	const state = breakerStore.get("sess-1");
	assert.ok(state.cooledUntil > Date.now(), "two denials in a row trip the breaker");
	const cooledUntil = state.cooledUntil;
	const third = await run(handler, makeReq({ callId: "c3", command: "rm -rf /tmp/c" }));
	assert.equal(third.outcome, "rejected");
	assert.equal(records.at(-1).breaker, "cooldown");
	assert.equal(calls, afterTrip, "no judge call while cooled down");
	assert.equal(state.cooledUntil, cooledUntil, "a breaker refusal must not extend its own cooldown");
});

test("handler: any non-denial resets the consecutive run", async () => {
	const cfg = baseConfig({ rules: [], denialBreaker: { consecutive: 2, duplicate: 0, cooldownMs: 60_000 } });
	const breakerStore = new Map();
	let allow = false;
	const handler = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: allow ? '{"risk":"low","authorization":"allow","reason":"ok"}' : '{"risk":"high","authorization":"deny","reason":"no"}' }),
		breakerStore
	});
	await run(handler, makeReq({ callId: "r1", command: "rm -rf /tmp/a" }));
	allow = true;
	assert.equal((await run(handler, makeReq({ callId: "r2", command: "ls /tmp" }))).outcome, "allowed-once");
	assert.equal(breakerStore.get("sess-1").consecutive, 0);
	allow = false;
	await run(handler, makeReq({ callId: "r3", command: "rm -rf /tmp/b" }));
	assert.equal(breakerStore.get("sess-1").cooledUntil, 0, "one denial after a reset is not a run of two");
});

test("handler: an allow-once grant runs that exact action once, without a judge call", async () => {
	const cfg = baseConfig({ rules: [], denialBreaker: { consecutive: 0, duplicate: 0, cooldownMs: 0 } });
	const records = [];
	const history = new Map();
	const breakerStore = new Map();
	let calls = 0;
	const handler = createHandler({
		config: cfg,
		record: async (entry) => { records.push(entry); },
		llmRunner: async () => { calls += 1; return { ok: true, text: '{"risk":"high","authorization":"deny","reason":"no"}' }; },
		denialHistory: history,
		breakerStore
	});
	assert.equal((await run(handler, makeReq({ callId: "g1", command: "bash deploy.sh" }))).outcome, "rejected");

	const { registerAllowOnceCommand } = await import("../index.js");
	let registered = null;
	registerAllowOnceCommand({ inject: (deps, fn) => fn({ commands: { register: (def) => { registered = def; } } }) }, { history, breakerStore });
	const listed = await registered.handler({ agent: { session: { id: "sess-1" } }, rawInput: "" });
	assert.equal(listed.kind, "success");
	assert.match(listed.text, /Recently denied actions/);
	assert.match(listed.text, /bash deploy\.sh/);

	const granted = await registered.handler({ agent: { session: { id: "sess-1" } }, rawInput: "1" });
	assert.equal(granted.kind, "success");
	assert.match(granted.text, /Approved once/);

	const before = calls;
	const allowed = await run(handler, makeReq({ callId: "g2", command: "bash deploy.sh" }));
	assert.equal(allowed.outcome, "allowed-once");
	assert.equal(calls, before, "a human override must not spend a judge call");
	assert.equal(records.at(-1).manualOverride, true);
	assert.equal(records.at(-1).kind, "manual-override");

	// Spent: the next identical action goes back through the judge (which denies).
	assert.equal((await run(handler, makeReq({ callId: "g3", command: "bash deploy.sh" }))).outcome, "rejected");
	assert.equal(calls, before + 1);
});

test("handler: an allow-once grant cannot re-enable a rule denial", async () => {
	const { actionKeyOf } = await import("../index.js");
	const cfg = baseConfig({ rules: [{ match: "Bash(rm *)", action: "deny" }] });
	const records = [];
	const breakerStore = new Map();
	let calls = 0;
	const actionKey = actionKeyOf("bash", "rm -rf /tmp/x");
	breakerStore.set("sess-1", { consecutive: 0, cooledUntil: 0, actions: new Map(), oneShot: new Map([[actionKey, 1]]) });
	const handler = createHandler({
		config: cfg,
		record: async (entry) => { records.push(entry); },
		llmRunner: async () => { calls += 1; return { ok: true, text: VERDICT_TEXT }; },
		breakerStore
	});
	const { outcome } = await run(handler, makeReq({ callId: "rd1", command: "rm -rf /tmp/x" }));
	assert.equal(outcome, "rejected");
	assert.equal(calls, 0);
	assert.equal(records.at(-1).kind, "rule");
	assert.equal("manualOverride" in records.at(-1), false);
	// The grant is untouched: it was never consumed.
	assert.equal(breakerStore.get("sess-1").oneShot.get(actionKey), 1);
});

test("registerAllowOnceCommand: numbers, unknowns, empty history and zh copy", async () => {
	const { registerAllowOnceCommand } = await import("../index.js");
	const history = new Map([["s1", [
		{ command: "old cmd", source: "rule", key: "k1", ts: 1 },
		{ command: "new cmd", source: "breaker", key: "k2", ts: 2 }
	]]]);
	const breakerStore = new Map();
	let registered = null;
	registerAllowOnceCommand({ inject: (deps, fn) => fn({ commands: { register: (def) => { registered = def; } } }) }, { history, breakerStore, getLocale: () => "en" });
	assert.match(registered.description, /approve one/);

	const listed = await registered.handler({ agent: { session: { id: "s1" } }, rawInput: "" });
	const lines = listed.text.split("\n");
	assert.match(lines[1], /^1\. `new cmd` \(source: rejection breaker/);
	assert.match(lines[2], /^2\. `old cmd` \(source: deterministic rule/);

	assert.match((await registered.handler({ agent: { session: { id: "s1" } }, rawInput: "9" })).text, /Unknown number/);
	assert.match((await registered.handler({ agent: { session: { id: "s1" } }, rawInput: "abc" })).text, /Unknown number/);
	assert.match((await registered.handler({ agent: { session: { id: "other" } }, rawInput: "" })).text, /No action has been denied/);

	// Granting writes the one-shot for that key.
	await registered.handler({ agent: { session: { id: "s1" } }, rawInput: "1" });
	assert.equal(breakerStore.get("s1").oneShot.get("k2"), 1);

	let zh = null;
	registerAllowOnceCommand({ inject: (deps, fn) => fn({ commands: { register: (def) => { zh = def; } } }) }, { history, breakerStore, getLocale: () => "zh" });
	assert.match(zh.description, /授权其中一条/);
	const zhList = await zh.handler({ agent: { session: { id: "s1" } }, rawInput: "" });
	assert.match(zhList.text, /最近被自动审批拒绝的动作/);
	assert.match(zhList.text, /来源：拒绝熔断/);
});
