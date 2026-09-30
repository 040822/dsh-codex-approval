import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, normalizeConfig, applyConfigSettings, makeLlmRunner } from "../index.js";
import { judgeWith } from "../judge.js";

/** A stub ctx.llm that answers per provider/model and records every call. */
function makeLlm(answerByModel, calls = []) {
	return {
		async prepareCall(config) {
			calls.push(config);
			const answer = answerByModel[`${config.provider}/${config.model}`];
			return {
				config,
				stream: async function* () {
					const result = typeof answer === "function" ? answer() : answer;
					if (result?.error !== undefined) {
						yield { type: "finish", reason: { kind: "error", failure: result.error } };
						return;
					}
					yield { type: "text-delta", text: result?.text ?? "" };
					if (result?.noFinish === true) return;
					yield { type: "finish", reason: { kind: "stop" } };
				}
			};
		}
	};
}

const VERDICT = '{"risk":"low","authorization":"allow","reason":"read-only"}';

test("defaults: the judge primary and its fallback chain are declared", () => {
	assert.equal(DEFAULT_CONFIG.ai.provider, "cpa-wx301");
	assert.equal(DEFAULT_CONFIG.ai.model, "command/deepseek/deepseek-v4.1-flash");
	assert.deepEqual(DEFAULT_CONFIG.ai.fallbacks, [{ provider: "deepseek-official", model: "deepseek-flash" }]);
	const cfg = normalizeConfig({});
	assert.deepEqual(cfg.ai.fallbacks, DEFAULT_CONFIG.ai.fallbacks);
});

test("normalizeConfig: rejects malformed fallback entries and oversized chains", () => {
	assert.throws(() => normalizeConfig({ ai: { fallbacks: "nope" } }), /fallbacks must be an array/);
	assert.throws(() => normalizeConfig({ ai: { fallbacks: [{ provider: "p" }] } }), /non-empty provider and model/);
	assert.throws(() => normalizeConfig({ ai: { fallbacks: [{ provider: "", model: "m" }] } }), /non-empty provider and model/);
	assert.throws(
		() => normalizeConfig({ ai: { fallbacks: Array.from({ length: 5 }, (_, i) => ({ provider: `p${i}`, model: "m" })) } }),
		/must hold at most 4 entries/
	);
});

test("applyConfigSettings: projects the fallback chain from the settings namespace", () => {
	const cfg = applyConfigSettings(normalizeConfig({}), {
		provider: "cpa-wx301",
		model: "command/deepseek/deepseek-v4.1-flash",
		fallbacks: [{ provider: "deepseek-official", model: "deepseek-flash" }]
	});
	assert.deepEqual(cfg.ai.fallbacks, [{ provider: "deepseek-official", model: "deepseek-flash" }]);
});

test("chain: falls back to the next judge when the primary fails", async () => {
	const calls = [];
	const llm = makeLlm({
		"cpa-wx301/command/deepseek/deepseek-v4.1-flash": { error: { code: "AUTH", message: "Insufficient balance." } },
		"deepseek-official/deepseek-flash": { text: VERDICT }
	}, calls);
	const runner = makeLlmRunner(llm, {
		provider: "cpa-wx301",
		model: "command/deepseek/deepseek-v4.1-flash",
		fallbacks: [{ provider: "deepseek-official", model: "deepseek-flash" }],
		timeoutMs: 1000,
		maxTokens: 7
	});
	const result = await runner([]);
	assert.equal(result.ok, true);
	assert.equal(result.text, VERDICT);
	assert.equal(result.judgeAttempts, 2);
	assert.equal(result.judgeModel, "deepseek-official/deepseek-flash");
	assert.equal(result.judgeFallbackFrom, "cpa-wx301/command/deepseek/deepseek-v4.1-flash");
	assert.deepEqual(calls.map((call) => `${call.provider}/${call.model}`), [
		"cpa-wx301/command/deepseek/deepseek-v4.1-flash",
		"deepseek-official/deepseek-flash"
	]);
});

test("chain: a healthy primary never spends a fallback call", async () => {
	const calls = [];
	const llm = makeLlm({
		"cpa-wx301/command/deepseek/deepseek-v4.1-flash": { text: VERDICT },
		"deepseek-official/deepseek-flash": { text: VERDICT }
	}, calls);
	const runner = makeLlmRunner(llm, {
		provider: "cpa-wx301",
		model: "command/deepseek/deepseek-v4.1-flash",
		fallbacks: [{ provider: "deepseek-official", model: "deepseek-flash" }],
		timeoutMs: 1000,
		maxTokens: 7
	});
	const result = await runner([]);
	assert.equal(result.ok, true);
	assert.equal(result.judgeAttempts, 1);
	assert.equal(result.judgeModel, "cpa-wx301/command/deepseek/deepseek-v4.1-flash");
	assert.equal(result.judgeFallbackFrom, undefined);
	assert.equal(calls.length, 1);
});

test("chain: reports the primary failure when every candidate fails", async () => {
	const llm = makeLlm({
		"cpa-wx301/command/deepseek/deepseek-v4.1-flash": { error: { code: "AUTH", message: "Insufficient balance." } },
		"deepseek-official/deepseek-flash": { error: { code: "RATE_LIMIT", message: "too many requests" } }
	});
	const runner = makeLlmRunner(llm, {
		provider: "cpa-wx301",
		model: "command/deepseek/deepseek-v4.1-flash",
		fallbacks: [{ provider: "deepseek-official", model: "deepseek-flash" }],
		timeoutMs: 1000,
		maxTokens: 7
	});
	const result = await runner([]);
	assert.equal(result.ok, false);
	assert.equal(result.failure.code, "AUTH");
	assert.match(result.error, /Insufficient balance/);
	assert.equal(result.judgeAttempts, 2);
	assert.deepEqual(result.judgeTried, [
		"cpa-wx301/command/deepseek/deepseek-v4.1-flash",
		"deepseek-official/deepseek-flash"
	]);
});

test("chain: a single candidate keeps the pre-fallback result shape", async () => {
	const llm = makeLlm({ "cpa-wx301/m": { error: { code: "AUTH", message: "boom" } } });
	const result = await makeLlmRunner(llm, { provider: "cpa-wx301", model: "m", timeoutMs: 1000, maxTokens: 7 })([]);
	assert.equal(result.ok, false);
	assert.equal(result.judgeAttempts, undefined);
	assert.equal(result.judgeTried, undefined);
	assert.deepEqual(Object.keys(result).sort(), ["error", "failure", "finishKind", "ok"]);
});

test("chain: deduplicates a fallback equal to the primary and skips malformed entries", async () => {
	const calls = [];
	const llm = makeLlm({ "cpa-wx301/m": { error: { code: "AUTH", message: "boom" } } }, calls);
	const result = await makeLlmRunner(llm, {
		provider: "cpa-wx301",
		model: "m",
		fallbacks: [{ provider: "cpa-wx301", model: "m" }, { provider: "x" }, null, "junk"],
		timeoutMs: 1000,
		maxTokens: 7
	})([]);
	assert.equal(result.ok, false);
	assert.equal(result.judgeAttempts, undefined);
	assert.equal(calls.length, 1);
});

test("chain: a cancelled approval stops before spending more judge calls", async () => {
	const calls = [];
	const llm = makeLlm({ "cpa-wx301/m": { text: VERDICT }, "p2/m2": { text: VERDICT } }, calls);
	const controller = new AbortController();
	controller.abort();
	const result = await makeLlmRunner(llm, {
		provider: "cpa-wx301",
		model: "m",
		fallbacks: [{ provider: "p2", model: "m2" }],
		timeoutMs: 1000,
		maxTokens: 7
	})([], { signal: controller.signal });
	assert.equal(result.ok, false);
	assert.equal(calls.length, 0);
});

test("judgeWith: carries the answering model and attempt count into the verdict path", async () => {
	const ok = await judgeWith({
		runner: async () => ({ ok: true, text: VERDICT, judgeModel: "deepseek-official/deepseek-flash", judgeFallbackFrom: "cpa-wx301/command/deepseek/deepseek-v4.1-flash", judgeAttempts: 2 }),
		input: { toolName: "bash", argsText: "ls", reason: "" }
	});
	assert.equal(ok.ok, true);
	assert.equal(ok.judgeModel, "deepseek-official/deepseek-flash");
	assert.equal(ok.judgeFallbackFrom, "cpa-wx301/command/deepseek/deepseek-v4.1-flash");
	assert.equal(ok.judgeAttempts, 2);

	const failed = await judgeWith({
		runner: async () => ({ ok: false, error: "judge stream finished with error [AUTH]", failure: { code: "AUTH" }, judgeAttempts: 2, judgeTried: ["a/b", "c/d"] }),
		input: { toolName: "bash", argsText: "ls", reason: "" }
	});
	assert.equal(failed.ok, false);
	assert.equal(failed.judgeAttempts, 2);
	assert.deepEqual(failed.judgeTried, ["a/b", "c/d"]);
});

// --- regression: an unusable reply is a candidate failure, not a success ----
// The audit log showed `kind=ai-error` / `rawOutput:""` entries with no
// `judgeAttempts` while a configured fallback sat unused: a model that streamed
// nothing was counted as a successful attempt, so the chain ended on an empty
// string. These tests pin the corrected rule for both shapes — empty text and
// text that carries no verdict.

test("chain: an empty primary reply advances to the next candidate", async () => {
	const calls = [];
	const llm = makeLlm({
		"cpa-wx301/command/deepseek/deepseek-v4.1-flash": { text: "" },
		"deepseek-official/deepseek-flash": { text: VERDICT }
	}, calls);
	const runner = makeLlmRunner(llm, {
		provider: "cpa-wx301",
		model: "command/deepseek/deepseek-v4.1-flash",
		fallbacks: [{ provider: "deepseek-official", model: "deepseek-flash" }],
		timeoutMs: 1000,
		maxTokens: 7
	});
	const result = await runner([]);
	assert.equal(result.ok, true);
	assert.equal(result.text, VERDICT);
	assert.equal(result.judgeAttempts, 2);
	assert.equal(result.judgeModel, "deepseek-official/deepseek-flash");
	assert.equal(result.judgeFallbackFrom, "cpa-wx301/command/deepseek/deepseek-v4.1-flash");
	assert.deepEqual(calls.map((call) => `${call.provider}/${call.model}`), [
		"cpa-wx301/command/deepseek/deepseek-v4.1-flash",
		"deepseek-official/deepseek-flash"
	]);
});

test("chain: a reply with prose but no verdict also advances", async () => {
	const calls = [];
	const llm = makeLlm({
		"cpa-wx301/command/deepseek/deepseek-v4.1-flash": { text: 'Sure — I checked it: {"note":"looks fine"}' },
		"deepseek-official/deepseek-flash": { text: VERDICT }
	}, calls);
	const result = await makeLlmRunner(llm, {
		provider: "cpa-wx301",
		model: "command/deepseek/deepseek-v4.1-flash",
		fallbacks: [{ provider: "deepseek-official", model: "deepseek-flash" }],
		timeoutMs: 1000,
		maxTokens: 7
	})([]);
	assert.equal(result.ok, true);
	assert.equal(result.judgeModel, "deepseek-official/deepseek-flash");
	assert.equal(result.judgeAttempts, 2);
	assert.equal(calls.length, 2);
});

test("chain: whitespace-only replies count as empty and keep the chain moving", async () => {
	const llm = makeLlm({
		"cpa-wx301/m": { text: "  \n\t " },
		"p2/m2": { text: VERDICT }
	});
	const result = await makeLlmRunner(llm, {
		provider: "cpa-wx301",
		model: "m",
		fallbacks: [{ provider: "p2", model: "m2" }],
		timeoutMs: 1000,
		maxTokens: 7
	})([]);
	assert.equal(result.ok, true);
	assert.equal(result.text, VERDICT);
});

test("chain: every candidate empty reports the primary failure as an empty reply", async () => {
	const llm = makeLlm({
		"cpa-wx301/m": { text: "", noFinish: true },
		"p2/m2": { text: "" }
	});
	const result = await makeLlmRunner(llm, {
		provider: "cpa-wx301",
		model: "m",
		fallbacks: [{ provider: "p2", model: "m2" }],
		timeoutMs: 1000,
		maxTokens: 7
	})([]);
	assert.equal(result.ok, false);
	assert.equal(result.error, "unparseable judge output (empty reply)");
	assert.equal(result.rawText, "");
	assert.equal(result.textChars, 0);
	// the primary's evidence is what gets reported, including how its stream ended
	assert.equal(result.endedWithoutFinish, true);
	assert.equal(result.judgeAttempts, 2);
	assert.deepEqual(result.judgeTried, ["cpa-wx301/m", "p2/m2"]);
});

test("chain: a single candidate keeps the pre-fallback result shape (no chain fields)", async () => {
	const llm = makeLlm({ "cpa-wx301/m": { text: "" } });
	const result = await makeLlmRunner(llm, { provider: "cpa-wx301", model: "m", timeoutMs: 1000, maxTokens: 7 })([]);
	assert.equal(result.ok, false);
	assert.equal(result.error, "unparseable judge output (empty reply)");
	assert.equal(result.rawText, "");
	assert.equal(result.textChars, 0);
	assert.equal(result.judgeAttempts, undefined);
	assert.equal(result.judgeTried, undefined);
	assert.equal(result.judgeModel, undefined);
	assert.equal(result.judgeFallbackFrom, undefined);
});

test("chain: text without a verdict reports the no-verdict reason and its char count", async () => {
	const llm = makeLlm({ "cpa-wx301/m": { text: "I will not answer" } });
	const result = await makeLlmRunner(llm, { provider: "cpa-wx301", model: "m", timeoutMs: 1000, maxTokens: 7 })([]);
	assert.equal(result.ok, false);
	assert.equal(result.error, "unparseable judge output (no verdict)");
	assert.equal(result.rawText, "I will not answer");
	assert.equal(result.textChars, "I will not answer".length);
	assert.equal(result.judgeAttempts, undefined);
});

test("chain: redacts credentials in the preserved raw output", async () => {
	const llm = makeLlm({ "cpa-wx301/m": { text: "Authorization: Bearer sk-abcdefghijklmnop" } });
	const result = await makeLlmRunner(llm, { provider: "cpa-wx301", model: "m", timeoutMs: 1000, maxTokens: 7 })([]);
	assert.equal(result.ok, false);
	assert.doesNotMatch(result.rawText, /sk-abcdefghijklmnop/);
	assert.match(result.rawText, /\[REDACTED\]/);
});

test("judgeWith: an empty primary reply still yields the fallback verdict, never ai-error", async () => {
	const llm = makeLlm({
		"cpa-wx301/command/deepseek/deepseek-v4.1-flash": { text: "" },
		"deepseek-official/deepseek-flash": { text: VERDICT }
	});
	const runner = makeLlmRunner(llm, {
		provider: "cpa-wx301",
		model: "command/deepseek/deepseek-v4.1-flash",
		fallbacks: [{ provider: "deepseek-official", model: "deepseek-flash" }],
		timeoutMs: 1000,
		maxTokens: 7
	});
	const result = await judgeWith({ runner, input: { toolName: "bash", argsText: "ls", reason: "" } });
	assert.equal(result.ok, true);
	assert.equal(result.error, undefined);
	assert.deepEqual(result.verdict, { risk: "low", authorization: "allow", reason: "read-only" });
	assert.equal(result.judgeModel, "deepseek-official/deepseek-flash");
	assert.equal(result.judgeFallbackFrom, "cpa-wx301/command/deepseek/deepseek-v4.1-flash");
	assert.equal(result.judgeAttempts, 2);
});

test("judgeWith: every candidate empty fails with the empty-reply reason and every candidate listed", async () => {
	const llm = makeLlm({ "cpa-wx301/m": { text: "" }, "p2/m2": { text: "" } });
	const runner = makeLlmRunner(llm, {
		provider: "cpa-wx301",
		model: "m",
		fallbacks: [{ provider: "p2", model: "m2" }],
		timeoutMs: 1000,
		maxTokens: 7
	});
	const result = await judgeWith({ runner, input: { toolName: "bash", argsText: "ls", reason: "" } });
	assert.equal(result.ok, false);
	assert.equal(result.error, "unparseable judge output (empty reply)");
	assert.equal(result.rawText, "");
	assert.equal(result.textChars, 0);
	assert.equal(result.judgeAttempts, 2);
	assert.deepEqual(result.judgeTried, ["cpa-wx301/m", "p2/m2"]);
});
