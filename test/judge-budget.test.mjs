/**
 * The approval budget, and the fallback chain it used to silently disable.
 *
 * The shipped combination on this machine — `timeoutMs: 60000` (raised by hand)
 * against the default `totalBudgetMs: 30000` — meant the primary candidate
 * could consume the entire budget, so `attemptJudge` never had anything left
 * for the configured fallbacks: `judgeAttempts` was 1 in all 82 records that
 * carried it, and `judgeFallbackFrom` was 0. A fallback chain that never
 * advances is the failure mode it exists to prevent.
 *
 * Also here: the primary route's own validation (`ai.provider` / `model` /
 * `timeoutMs` / `maxTokens`), which had none while `fallbacks` entries were
 * checked at two levels.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, createHandler, judgeBudgetMs } from "../index.js";

test("judgeBudgetMs: a ceiling shorter than one candidate's timeout is lifted so the fallbacks get their turn", () => {
	const fallbacks = [{ provider: "q", model: "fast" }];
	// This machine's combination: 60s per candidate under a 30s ceiling.
	assert.equal(judgeBudgetMs({ totalBudgetMs: 30_000, timeoutMs: 60_000, fallbacks }), 120_000);
	// A ceiling that already covers every candidate is never lowered.
	assert.equal(judgeBudgetMs({ totalBudgetMs: 90_000, timeoutMs: 30_000, fallbacks }), 90_000);
	// One candidate, consistent budget: untouched.
	assert.equal(judgeBudgetMs({ totalBudgetMs: 5_000, timeoutMs: 5_000, fallbacks: [] }), 5_000);
	// `0` still means "no budget at all", not "budget = timeout".
	assert.equal(judgeBudgetMs({ totalBudgetMs: 0, timeoutMs: 60_000, fallbacks }), 0);
});

test("normalizeConfig: the shipped defaults are a consistent budget", () => {
	const ai = normalizeConfig({}).ai;
	assert.equal(ai.timeoutMs, 15_000);
	assert.equal(ai.totalBudgetMs, 30_000);
	assert.equal(judgeBudgetMs(ai), 30_000, "the default ceiling already covers both candidates");
});

test("assertConfig: the primary judge route is validated", () => {
	const cases = [
		[{ provider: "" }, /ai\.provider/],
		[{ provider: 42 }, /ai\.provider/],
		[{ model: "" }, /ai\.model/],
		[{ model: null }, /ai\.model/],
		// A YAML `timeoutMs: "15s"` used to reach `AbortSignal.timeout()` and throw
		// outside the guard, turning the request into an unavailable approval.
		[{ timeoutMs: "15s" }, /ai\.timeoutMs/],
		[{ timeoutMs: 0 }, /ai\.timeoutMs/],
		[{ timeoutMs: -1 }, /ai\.timeoutMs/],
		[{ timeoutMs: 1.5 }, /ai\.timeoutMs/],
		[{ timeoutMs: 600_001 }, /ai\.timeoutMs/],
		[{ maxTokens: 0 }, /ai\.maxTokens/],
		[{ maxTokens: "512" }, /ai\.maxTokens/],
		[{ maxTokens: 100_000 }, /ai\.maxTokens/]
	];
	for (const [patch, pattern] of cases) {
		assert.throws(() => normalizeConfig({ ai: patch }), pattern, JSON.stringify(patch));
	}
	// The values this machine actually runs must stay accepted.
	const ai = normalizeConfig({ ai: { timeoutMs: 60_000, maxTokens: 2048, provider: "cpa-wx301", model: "command/deepseek/deepseek-v4.1-flash" } }).ai;
	assert.equal(ai.timeoutMs, 60_000);
	assert.equal(ai.maxTokens, 2048);
});

test("handler: the fallback is tried when the primary hangs", async () => {
	// The pre-fix arithmetic gave the primary the whole budget, so the chain
	// stopped after one attempt; `judgeBudgetMs` gives each candidate a full
	// attempt, and this pins that the second one is actually reached.
	const tried = [];
	const llm = {
		async prepareCall(config) {
			const id = `${config.provider}/${config.model}`;
			tried.push(id);
			return {
				config,
				stream: async function* ({ signal } = {}) {
					if (config.model === "slow") {
						await new Promise((resolve) => {
							const timer = setTimeout(resolve, 2000);
							signal?.addEventListener?.("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
						});
						throw Object.assign(new Error("aborted"), { name: "AbortError" });
					}
					yield { type: "text-delta", text: '{"risk":"low","authorization":"allow","reason":"fallback"}' };
					yield { type: "finish", reason: { kind: "stop" } };
				}
			};
		}
	};
	const cfg = normalizeConfig({
		mode: "ai-auto", rules: [],
		ai: { provider: "p", model: "slow", timeoutMs: 120, totalBudgetMs: 120, maxTokens: 16, fallbacks: [{ provider: "q", model: "fast" }] }
	});
	const events = [{
		type: "assistant/message",
		data: { message: { content: [{ type: "tool-call", id: "c1", name: "bash", arguments: JSON.stringify({ command: "npm run build" }) }] } }
	}];
	const session = { id: "s", header: { cwd: "/ws" }, events, snapshotEvents: () => events };
	const handler = createHandler({
		config: cfg, record: async () => {},
		llmRunner: (await import("../index.js")).makeLlmRunner(llm, () => cfg.ai),
		getCwd: (a) => a?.session?.header?.cwd
	});
	const outcome = await handler({ toolName: "bash", callId: "c1", reason: "", agent: { id: "a", session } }, async () => "unavailable");
	assert.deepEqual(tried, ["p/slow", "q/fast"], "the fallback must be reached after the primary times out");
	assert.equal(outcome, "allowed-once", "the fallback's verdict is the one that lands");
});
