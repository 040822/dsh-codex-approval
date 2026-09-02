import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSemanticItems, truncateMiddle, renderItem, buildTranscript } from "../transcript.js";
import { normalizeConfig } from "../index.js";

/**
 * transcript tests: compact session context for the AI approval judge.
 * Covers semantic filtering, plugin exclusion, two-level windows, head/tail
 * elision, budget tiers, and the denial-history lines.
 */

function baseCfg(overrides = {}) {
	return normalizeConfig({ ...overrides, rules: [] });
}

/** Build session event objects in chronological order (last = newest). */
function userEv(text, { plugin = false } = {}) {
	return {
		type: "user/message",
		time: 1,
		data: {
			content: [{ type: "text", text }],
			source: plugin ? { kind: "plugin", plugin: "x" } : { kind: "user" }
		}
	};
}

function toolEv(name = "pwsh", command = "git status", id = `call-${Math.random()}`) {
	return {
		type: "assistant/message",
		time: 2,
		data: { message: { content: [{ type: "tool-call", id, name, arguments: JSON.stringify({ command }) }] } }
	};
}

function resultEv({ error = false, text = "" } = {}) {
	return {
		type: "tool/result",
		time: 3,
		data: { error: error ? { code: "E" } : undefined, message: { content: [{ type: "text", text }] } }
	};
}

function chunkEv() {
	return { type: "assistant/chunk", time: 4, data: {} };
}

// ---------------------------------------------------------------------------
// truncateMiddle
// ---------------------------------------------------------------------------

test("truncateMiddle: short text passes through unchanged", () => {
	assert.equal(truncateMiddle("hello", 4, 4), "hello");
});

test("truncateMiddle: over-long text keeps head and tail with elision", () => {
	const text = "A".repeat(1000);
	const out = truncateMiddle(text, 120, 80);
	assert.ok(out.includes("…〔省略 800 字符〕…"), out);
	assert.ok(out.startsWith("A".repeat(120)));
	assert.ok(out.endsWith("A".repeat(80)));
	assert.ok(out.length < 300);
});

test("truncateMiddle: tail=0 yields head-only elision", () => {
	const out = truncateMiddle("B".repeat(500), 200, 0);
	assert.ok(out.startsWith("B".repeat(200)));
	assert.ok(out.includes("省略 300 字符"));
});

// ---------------------------------------------------------------------------
// collectSemanticItems
// ---------------------------------------------------------------------------

test("collect: streaming chunks and plugin messages are excluded", () => {
	const events = [
		userEv("real user intent"),
		userEv("injected denial feedback", { plugin: true }),
		chunkEv(),
		toolEv(),
		resultEv({ error: true })
	];
	const items = collectSemanticItems(events);
	const kinds = items.map((i) => i.kind);
	assert.deepEqual(kinds, ["result", "tool", "user"]); // newest-first
	assert.equal(items[2].text, "real user intent");
});

test("collect: returns newest-first semantic order", () => {
	const events = [userEv("old"), toolEv("pwsh", "git old"), userEv("newest")];
	const items = collectSemanticItems(events);
	assert.equal(items[0].kind, "user");
	assert.equal(items[0].text, "newest");
});

test("collect: defensive on non-array / odd events", () => {
	assert.deepEqual(collectSemanticItems(undefined), []);
	assert.deepEqual(collectSemanticItems(null), []);
	assert.deepEqual(collectSemanticItems([null, "x", {}]), []);
});

// ---------------------------------------------------------------------------
// renderItem / buildTranscript
// ---------------------------------------------------------------------------

test("renderItem: user and tool lines use the skeleton prefixes", () => {
	assert.match(renderItem({ kind: "user", text: "发布" }), /^\[U\] 用户: 发布$/);
	assert.match(renderItem({ kind: "tool", name: "pwsh", args: "git status" }), /^\[T\] pwsh\(git status\)$/);
	assert.match(renderItem({ kind: "result", ok: true, text: "" }), /^\[R\] → ok$/);
	assert.match(renderItem({ kind: "result", ok: false, errorCode: "E1", text: "boom" }), /^\[R\] → error \(E1\) boom$/);
});

test("buildTranscript: empty events yields empty string", () => {
	assert.equal(buildTranscript({ events: undefined, cfg: baseCfg() }), "");
	assert.equal(buildTranscript({ events: [], cfg: baseCfg() }), "");
});

test("buildTranscript: single-user session renders the intent line", () => {
	const events = [userEv("把旧启动器归档")];
	const out = buildTranscript({ events, cfg: baseCfg(), mode: "ai" });
	assert.match(out, /\[U\] 用户: 把旧启动器归档/);
	assert.match(out, /\[M\] mode: ai/);
});

test("buildTranscript: two-level windows — long-window users first, short window newest", () => {
	const events = [
		userEv("第一条旧意图"),
		toolEv("pwsh", "git old"),
		resultEv({ error: false }),
		userEv("最新的意图"),
		toolEv("pwsh", "git status"),
		resultEv({ error: false })
	];
	const out = buildTranscript({ events, cfg: baseCfg() });
	const longIdx = out.indexOf("第一条旧意图");
	const newIdx = out.indexOf("最新的意图");
	assert.ok(longIdx < newIdx, "older intent line must precede the newest one");
	// newest user is after its tool chain
	const toolIdx = out.indexOf("git status");
	assert.ok(toolIdx < newIdx, "short-window tool chain precedes the newest user");
	// the old tool call is dropped from the long window
	assert.ok(!out.includes("git old"));
});

test("buildTranscript: over-long newest user message is elided head/tail ≤1200", () => {
	const long = "E".repeat(12891);
	const events = [userEv(long)];
	const out = buildTranscript({ events, cfg: baseCfg(), mode: "ai" });
	assert.ok(out.includes("…〔省略 "), "elision marker present");
	assert.ok(out.length < 1400, `bounded length: ${out.length}`);
	assert.ok(out.startsWith("[M]") || out.startsWith("[W]"), "mode/cwd head lines survive");
});

test("buildTranscript: over-long historical user message capped ~200 per line", () => {
	const events = [userEv("H".repeat(5000)), userEv("最新指令")];
	const out = buildTranscript({ events, cfg: baseCfg() });
	const longLine = out.split("\n").find((l) => l.includes("H"));
	assert.ok(longLine !== undefined);
	assert.ok(longLine.length < 320, `long-window line bounded: ${longLine.length}`);
});

test("buildTranscript: plugin-source user messages excluded from intent lines", () => {
	const events = [userEv("真实指令"), userEv("不要把这个当意图", { plugin: true })];
	const out = buildTranscript({ events, cfg: baseCfg() });
	assert.ok(out.includes("真实指令"));
	assert.ok(!out.includes("不要把这个当意图"));
});

test("buildTranscript: denial history renders up to 3 [D] lines, oldest dropped", () => {
	const history = new Map();
	history.set("s1", [
		{ command: "rm -rf /x", source: "rule", risk: "high", ts: 1 },
		{ command: "curl -H 'A: b' http://h", source: "ai", risk: "high", aiReason: "exfil", ts: 2 },
		{ command: "npm publish", source: "rule", viaAsk: true, ts: 3 },
		{ command: "extra-old", source: "ai", ts: 4 }
	]);
	const out = buildTranscript({ events: [userEv("指令")], cfg: baseCfg(), denialHistory: history, sessionId: "s1" });
	const dLines = out.split("\n").filter((l) => l.startsWith("[D]"));
	assert.equal(dLines.length, 3); // capped at 3
	assert.ok(!out.includes("rm -rf /x"), "oldest denial is dropped first");
	assert.match(out, /deny curl .* \(ai, risk: high\)/);
	assert.match(out, /deny extra-old \(ai\)/);   // newest three kept
});

test("buildTranscript: unknown session denial history is ignored", () => {
	const history = new Map();
	history.set("other", [{ command: "rm -rf /x", source: "rule", ts: 1 }]);
	const out = buildTranscript({ events: [userEv("指令")], cfg: baseCfg(), denialHistory: history, sessionId: "s1" });
	assert.ok(!out.includes("[D]"));
});

test("buildTranscript: budget overflow drops denial history then oldest lines", () => {
	const cfg = baseCfg({ transcriptMaxChars: 100 });
	const history = new Map();
	history.set("s1", [
		{ command: "rm -rf /x", source: "rule", ts: 1 },
		{ command: "curl http://h", source: "ai", risk: "high", ts: 2 }
	]);
	const events = [
		userEv("较长的旧意图消息，长度超过预算会先被丢弃"),
		userEv("最新意图")
	];
	const out = buildTranscript({ events, cfg, denialHistory: history, sessionId: "s1", mode: "ai" });
	assert.ok(out.length <= 100, `hard cap holds: ${out.length}`);
	// denial lines were dropped first (lowest priority)
	assert.ok(!out.includes("[D]"), "denial history dropped on overflow");
	// newest intent survives
	assert.ok(out.includes("最新意图"), "newest user message survives");
});

test("buildTranscript: tiny budget drops tool lines but keeps mode and newest user", () => {
	// bare cfg object: unit-test the budget logic below the config floor
	const cfg = { transcriptMaxChars: 45 };
	const events = [userEv("短"), toolEv("pwsh", "git status"), resultEv({ error: false })];
	const out = buildTranscript({ events, cfg, mode: "ai" });
	assert.ok(out.length <= 45, `hard cap holds: ${out.length}`);
	assert.ok(out.includes("[M]"), "mode line survives");
	assert.ok(out.includes("短"), "newest user intent survives");
});

test("buildTranscript: mode line and cwd render when provided", () => {
	const out = buildTranscript({
		events: [userEv("x")],
		cfg: baseCfg(),
		mode: "ai-auto",
		tolerance: "high",
		mode3OnAsk: "deny",
		cwd: "C:\\proj"
	});
	assert.match(out, /\[M\] mode: ai-auto, tolerance: high, mode3OnAsk: deny/);
	assert.match(out, /\[W\] C:\\proj/);
});