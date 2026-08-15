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
import z from "@deepseek-ai/schemastery";

import { evaluateRules } from "./rules.js";
import { findToolCallArgs, argsPreview } from "./enrich.js";
import { judgeWith, decideAuthorization } from "./judge.js";
import { MODES, parseMode, resolveMode, effectiveOnAsk } from "./modes.js";

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
	mode: "ai",
	mode3OnAsk: "deny",
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
	if (!MODES.includes(cfg.mode)) throw new TypeError(`dsh-codex-approval: config.mode must be one of ${MODES.join("/")}`);
	if (!["deny", "allow"].includes(cfg.mode3OnAsk)) throw new TypeError("dsh-codex-approval: config.mode3OnAsk must be deny/allow");
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
 * @param deps - { config, record, llmRunner, getSessionMode }
 * @returns async (req, next) => ApprovalOutcome
 */
export function createHandler({ config, record, llmRunner, getSessionMode }) {
	const cfg = config;
	return async (req, next) => {
		const started = Date.now();
		if (req.signal?.aborted === true) return "cancelled";
		if (!cfg.enabled) return next();

		const sessionId = req.agent?.session?.id ?? req.agent?.id;
		const override = await getSessionMode?.(sessionId);
		const mode = resolveMode(override, cfg.mode);

		// mode 1: fully bypassed — the pre-plugin experience (no decision, no audit)
		if (mode === "manual") return next();

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
				input: { toolName: req.toolName, argsText, reason: req.reason ?? "" },
				allowAsk: mode !== "ai-auto"
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

		// mode 3 (ai-auto): an "ask" is never routed to a human — resolve it
		// through mode3OnAsk (default deny), regardless of its source
		// (rule ask, AI ask over tolerance, failOpen=ask, fallback=ask).
		if (mode === "ai-auto" && verdict.action === "ask") {
			const resolved = effectiveOnAsk(mode, cfg.mode3OnAsk);
			verdict = { ...verdict, action: resolved, outcome: outcomeFor(resolved), viaAskResolution: true };
		}

		await record({
			ts: new Date().toISOString(),
			sessionId: sessionId ?? "?",
			mode,
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

/**
 * Per-session approval-mode store. Persists through the dsh settings service
 * under the `dsh-codex-approval` namespace when available; falls back to
 * memory only (survives nothing) otherwise. All writes go through `replace`
 * so the whole `sessionOverrides` map stays authoritative in one place.
 */
export function makeModeStore(ctx, logger) {
	const memory = new Map();
	let settings = null;
	ctx.inject(["settings"], (sctx) => {
		settings = sctx.settings;
		try {
			sctx.settings.register("dsh-codex-approval", z.object({
				sessionOverrides: z.record(z.string(), z.enum(MODES)).default({})
			}), { base: {} });
			const resolved = sctx.settings.get("dsh-codex-approval");
			const overrides = resolved?.sessionOverrides;
			if (overrides !== null && typeof overrides === "object") {
				for (const [key, value] of Object.entries(overrides)) memory.set(key, value);
			}
		} catch (error) {
			logger?.warn?.("[dsh-codex-approval] settings init failed (%s) — session overrides are memory-only", String(error?.message ?? error));
		}
	});
	const persist = async () => {
		if (settings === null) return "memory-only";
		try {
			const next = {};
			for (const [key, value] of memory) next[key] = value;
			await settings.replace("dsh-codex-approval", { sessionOverrides: next });
			return "persisted";
		} catch {
			return "memory-only";
		}
	};
	return {
		async get(sessionId) {
			if (sessionId === undefined || sessionId === null) return undefined;
			return memory.get(sessionId);
		},
		async set(sessionId, mode) {
			if (sessionId === undefined || sessionId === null) return "memory-only";
			memory.set(sessionId, mode);
			return persist();
		},
		async clear(sessionId) {
			if (sessionId !== undefined && sessionId !== null) memory.delete(sessionId);
			return persist();
		}
	};
}

/** Register the /approval-mode command (mirrors dsh-plan-mode's /plan). */
export function registerModeCommand(ctx, cfg, store) {
	ctx.inject(["commands"], (commandCtx) => {
		commandCtx.commands.register({
			name: "approval-mode",
			description: "Show or switch the approval mode (manual | ai | ai-auto, or 1/2/3)",
			input: { hint: "[manual|ai|ai-auto|default]" },
			handler: async ({ agent, rawInput }) => {
				const sessionId = agent?.session?.id ?? agent?.id;
				const input = rawInput.trim();
				if (input === "") {
					const override = await store.get(sessionId);
					const effective = resolveMode(override, cfg.mode);
					const base = override === void 0
						? `approval mode: ${effective} (config default: ${cfg.mode}, no session override)`
						: `approval mode: ${effective} (session override: ${override}, config default: ${cfg.mode})`;
					return { kind: "success", text: base };
				}
				if (input === "default" || input === "off" || input === "reset") {
					const persisted = await store.clear(sessionId);
					const note = persisted === "persisted" ? "" : " (memory-only: settings unavailable)";
					return { kind: "success", text: `approval mode: session override cleared — effective ${cfg.mode} (config default)${note}` };
				}
				const mode = parseMode(input);
				if (mode === null) {
					return { kind: "success", text: `unknown approval mode "${input}" — use manual | ai | ai-auto (or 1/2/3), or "default" to clear the override` };
				}
				const persisted = await store.set(sessionId, mode);
				const note = persisted === "persisted" ? "" : " (memory-only: settings unavailable, lost on restart)";
				return { kind: "success", text: `approval mode → ${mode} for this session${note}` };
			}
		});
	});
}

/** Cordis plugin entry: register the answerer when approval is composed. */
export async function apply(ctx, userConfig) {
	const cfg = normalizeConfig(userConfig);
	const store = makeModeStore(ctx, ctx.logger);
	const llmRunner = makeLlmRunner(ctx.llm, cfg.ai);
	const handler = createHandler({
		config: cfg,
		record: makeRecorder(cfg.logFile),
		llmRunner,
		getSessionMode: (sessionId) => store.get(sessionId)
	});
	ctx.on("approval/request", handler);
	registerModeCommand(ctx, cfg, store);
	// Self-proving startup record: this line in the log after a restart proves
	// the plugin loaded (decision records follow it). Awaited so a boot that
	// cannot even write its own log fails loud instead of silently degrading.
	await makeRecorder(cfg.logFile)({
		ts: new Date().toISOString(),
		event: "plugin-loaded",
		sessionId: "boot",
		mode: cfg.mode,
		mode3OnAsk: cfg.mode3OnAsk,
		rules: cfg.rules.length,
		ai: cfg.ai.enabled,
		tolerance: cfg.ai.riskTolerance,
		fallback: cfg.fallback
	});
	ctx.logger?.info?.("[dsh-codex-approval] answerer registered — mode=%s rules=%d ai=%s tolerance=%s log=%s",
		cfg.mode, cfg.rules.length, cfg.ai.enabled ? "on" : "off", cfg.ai.riskTolerance, cfg.logFile);
}
