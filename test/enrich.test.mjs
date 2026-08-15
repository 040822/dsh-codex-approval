import { test } from "node:test";
import assert from "node:assert/strict";
import { findToolCallArgs, argsPreview } from "../enrich.js";

function assistantMsg(parts) {
	return { type: "assistant/message", data: { message: { content: parts } } };
}

test("findToolCallArgs: finds the matching tool-call by callId", () => {
	const events = [
		assistantMsg([
			{ type: "text", text: "running" },
			{ type: "tool-call", id: "call-1", name: "bash", arguments: JSON.stringify({ command: "ls -la", description: "List files" }) }
		])
	];
	assert.deepEqual(findToolCallArgs(events, "call-1"), { command: "ls -la", description: "List files" });
});

test("findToolCallArgs: scans newest events first", () => {
	const events = [
		assistantMsg([{ type: "tool-call", id: "call-old", name: "bash", arguments: JSON.stringify({ command: "old" }) }]),
		assistantMsg([{ type: "tool-call", id: "call-new", name: "bash", arguments: JSON.stringify({ command: "new" }) }])
	];
	assert.deepEqual(findToolCallArgs(events, "call-new"), { command: "new" });
	assert.deepEqual(findToolCallArgs(events, "call-old"), { command: "old" });
});

test("findToolCallArgs: wrong callId returns null", () => {
	const events = [assistantMsg([{ type: "tool-call", id: "call-1", name: "bash", arguments: "{}" }])];
	assert.equal(findToolCallArgs(events, "call-zzz"), null);
});

test("findToolCallArgs: malformed arguments JSON returns null", () => {
	const events = [assistantMsg([{ type: "tool-call", id: "call-1", name: "bash", arguments: "{oops" }])];
	assert.equal(findToolCallArgs(events, "call-1"), null);
});

test("findToolCallArgs: no events / no content returns null", () => {
	assert.equal(findToolCallArgs([], "call-1"), null);
	assert.equal(findToolCallArgs([assistantMsg([{ type: "text", text: "hi" }])], "call-1"), null);
	assert.equal(findToolCallArgs([{ type: "user/message", data: { content: [] } }], "call-1"), null);
	assert.equal(findToolCallArgs(undefined, "call-1"), null);
	assert.equal(findToolCallArgs([assistantMsg([{ type: "tool-call", id: "call-1", arguments: "{}" }])], undefined), null);
});

test("findToolCallArgs: null/odd events are skipped defensively", () => {
	const events = [null, "garbage", assistantMsg([{ type: "tool-call", id: "call-1", arguments: "{}" }])];
	assert.deepEqual(findToolCallArgs(events, "call-1"), {});
});

test("argsPreview: bash uses the raw command", () => {
	assert.equal(argsPreview({ command: "git status", description: "x" }, "bash", 200), "git status");
	assert.equal(argsPreview({ command: "Get-Process" }, "pwsh", 200), "Get-Process");
});

test("argsPreview: non-bash falls back to JSON", () => {
	const preview = argsPreview({ a: 1, b: "two" }, "web", 200);
	assert.equal(preview, JSON.stringify({ a: 1, b: "two" }));
});

test("argsPreview: truncation respects maxChars", () => {
	const long = "x".repeat(500);
	assert.equal(argsPreview({ command: long }, "bash", 100).length, 101); // 100 + ellipsis
	assert.equal(argsPreview(long, "bash", 100).endsWith("…"), true);
});

test("argsPreview: null/undefined/primitive handling", () => {
	assert.equal(argsPreview(null, "bash", 100), "");
	assert.equal(argsPreview(undefined, "bash", 100), "");
	assert.equal(argsPreview(42, "bash", 100), "42");
});
