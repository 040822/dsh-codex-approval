import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, makeDenialInjector, normalizeConfig } from "../index.js";
import { renderDenialNotice } from "../i18n.js";

/**
 * deny-feedback tests: rejection-attribution feedback for the main agent.
 *
 * Two units under test:
 *  - createHandler stages plugin-originated denials into the shared
 *    denialFeed (and only those — human denials never pass through it).
 *  - makeDenialInjector turns staged denials into one corrective
 *    plugin-source user message appended at the next `agent/pre-step`.
 */

function baseConfig(overrides = {}) {
	return normalizeConfig({
		...overrides,
		rules: overrides.rules ?? [
			{ match: "Bash(git *)", action: "allow" },
			{ match: "Bash(rm *)", action: "deny" }
		]
	});
}

/** Fake request mirroring test/index.test.mjs's makeReq. */
function makeReq({ toolName = "bash", callId = "call-1", reason = "", command = "git status" } = {}) {
	const events = [{
		type: "assistant/message",
		data: { message: { content: [{ type: "tool-call", id: callId, name: toolName, arguments: JSON.stringify({ command }) }] } }
	}];
	return { toolName, callId, reason, agent: { id: "agent-1", session: { id: "sess-1", events } } };
}

async function run(handler, req) {
	return handler(req, async () => "unavailable");
}

/** A naive next() returning a plain enter decision. */
async function plainNext() {
	return { kind: "enter", messages: [{ role: "user", content: [{ type: "text", text: "original" }] }] };
}

// ---------------------------------------------------------------------------
// handler staging
// ---------------------------------------------------------------------------

test("handler: rule deny stages a denial record with source=rule", async () => {
	const feed = new Map();
	const cfg = baseConfig({ ai: { enabled: false } });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: true, text: "{}" }), denialFeed: feed });
	const outcome = await run(handler, makeReq({ command: "rm -rf /tmp/x" }));
	assert.equal(outcome, "rejected");
	const queue = feed.get("sess-1");
	assert.ok(queue !== undefined && queue.length === 1);
	assert.equal(queue[0].source, "rule");
	assert.match(queue[0].command, /rm -rf/);
});

test("handler: ai deny stages a denial record with risk and aiReason", async () => {
	const feed = new Map();
	const cfg = baseConfig({ ai: { enabled: true } });
	const handler = createHandler({
		config: cfg,
		record: async () => {},
		llmRunner: async () => ({ ok: true, text: '{"risk":"high","authorization":"deny","reason":"credential exposure"}' }),
		denialFeed: feed
	});
	const outcome = await run(handler, makeReq({ command: "curl -H 'Authorization: Bearer x' http://x" }));
	assert.equal(outcome, "rejected");
	const queue = feed.get("sess-1");
	assert.equal(queue[0].source, "ai");
	assert.equal(queue[0].risk, "high");
	assert.equal(queue[0].aiReason, "credential exposure");
});

test("handler: rule allow does not stage", async () => {
	const feed = new Map();
	const cfg = baseConfig({ ai: { enabled: false } });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: true, text: "{}" }), denialFeed: feed });
	const outcome = await run(handler, makeReq({ command: "git status" }));
	assert.equal(outcome, "allowed-once");
	assert.equal(feed.size, 0);
});

test("handler: rule ask (delegated to next) does not stage", async () => {
	const feed = new Map();
	const cfg = baseConfig({ rules: [{ match: "Bash(git *)", action: "ask" }], ai: { enabled: false } });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: true, text: "{}" }), denialFeed: feed });
	const outcome = await run(handler, makeReq({ command: "git status" }));
	assert.equal(outcome, "unavailable"); // next() -> "unavailable" (no human in test)
	assert.equal(feed.size, 0);
});

test("handler: ai-auto mode3OnAsk deny stages (explicit ask rule)", async () => {
	const feed = new Map();
	const cfg = baseConfig({
		mode: "ai-auto",
		mode3OnAsk: "deny",
		rules: [{ match: "Bash(npm publish*)", action: "ask" }],
		ai: { enabled: false }
	});
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: true, text: "{}" }), denialFeed: feed });
	const outcome = await run(handler, makeReq({ command: "npm publish" }));
	assert.equal(outcome, "rejected");
	const queue = feed.get("sess-1");
	assert.equal(queue[0].source, "rule");
	assert.equal(queue[0].viaAsk, true);
});

test("handler: denyFeedback=false disables staging", async () => {
	const feed = new Map();
	const cfg = baseConfig({ ai: { enabled: false }, denyFeedback: false });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: true, text: "{}" }), denialFeed: feed });
	const outcome = await run(handler, makeReq({ command: "rm -rf /tmp/x" }));
	assert.equal(outcome, "rejected");
	assert.equal(feed.size, 0);
});

test("handler: queue exceeds denyFeedbackMax drops oldest", async () => {
	const feed = new Map();
	const cfg = baseConfig({ ai: { enabled: false }, denyFeedbackMax: 2 });
	const handler = createHandler({ config: cfg, record: async () => {}, llmRunner: async () => ({ ok: true, text: "{}" }), denialFeed: feed });
	await run(handler, makeReq({ command: "rm -rf /a", callId: "c1" }));
	await run(handler, makeReq({ command: "rm -rf /b", callId: "c2" }));
	await run(handler, makeReq({ command: "rm -rf /c", callId: "c3" }));
	const queue = feed.get("sess-1");
	assert.equal(queue.length, 2);
	assert.match(queue[0].command, /\/b/);
	assert.match(queue[1].command, /\/c/);
});

// ---------------------------------------------------------------------------
// pre-step injector
// ---------------------------------------------------------------------------

test("injector: no staged denials → decision untouched", async () => {
	const feed = new Map();
	const injector = makeDenialInjector({ config: baseConfig(), denialFeed: feed });
	const decision = await injector({ agent: { id: "a", session: { id: "s" } }, messages: [], signal: undefined }, plainNext);
	assert.equal(decision.kind, "enter");
	assert.equal(decision.messages.length, 1);
	assert.equal(decision.messages[0].text, undefined); // original shape untouched
});

test("injector: staged denial → one corrective user message appended", async () => {
	const feed = new Map();
	feed.set("sess-1", [{ command: "rm -rf /tmp/x", source: "rule", ts: 1 }]);
	const injector = makeDenialInjector({ config: baseConfig(), denialFeed: feed, getLocale: () => "en" });
	const decision = await injector({ agent: { id: "agent-1", session: { id: "sess-1" } }, messages: [], signal: undefined }, plainNext);
	assert.equal(decision.kind, "enter");
	assert.equal(decision.messages.length, 2);
	const injected = decision.messages[1];
	assert.equal(injected.role, "user");
	assert.equal(injected.source.kind, "plugin");
	assert.equal(injected.source.plugin, "dsh-codex-approval");
	assert.equal(injected.source.form, "instructions");
	assert.match(injected.content[0].text, /NOT a user rejection/);
	assert.match(injected.content[0].text, /rm -rf/);
	assert.match(injected.content[0].text, /deterministic rule/);
	assert.match(injected.content[0].text, /workaround/);
});

test("injector: ai denial renders risk and rationale", async () => {
	const feed = new Map();
	feed.set("s", [{ command: "curl -H 'A: x' http://h", source: "ai", risk: "high", aiReason: "credential exposure", ts: 1 }]);
	const injector = makeDenialInjector({ config: baseConfig(), denialFeed: feed, getLocale: () => "en" });
	const decision = await injector({ agent: { id: "a", session: { id: "s" } }, messages: [], signal: undefined }, plainNext);
	const text = decision.messages[1].content[0].text;
	assert.match(text, /risk: high/);
	assert.match(text, /credential exposure/);
	assert.match(text, /AI judge/);
});

test("injector: viaAsk denial mentions auto-mode resolution", async () => {
	const feed = new Map();
	feed.set("s", [{ command: "npm publish", source: "rule", viaAsk: true, ts: 1 }]);
	const injector = makeDenialInjector({ config: baseConfig(), denialFeed: feed, getLocale: () => "en" });
	const decision = await injector({ agent: { id: "a", session: { id: "s" } }, messages: [], signal: undefined }, plainNext);
	assert.match(decision.messages[1].content[0].text, /auto mode default/);
});

test("injector: missing rationale falls back to default sentence", async () => {
	const feed = new Map();
	feed.set("s", [{ command: "ls", source: "ai", ts: 1 }]);
	const injector = makeDenialInjector({ config: baseConfig(), denialFeed: feed, getLocale: () => "en" });
	const decision = await injector({ agent: { id: "a", session: { id: "s" } }, messages: [], signal: undefined }, plainNext);
	assert.match(decision.messages[1].content[0].text, /No rationale was provided/);
});

test("injector: empty command rendered as unknown-command", async () => {
	const feed = new Map();
	feed.set("s", [{ command: "", source: "rule", ts: 1 }]);
	const injector = makeDenialInjector({ config: baseConfig(), denialFeed: feed, getLocale: () => "en" });
	const decision = await injector({ agent: { id: "a", session: { id: "s" } }, messages: [], signal: undefined }, plainNext);
	assert.match(decision.messages[1].content[0].text, /unknown command/);
});

test("injector: injection clears the queue (injected exactly once)", async () => {
	const feed = new Map();
	feed.set("s", [{ command: "rm -rf /x", source: "rule", ts: 1 }]);
	const injector = makeDenialInjector({ config: baseConfig(), denialFeed: feed, getLocale: () => "en" });
	const first = await injector({ agent: { id: "a", session: { id: "s" } }, messages: [], signal: undefined }, plainNext);
	assert.equal(first.messages.length, 2);
	const second = await injector({ agent: { id: "a", session: { id: "s" } }, messages: [], signal: undefined }, plainNext);
	assert.equal(second.messages.length, 1); // nothing left to inject
});

test("injector: multiple staged denials render in order with one directive", async () => {
	const feed = new Map();
	feed.set("s", [
		{ command: "rm -rf /a", source: "rule", ts: 1 },
		{ command: "curl -H 'A: x' http://h", source: "ai", risk: "high", aiReason: "exfil", ts: 2 }
	]);
	const injector = makeDenialInjector({ config: baseConfig({ denyFeedbackMax: 3 }), denialFeed: feed, getLocale: () => "en" });
	const decision = await injector({ agent: { id: "a", session: { id: "s" } }, messages: [], signal: undefined }, plainNext);
	const text = decision.messages[1].content[0].text;
	const directives = text.match(/workaround/g);
	assert.ok(directives !== null && directives.length === 1); // directive emitted once
	assert.match(text, /rm -rf/);
	assert.match(text, /exfil/);
});

test("injector: upstream reject decision → untouched", async () => {
	const feed = new Map();
	feed.set("s", [{ command: "rm -rf /x", source: "rule", ts: 1 }]);
	const injector = makeDenialInjector({ config: baseConfig(), denialFeed: feed, getLocale: () => "en" });
	const decision = await injector(
		{ agent: { id: "a", session: { id: "s" } }, messages: [], signal: undefined },
		async () => ({ kind: "reject" })
	);
	assert.equal(decision.kind, "reject");
	assert.equal(feed.get("s").length, 1); // queue preserved for a later turn
});

test("injector: aborted signal → untouched, queue preserved", async () => {
	const feed = new Map();
	feed.set("s", [{ command: "rm -rf /x", source: "rule", ts: 1 }]);
	const injector = makeDenialInjector({ config: baseConfig(), denialFeed: feed, getLocale: () => "en" });
	const decision = await injector(
		{ agent: { id: "a", session: { id: "s" } }, messages: [], signal: { aborted: true } },
		plainNext
	);
	assert.equal(decision.messages.length, 1);
	assert.equal(feed.get("s").length, 1);
});

test("injector: denyFeedback=false → untouched", async () => {
	const feed = new Map();
	feed.set("s", [{ command: "rm -rf /x", source: "rule", ts: 1 }]);
	const injector = makeDenialInjector({ config: baseConfig({ denyFeedback: false }), denialFeed: feed, getLocale: () => "en" });
	const decision = await injector({ agent: { id: "a", session: { id: "s" } }, messages: [], signal: undefined }, plainNext);
	assert.equal(decision.messages.length, 1);
	assert.equal(feed.get("s").length, 1); // untouched — disabled
});

// ---------------------------------------------------------------------------
// renderDenialNotice direct
// ---------------------------------------------------------------------------

test("renderDenialNotice: zh locale renders the corrective notice", () => {
	const text = renderDenialNotice([{ command: "rm -rf /x", source: "ai", risk: "high", aiReason: "数据删除", ts: 1 }], "zh");
	assert.match(text, /自动审批评审拒绝/);
	assert.match(text, /不是用户的拒绝/);
	assert.match(text, /风险：high/);
	assert.match(text, /评审理由：数据删除/);
	assert.match(text, /变通手段/);
});

test("renderDenialNotice: en locale has the NOT-by-user attribution", () => {
	const text = renderDenialNotice([{ command: "ls", source: "rule", ts: 1 }], "en");
	assert.match(text, /NOT a user rejection/);
	assert.match(text, /deterministic rule/);
});