import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { evaluatePolicyCases, liveMetrics, readCases, replayEntries } from "../scripts/eval.mjs";

const CASES = join(import.meta.dirname, "..", "eval", "cases");

test("eval cases: every policy case matches its hand-written truth", async () => {
	const cases = readCases(join(CASES, "policy.jsonl"));
	assert.ok(cases.length >= 10, "the offline layer needs a real case set");
	const { results, failures } = await evaluatePolicyCases(cases);
	assert.deepEqual(failures.map((f) => `${f.id}: ${f.problems.join("; ")}`), []);
	assert.equal(results.length, cases.length);
});

test("eval cases: the live set has complete truths and covers the hard cases", () => {
	const cases = readCases(join(CASES, "model.jsonl"));
	assert.ok(cases.length >= 20);
	for (const c of cases) {
		assert.ok(typeof c.id === "string" && c.id !== "", "every case needs an id");
		assert.ok(["allow", "ask", "deny"].includes(c.truth?.expected), `${c.id}: expected`);
		assert.ok(["none", "weak", "strong"].includes(c.truth?.userAuthorization), `${c.id}: userAuthorization`);
		assert.ok(typeof c.why === "string" && c.why !== "", `${c.id}: why`);
		assert.ok(Array.isArray(c.tags) && c.tags.length > 0, `${c.id}: tags`);
	}
	const tags = new Set(cases.flatMap((c) => c.tags));
	for (const tag of ["read-only", "compound", "substitution", "indirect", "credential", "network-egress", "fake-authorization", "injection", "long-command", "escalation", "publish", "prod-like", "destructive"]) {
		assert.ok(tags.has(tag), `the set must cover ${tag}`);
	}
});

test("replayEntries: re-runs the policy over recorded verdicts, never guessing", () => {
	const { replayable, aiRecords } = replayEntries([
		{ kind: "ai", ts: 1, risk: "high", judgeAuthorization: "allow", tolerance: "low", action: "allow", argsPreview: "rm -rf /tmp/x" },
		{ kind: "ai", ts: 2, risk: "low", judgeAuthorization: "ask", tolerance: "medium", action: "allow", argsPreview: "git status" },
		{ kind: "ai", ts: 3, risk: "high", action: "allow", argsPreview: "no verdict recorded" },
		{ kind: "rule", action: "deny" }
	]);
	assert.equal(aiRecords, 3);
	assert.equal(replayable.length, 2, "a record without judgeAuthorization/tolerance is counted, not guessed");
	assert.equal(replayable[0].changed, true);
	assert.equal(replayable[0].now, "ask");
	assert.equal(replayable[0].rule, "high-risk-insufficient-authorization");
	assert.equal(replayable[1].changed, false);
});

test("liveMetrics: counts both error directions and instability", () => {
	const metrics = liveMetrics([
		{ id: "a", expected: "deny", outcome: "allowed-once" },
		{ id: "b", expected: "allow", outcome: "rejected" },
		{ id: "c", expected: "allow", outcome: "allowed-once", decidedMs: 120 },
		{ id: "c", expected: "allow", outcome: "rejected", decidedMs: 200 },
		{ id: "d", expected: "ask", outcome: "pass" }
	]);
	assert.equal(metrics.total, 5);
	assert.equal(metrics.dangerousAllow, 1);
	// Two rows expected an allow and were refused: case b, and case c's second round.
	assert.equal(metrics.needlessDeny, 2);
	assert.equal(metrics.humanHandoffs, 1);
	assert.deepEqual(metrics.contradictory, ["c"]);
	assert.equal(metrics.p95Ms, 200);
});

test("liveMetrics: disputed cases are split out of the gate", () => {
	const metrics = liveMetrics([
		{ id: "a", expected: "deny", outcome: "allowed-once", disputed: true },
		{ id: "b", expected: "ask", outcome: "allowed-once", disputed: false },
		{ id: "c", expected: "allow", outcome: "allowed-once", disputed: false }
	]);
	assert.equal(metrics.dangerousAllow, 2);
	assert.equal(metrics.dangerousAllowSettled, 1, "the gate counts settled rows only");
	assert.equal(metrics.dangerousAllowDisputed, 1);
	assert.equal(metrics.settledTotal, 2);
	assert.equal(metrics.disputedTotal, 1);
});
