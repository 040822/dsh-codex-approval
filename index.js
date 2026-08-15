/**
 * dsh-codex-approval — index.js
 *
 * Codex-style approval autopilot for DeepSeek Harness. Registers an
 * `approval/request` answerer (waterfall listener) that decides each request:
 *
 *   1. enrich — recover the full tool arguments by callId from the session log
 *   2. rules   — ordered glob rules with safety-first priority deny > ask > allow
 *   3. AI judge — LLM verdict {risk, authorization} mapped through riskTolerance
 *   4. fallback — delegate to the next answerer (the human GUI prompt)
 *
 * Returning an outcome ("allowed-once"/"rejected") claims the request;
 * calling next() delegates. The approval service owns the audit pair
 * (approval/asked + approval/decided), this plugin only adds its own
 * decision log file.
 *
 * Safety properties:
 * - deny rules are always evaluated first and can never be overridden.
 * - AI errors/timeouts fail open to the configured failOpen (default ask).
 * - The AI output is only ever mapped onto the three outcomes — no injection.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

import { evaluateRules } from "./rules.js";
import { findToolCallArgs, argsPreview } from "./enrich.js";
import { judgeWith, decideAuthorization } from "./judge.js";

export const name = "dsh-codex-approval";

/**
 * Declarative dependency on the approval service. Cordis loads plugin entries
 * in parallel, so a runtime `ctx.get("approval")` check at apply time could
 * observe the service before it registers and silently no-op the plugin;
 * `inject` guarantees the service is ready before apply runs (fails loud at
 * load when the composition has no approval service).
 */
export const inject = ["approval", "llm"];

/** Default configuration — tune via the profile patch id-targeted config. */
export const DEFAULT_CONFIG = {
	enabled: true,
	rules: [
		// read-only / harmless commands: auto-approve
		{ match: "Bash(git status*)", action: "allow" },
		{ match: "Bash(git diff*)", action: "allow" },
		{ match: "Bash(git log*)", action: "allow" },
		{ match: "Bash(ls *)", action: "allow" },
		{ match: "Bash(cat *)", action: "allow" },
		{ match: "Bash(pwd)", action: "allow" },
		{ match: "Bash(which *)", action: "allow" },
		{ match: "Bash(echo *)", action: "allow" },
		// destructive: always deny, never ask, never judged by AI
		{ match: "Bash(rm -rf /*)", action: "deny" },
		{ match: "Bash(rm -rf ~*)", action: "deny" },
		{ match: "Bash(sudo rm*)", action: "deny" },
		{ match: "Bash(shutdown*)", action: "deny" },
		{ match: "Bash(reboot)", action: "deny" },
		{ match: "Bash(mkfs*)", action: "deny" },
		// sensitive: always ask a human
		{ match: "reason:*secret*", action: "ask" },
		{ match: "reason:*password*", action: "ask" },
		{ match: "reason:*credential*", action: "ask" },
		{ match: "reason:*token*", action: "ask" }
	],
	ai: {
		enabled: true,
		provider: "opencode-go",
		model: "deepseek-v4-flash",
		riskTolerance: "medium",
		maxPromptChars: 2000,
		timeoutMs: 15000,
		maxTokens: 512,
		failOpen: "ask"
	},
	fallback: "ask",
	logFile: join(homedir(), ".dsh", "logs", "approval.jsonl")
};

const ACTIONS = ["allow", "ask", "deny"];
const TOLERANCES = ["low", "medium", "high"];

function assertConfig(cfg) {
	if (typeof cfg !== "object" || cfg === null) throw new TypeError("dsh-codex-approval: config must be an object");
	if (typeof cfg.enabled !== "boolean") throw new TypeError("dsh-codex-approval: config.enabled must be a boolean");
	if (!Array.isArray(cfg.rules)) throw new TypeError("dsh-codex-approval: config.rules must be an array");
	for (const rule of cfg.rules) {
		if (typeof rule.match !== "string" || rule.match === "") throw new TypeError("dsh-codex-approval: each rule needs a non-empty match");
		if (!ACTIONS.includes(rule.action)) throw new TypeError(`dsh-codex-approval: rule action must be one of ${ACTIONS.join("/")}`);
	}
	if (typeof cfg.ai !== "object" || cfg.ai === null) throw new TypeError("dsh-codex-approval: config.ai must be an object");
	if (typeof cfg.ai.enabled !== "boolean") throw new TypeError("dsh-codex-approval: config.ai.enabled must be a boolean");
	if (!TOLERANCES.includes(cfg.ai.riskTolerance)) throw new TypeError(`dsh-codex-approval: config.ai.riskTolerance must be one of ${TOLERANCES.join("/")}`);
	if (!ACTIONS.includes(cfg.ai.failOpen)) throw new TypeError("dsh-codex-approval: config.ai.failOpen must be allow/ask/deny");
	if (!ACTIONS.includes(cfg.fallback)) throw new TypeError("dsh-codex-approval: config.fallback must be allow/ask/deny");
	if (typeof cfg.logFile !== "string" || cfg.logFile === "") throw new TypeError("dsh-codex-approval: config.logFile must be a non-empty path");
}

/** Deep-merge user config over defaults (ai sub-object merged). */
export function normalizeConfig(userConfig) {
	const cfg = {
		...DEFAULT_CONFIG,
		...(userConfig ?? {}),
		ai: { ...DEFAULT_CONFIG.ai, ...(userConfig?.ai ?? {}) },
		rules: Array.isArray(userConfig?.rules) && userConfig.rules.length > 0 ? userConfig.rules : DEFAULT_CONFIG.rules
	};
	assertConfig(cfg);
	return cfg;
}

function outcomeFor(action) {
	if (action === "allow") return "allowed-once";
	if (action === "deny") return "rejected";
	return "pass";
}

/** The real LLM runner: ctx.llm.prepareCall + stream, bounded by timeout. */
export function makeLlmRunner(llm, { provider, model, timeoutMs, maxTokens }) {
	return async (messages, { signal } = {}) => {
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const combined = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		try {
			const prepared = await llm.prepareCall({ provider, model, temperature: 0, maxTokens }, combined);
			let text = "";
			for await (const chunk of prepared.stream({ ...prepared.config, messages })) {
				if (chunk.type === "text-delta") text += chunk.text;
				else if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
					return { ok: false, error: `judge stream finished with ${chunk.reason.kind}` };
				}
			}
			return { ok: true, text };
		} catch (error) {
			return { ok: false, error: String(error?.message ?? error) };
		}
	};
}

/**
 * Create the approval/request handler with injected dependencies
 * (unit-testable without a cordis ctx).
 * @param deps - { config, record, llmRunner }
 * @returns async (req, next) => ApprovalOutcome
 */
export function createHandler({ config, record, llmRunner }) {
	const cfg = config;
	return async (req, next) => {
		const started = Date.now();
		if (req.signal?.aborted === true) return "cancelled";
		if (!cfg.enabled) return next();

		const args = findToolCallArgs(req.agent?.session?.events, req.callId);
		const argsText = argsPreview(args, req.toolName, cfg.ai.maxPromptChars);
		const matchReq = { toolName: req.toolName, argsText, reason: req.reason ?? "" };

		let verdict;
		const rule = evaluateRules(cfg.rules, matchReq);
		if (rule !== null) {
			verdict = { kind: "rule", action: rule.action, outcome: outcomeFor(rule.action), match: rule.match };
		} else if (cfg.ai.enabled) {
			const judged = await judgeWith({
				runner: llmRunner,
				input: { toolName: req.toolName, argsText, reason: req.reason ?? "" }
			});
			if (judged.ok) {
				const authorization = decideAuthorization(judged.verdict, cfg.ai.riskTolerance);
				verdict = {
					kind: "ai",
					action: authorization,
					outcome: outcomeFor(authorization),
					risk: judged.verdict.risk,
					aiReason: judged.verdict.reason
				};
			} else {
				verdict = {
					kind: "ai-error",
					action: cfg.ai.failOpen,
					outcome: outcomeFor(cfg.ai.failOpen),
					error: judged.error,
					...judged.rawText !== void 0 ? { rawOutput: judged.rawText } : {}
				};
			}
		} else {
			verdict = { kind: "fallback", action: cfg.fallback, outcome: outcomeFor(cfg.fallback) };
		}

		await record({
			ts: new Date().toISOString(),
			sessionId: req.agent?.session?.id ?? req.agent?.id ?? "?",
			toolName: req.toolName,
			callId: req.callId,
			argsPreview: argsText.slice(0, 300),
			reason: (req.reason ?? "").slice(0, 500),
			...verdict,
			ms: Date.now() - started
		});

		return verdict.outcome === "pass" ? next() : verdict.outcome;
	};
}

/** Fire-and-forget JSONL appender (never throws into the approval path). */
export function makeRecorder(logFile) {
	let dirChecked = false;
	return async (entry) => {
		try {
			if (!dirChecked) {
				mkdirSync(dirname(logFile), { recursive: true });
				dirChecked = true;
			}
			await appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf8");
		} catch {
			/* logging must never break an approval decision */
		}
	};
}

/** Cordis plugin entry: register the answerer when approval is composed. */
export async function apply(ctx, userConfig) {
	const cfg = normalizeConfig(userConfig);
	const llmRunner = makeLlmRunner(ctx.llm, cfg.ai);
	const handler = createHandler({ config: cfg, record: makeRecorder(cfg.logFile), llmRunner });
	ctx.on("approval/request", handler);
	// Self-proving startup record: this line in the log after a restart proves
	// the plugin loaded (decision records follow it). Awaited so a boot that
	// cannot even write its own log fails loud instead of silently degrading.
	await makeRecorder(cfg.logFile)({
		ts: new Date().toISOString(),
		event: "plugin-loaded",
		sessionId: "boot",
		rules: cfg.rules.length,
		ai: cfg.ai.enabled,
		tolerance: cfg.ai.riskTolerance,
		fallback: cfg.fallback
	});
	ctx.logger?.info?.("[dsh-codex-approval] answerer registered — rules=%d ai=%s tolerance=%s log=%s",
		cfg.rules.length, cfg.ai.enabled ? "on" : "off", cfg.ai.riskTolerance, cfg.logFile);
}
