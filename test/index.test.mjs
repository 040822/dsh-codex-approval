import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, normalizeConfig, createHandler, makeRecorder, makeModeStore } from "../index.js";
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
		inject: () => {},
		logger: { info: () => {}, warn: () => {} }
	};
	await apply(ctx, { logFile });
	assert.deepEqual(Object.keys(listeners), ["approval/request"]);
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
