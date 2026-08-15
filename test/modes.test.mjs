import { test } from "node:test";
import assert from "node:assert/strict";
import { MODES, parseMode, resolveMode, effectiveOnAsk } from "../modes.js";

test("parseMode: canonical names", () => {
	assert.equal(parseMode("manual"), "manual");
	assert.equal(parseMode("ai"), "ai");
	assert.equal(parseMode("ai-auto"), "ai-auto");
});

test("parseMode: numeric aliases 1/2/3", () => {
	assert.equal(parseMode("1"), "manual");
	assert.equal(parseMode("2"), "ai");
	assert.equal(parseMode("3"), "ai-auto");
});

test("parseMode: case and whitespace tolerant", () => {
	assert.equal(parseMode("  AI  "), "ai");
	assert.equal(parseMode("AI-AUTO"), "ai-auto");
});

test("parseMode: rejects invalid input", () => {
	assert.equal(parseMode("full-access"), null);
	assert.equal(parseMode("4"), null);
	assert.equal(parseMode(""), null);
	assert.equal(parseMode(undefined), null);
	assert.equal(parseMode(null), null);
	assert.equal(parseMode(3), null);
});

test("resolveMode: session override wins over config default", () => {
	assert.equal(resolveMode("ai-auto", "ai"), "ai-auto");
	assert.equal(resolveMode("manual", "ai"), "manual");
});

test("resolveMode: no override falls back to config default", () => {
	assert.equal(resolveMode(undefined, "ai"), "ai");
	assert.equal(resolveMode(null, "ai-auto"), "ai-auto");
});

test("resolveMode: invalid override ignored, invalid default → ai", () => {
	assert.equal(resolveMode("nonsense", "ai"), "ai");
	assert.equal(resolveMode(undefined, "nonsense"), "ai");
	assert.equal(resolveMode("nonsense", "nonsense"), "ai");
});

test("effectiveOnAsk: ai mode keeps ask (human)", () => {
	assert.equal(effectiveOnAsk("ai", "deny"), "ask");
	assert.equal(effectiveOnAsk("ai", "allow"), "ask");
});

test("effectiveOnAsk: ai-auto resolves through mode3OnAsk", () => {
	assert.equal(effectiveOnAsk("ai-auto", "deny"), "deny");
	assert.equal(effectiveOnAsk("ai-auto", "allow"), "allow");
});

test("effectiveOnAsk: ai-auto with invalid mode3OnAsk falls back to deny", () => {
	assert.equal(effectiveOnAsk("ai-auto", "ask"), "deny");
	assert.equal(effectiveOnAsk("ai-auto", "maybe"), "deny");
	assert.equal(effectiveOnAsk("ai-auto", undefined), "deny");
});

test("effectiveOnAsk: manual is defensive ask (unreachable in handler)", () => {
	assert.equal(effectiveOnAsk("manual", "deny"), "ask");
});

test("MODES is the closed three-value vocabulary", () => {
	assert.deepEqual(MODES, ["manual", "ai", "ai-auto"]);
});
