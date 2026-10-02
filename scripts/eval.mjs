#!/usr/bin/env node
/**
 * dsh-codex-approval — eval harness.
 *
 * Three ways to ask "is this plugin still making the right calls?":
 *
 *   --policy              Offline, deterministic, free. Feeds each case in
 *                         `eval/cases/policy.jsonl` through the REAL handler
 *                         (rules → evidence gate → gates → policy layer) with a
 *                         stub judge, and compares the outcome and the policy
 *                         branch against the case's truth. This is the layer
 *                         that belongs in CI.
 *   --replay <audit.jsonl> Re-runs today's policy over judge verdicts recorded
 *                         in a real audit log and lists every decision that
 *                         would change. Only records written with
 *                         `judgeAuthorization` + `tolerance` can be replayed
 *                         exactly; older ones are counted, not guessed.
 *   --live                Runs `eval/cases/model.jsonl` against a real model
 *                         (OpenAI-compatible endpoint via EVAL_BASE_URL /
 *                         EVAL_API_KEY / EVAL_MODEL) and reports the dangerous
 *                         allow rate, the unnecessary deny rate, latency and
 *                         tokenless cost proxies. Costs money; never in CI.
 *
 * Reports land in `eval/reports/<date>-<mode>.md`.
 *
 * The case files are data, not code: adding a case is a one-line diff, and the
 * truth column is written by hand (`why` explains it) — never by another model,
 * which would only prove two models agree.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildJudgeMessages, decidePolicy, parseVerdict } from "../judge.js";
import { createHandler, normalizeConfig } from "../index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CALL_ID = "eval-call";
const SESSION_ID = "eval-session";

/** Read a JSONL case file (blank lines and `//` comments ignored). */
export function readCases(file) {
	return readFileSync(file, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("//"))
		.map((line) => JSON.parse(line));
}

/** Build the approval request + session events a case describes. */
export function requestForCase(c) {
	const toolName = c.tool ?? "bash";
	const args = c.args ?? { command: "echo hi" };
	const events = [{
		type: "assistant/message",
		data: { message: { content: [{ type: "tool-call", id: CALL_ID, name: toolName, arguments: JSON.stringify(args) }] } }
	}];
	return {
		toolName,
		callId: CALL_ID,
		reason: c.reason ?? "",
		agent: { id: "eval-agent", session: { id: SESSION_ID, snapshotEvents: () => events } }
	};
}

/** Config a case asks for: mode / tolerance / rules / extra ai keys. */
export function configForCase(c) {
	return normalizeConfig({
		mode: c.mode ?? "ai",
		...(c.mode3OnAsk === undefined ? {} : { mode3OnAsk: c.mode3OnAsk }),
		rules: c.rules ?? [],
		ai: {
			enabled: true,
			evidenceFetch: "off",
			riskTolerance: c.tolerance ?? "medium",
			...(c.ai ?? {})
		},
		...(c.config ?? {})
	});
}

/**
 * The `next()` downstream answerer: returning the literal "pass" keeps the
 * harness's outcome vocabulary identical to the plugin's own (`pass` = the
 * request is handed to the human / the next answerer).
 */

/** A judge runner that answers with the case's recorded verdict. */
function stubRunner(c) {
	return async () => {
		if (c.judge !== undefined && c.judge.error !== undefined) return { ok: false, error: c.judge.error };
		const verdict = c.judge ?? { risk: "low", authorization: "allow" };
		return {
			ok: true,
			text: JSON.stringify({
				risk: verdict.risk,
				authorization: verdict.authorization,
				...(verdict.user_authorization === undefined ? {} : { user_authorization: verdict.user_authorization }),
				reason: verdict.reason ?? "eval"
			})
		};
	};
}

/** Run one policy case through the real handler. */
export async function evaluatePolicyCase(c) {
	const records = [];
	const handler = createHandler({
		config: configForCase(c),
		record: async (entry) => { records.push(entry); },
		llmRunner: stubRunner(c),
		getCwd: () => c.cwd ?? "/ws",
		resolvePath: async (path) => path,
		readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }
	});
	const outcome = await handler(requestForCase(c), async () => "pass");
	const entry = records.at(-1) ?? {};
	const problems = [];
	if (outcome !== c.expected) problems.push(`outcome ${outcome} ≠ expected ${c.expected}`);
	if (c.rule !== undefined && c.rule !== null && entry.policy !== c.rule) problems.push(`policy ${entry.policy} ≠ expected ${c.rule}`);
	return { id: c.id, outcome, policy: entry.policy, expected: c.expected, tags: c.tags ?? [], why: c.why, problems };
}

/** Evaluate every policy case; returns results plus the failures. */
export async function evaluatePolicyCases(cases) {
	const results = [];
	for (const c of cases) results.push(await evaluatePolicyCase(c));
	return { results, failures: results.filter((r) => r.problems.length > 0) };
}

/**
 * Re-run the current policy over verdicts recorded in a real audit log.
 *
 * A record is exactly replayable only when it carries the judge's own opinion
 * (`judgeAuthorization`) and the tolerance in force at the time — both were
 * added for this purpose. Older `kind: "ai"` records are counted separately and
 * never guessed at: their `action` is the *result* of the old policy, not its
 * input.
 */
export function replayEntries(entries) {
	const replayable = [];
	let aiRecords = 0;
	for (const entry of entries) {
		if (entry === null || typeof entry !== "object") continue;
		if (entry.kind !== "ai") continue;
		aiRecords += 1;
		if (typeof entry.judgeAuthorization !== "string" || typeof entry.risk !== "string" || typeof entry.tolerance !== "string") continue;
		const decision = decidePolicy(
			{ risk: entry.risk, authorization: entry.judgeAuthorization, ...entry.userAuthorization === undefined ? {} : { userAuthorization: entry.userAuthorization } },
			{ tolerance: entry.tolerance }
		);
		replayable.push({
			ts: entry.ts,
			argsPreview: entry.argsPreview,
			risk: entry.risk,
			judgeAuthorization: entry.judgeAuthorization,
			userAuthorization: entry.userAuthorization,
			tolerance: entry.tolerance,
			was: entry.action,
			now: decision.action,
			rule: decision.rule,
			changed: entry.action !== decision.action
		});
	}
	return { replayable, aiRecords };
}

/** Metrics over one live run: the numbers that decide whether a change helped. */
export function liveMetrics(rows) {
	const dangerousAllow = rows.filter((r) => (r.expected === "deny" || r.expected === "ask") && r.outcome === "allowed-once");
	const needlessDeny = rows.filter((r) => r.expected === "allow" && r.outcome === "rejected");
	const unstable = new Map();
	for (const row of rows) {
		const key = row.id;
		const seen = unstable.get(key) ?? new Set();
		seen.add(row.outcome);
		unstable.set(key, seen);
	}
	const contradictory = [...unstable.entries()].filter(([, set]) => set.size > 1).map(([id]) => id);
	const decided = rows.filter((r) => r.decidedMs !== undefined).map((r) => r.decidedMs).sort((a, b) => a - b);
	const p95 = decided.length === 0 ? undefined : decided[Math.min(decided.length - 1, Math.ceil(decided.length * 0.95) - 1)];
	return {
		total: rows.length,
		dangerousAllow: dangerousAllow.length,
		dangerousAllowRate: rows.length === 0 ? 0 : dangerousAllow.length / rows.length,
		needlessDeny: needlessDeny.length,
		needlessDenyRate: rows.length === 0 ? 0 : needlessDeny.length / rows.length,
		humanHandoffs: rows.filter((r) => r.outcome === "pass").length,
		p95Ms: p95,
		contradictory
	};
}

/** Markdown report: the artifact a change is judged by. */
export function renderReport({ mode, meta, lines, table }) {
	const head = [`# dsh-codex-approval eval — ${mode}`, "", `- 生成时间：${new Date().toISOString()}`, ...meta.map((m) => `- ${m}`), ""];
	return [...head, ...lines, "", ...table, ""].join("\n");
}

function writeReport(mode, text) {
	const dir = join(ROOT, "eval", "reports");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${new Date().toISOString().slice(0, 10)}-${mode}.md`);
	writeFileSync(file, text);
	return file;
}

/** One live judge call against an OpenAI-compatible endpoint. */
async function callModel({ base, key, model, toolName, argsText, reason }, timeoutMs = 30_000) {
	const messages = buildJudgeMessages({ toolName, argsText, reason, cwd: "/ws" });
	const started = Date.now();
	const response = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
		body: JSON.stringify({
			model,
			temperature: 0,
			messages: messages.map((message) => ({ role: message.role, content: message.content.map((part) => part.text).join("") }))
		}),
		signal: AbortSignal.timeout(timeoutMs)
	});
	const body = await response.json().catch(() => null);
	const text = body?.choices?.[0]?.message?.content ?? "";
	return { text, decidedMs: Date.now() - started, usage: body?.usage };
}

async function runLive({ base, key, model, repeat }) {
	const cases = readCases(join(ROOT, "eval", "cases", "model.jsonl"));
	const rows = [];
	for (const c of cases) {
		const toolName = c.tool ?? "bash";
		const argsText = (c.args ?? {}).command ?? JSON.stringify(c.args ?? {});
		for (let round = 0; round < repeat; round += 1) {
			let outcome = "judge-error";
			let decidedMs;
			let verdict;
			try {
				const answer = await callModel({ base, key, model, toolName, argsText, reason: c.reason ?? "" });
				decidedMs = answer.decidedMs;
				verdict = parseVerdict(answer.text);
				if (verdict !== null) {
					const handler = createHandler({
						config: configForCase({ ...c, mode: c.mode ?? "ai" }),
						record: async () => {},
						llmRunner: async () => ({ ok: true, text: JSON.stringify({ risk: verdict.risk, authorization: verdict.authorization, ...verdict.userAuthorization === undefined ? {} : { user_authorization: verdict.userAuthorization }, reason: verdict.reason }) })
					});
					outcome = await handler(requestForCase(c), async () => "pass");
				}
			} catch (error) {
				verdict = undefined;
				outcome = `error:${String(error?.message ?? error).slice(0, 60)}`;
			}
			rows.push({
				id: c.id,
				round,
				tags: c.tags ?? [],
				expected: c.truth?.expected,
				truthAuthorization: c.truth?.userAuthorization,
				risk: verdict?.risk,
				judgeAuthorization: verdict?.authorization,
				userAuthorization: verdict?.userAuthorization,
				outcome,
				decidedMs
			});
		}
	}
	const metrics = liveMetrics(rows);
	const table = [
		"| 指标 | 值 |",
		"|---|---|",
		`| 案例×重复 | ${metrics.total} |`,
		`| 危险放行（该 ask/deny 却放行） | ${metrics.dangerousAllow}（${(metrics.dangerousAllowRate * 100).toFixed(1)}%） |`,
		`| 误拒（该放行却拒绝） | ${metrics.needlessDeny}（${(metrics.needlessDenyRate * 100).toFixed(1)}%） |`,
		`| 交人工 | ${metrics.humanHandoffs} |`,
		`| p95 判定耗时 | ${metrics.p95Ms ?? "n/a"} ms |`,
		`| 同案例结论不一致 | ${metrics.contradictory.length === 0 ? "无" : metrics.contradictory.join(", ")} |`
	];
	const details = rows.map((r) => `| ${r.id} | ${r.round} | ${r.risk ?? "-"} | ${r.judgeAuthorization ?? "-"} | ${r.userAuthorization ?? "-"} | ${r.outcome} | ${r.expected} |`);
	const text = renderReport({
		mode: "live",
		meta: [`模型：${model}`, `端点：${base}`, `重复：${repeat}`, "真值来自 eval/cases/model.jsonl（人工标注）"],
		lines: ["## 汇总", "", ...table, "", "## 逐条", "", "| 案例 | 轮次 | risk | judge 意见 | 用户授权 | 结果 | 真值 |", "|---|---|---|---|---|---|---|", ...details],
		table: []
	});
	return { rows, metrics, file: writeReport("live", text) };
}

async function main() {
	const argv = process.argv.slice(2);
	const flag = (name) => argv.includes(name);
	const value = (name, fallback) => {
		const index = argv.indexOf(name);
		const next = index === -1 ? undefined : argv[index + 1];
		return next === undefined || next.startsWith("--") ? fallback : next;
	};

	if (flag("--policy")) {
		const cases = readCases(join(ROOT, "eval", "cases", "policy.jsonl"));
		const { results, failures } = await evaluatePolicyCases(cases);
		const rows = results.map((r) => `| ${r.id} | ${r.outcome} | ${r.policy ?? "-"} | ${r.expected} | ${r.problems.length === 0 ? "✅" : `❌ ${r.problems.join("; ")}`} |`);
		const text = renderReport({
			mode: "policy",
			meta: [`案例数：${results.length}`, `失败：${failures.length}`, "零成本、确定性；CI 用这一层"],
			lines: ["## 逐条", "", "| 案例 | 结果 | 命中分支 | 真值 | 判定 |", "|---|---|---|---|---|", ...rows],
			table: []
		});
		const file = writeReport("policy", text);
		console.log(`policy: ${results.length - failures.length}/${results.length} 通过 → ${file}`);
		for (const f of failures) console.log(`  ✖ ${f.id}: ${f.problems.join("; ")}`);
		process.exitCode = failures.length === 0 ? 0 : 1;
		return;
	}

	if (flag("--replay")) {
		const file = value("--replay", join(process.env.HOME ?? "", ".dsh", "logs", "approval.jsonl"));
		const entries = readCases(file);
		const { replayable, aiRecords } = replayEntries(entries);
		const changed = replayable.filter((r) => r.changed);
		const rows = changed.map((r) => `| ${r.ts ?? "-"} | ${(r.argsPreview ?? "").slice(0, 60).replace(/\|/g, "\\|")} | ${r.risk} | ${r.judgeAuthorization} | ${r.userAuthorization ?? "-"} | ${r.tolerance} | ${r.was} | ${r.now} | ${r.rule} |`);
		const text = renderReport({
			mode: "replay",
			meta: [
				`日志：${file}`,
				`ai 记录：${aiRecords}`,
				`可精确回放：${replayable.length}（需要 judgeAuthorization + tolerance，v0.5.0 起写入）`,
				`落点改变：${changed.length}`
			],
			lines: ["## 会改变的判定", "", "| 时间 | 命令 | risk | judge 意见 | 用户授权 | 容忍度 | 原动作 | 现动作 | 现分支 |", "|---|---|---|---|---|---|---|---|---|", ...rows],
			table: []
		});
		const out = writeReport("replay", text);
		console.log(`replay: ${replayable.length}/${aiRecords} 条可回放，${changed.length} 条落点改变 → ${out}`);
		return;
	}

	if (flag("--live")) {
		const base = process.env.EVAL_BASE_URL;
		const key = process.env.EVAL_API_KEY;
		const model = value("--model", process.env.EVAL_MODEL);
		const repeat = Number.parseInt(value("--repeat", "1"), 10) || 1;
		if (base === undefined || key === undefined || model === undefined) {
			console.error("--live 需要 EVAL_BASE_URL / EVAL_API_KEY / EVAL_MODEL（或 --model），并会产生真实调用费用。");
			process.exitCode = 2;
			return;
		}
		const { metrics, file } = await runLive({ base, key, model, repeat });
		console.log(`live: 危险放行 ${metrics.dangerousAllow}/${metrics.total}，误拒 ${metrics.needlessDeny}/${metrics.total} → ${file}`);
		return;
	}

	console.log(`用法：
  node scripts/eval.mjs --policy                              离线策略回归（免费，CI 用）
  node scripts/eval.mjs --replay [~/.dsh/logs/approval.jsonl] 用真实判定记录回放当前策略
  node scripts/eval.mjs --live --model <id> [--repeat N]      真实模型评测（需 EVAL_BASE_URL / EVAL_API_KEY）`);
}

// Only run the CLI when this file IS the command; importing it (tests, other
// tools) must not parse argv or write reports.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
