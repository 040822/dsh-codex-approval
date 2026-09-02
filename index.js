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
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import z from "@deepseek-ai/schemastery";

import { evaluateRules } from "./rules.js";
import { findToolCallArgs, argsPreview } from "./enrich.js";
import { judgeWith, decideAuthorization } from "./judge.js";
import { MODES, parseMode, resolveMode, effectiveOnAsk } from "./modes.js";
import { T, pickLocale, commandDescription, renderDenialNotice } from "./i18n.js";

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
	locale: "auto",
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
		{ match: "reason:*token*", action: "ask" },
		// publishing: never auto-decided — a human must confirm every publish
		// (both bare `npm publish` and prefixed forms like `cd x && npm publish`)
		{ match: "Bash(npm publish*)", action: "ask" },
		{ match: "Bash(*npm publish*)", action: "ask" }
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
	// Rejection-attribution feedback: after the plugin denies an escalation,
	// inject a corrective user-role (plugin-source) message into the next
	// model request via the `agent/pre-step` hook, so the main agent learns
	// the denial came from the automatic reviewer (with rationale) and not
	// from the user — the sandbox layer hard-codes "the user rejected".
	denyFeedback: true,
	// Pending-denial queue cap per session: older entries are dropped first.
	denyFeedbackMax: 3,
	logFile: join(homedir(), ".dsh", "logs", "approval.jsonl")
};

const ACTIONS = ["allow", "ask", "deny"];
const TOLERANCES = ["low", "medium", "high"];

function assertConfig(cfg) {
	if (typeof cfg !== "object" || cfg === null) throw new TypeError("dsh-codex-approval: config must be an object");
	if (typeof cfg.enabled !== "boolean") throw new TypeError("dsh-codex-approval: config.enabled must be a boolean");
	if (!MODES.includes(cfg.mode)) throw new TypeError(`dsh-codex-approval: config.mode must be one of ${MODES.join("/")}`);
	if (!["deny", "allow"].includes(cfg.mode3OnAsk)) throw new TypeError("dsh-codex-approval: config.mode3OnAsk must be deny/allow");
	if (!["auto", "zh", "en"].includes(cfg.locale)) throw new TypeError("dsh-codex-approval: config.locale must be auto/zh/en");
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
	if (typeof cfg.denyFeedback !== "boolean") throw new TypeError("dsh-codex-approval: config.denyFeedback must be a boolean");
	if (!Number.isSafeInteger(cfg.denyFeedbackMax) || cfg.denyFeedbackMax < 1 || cfg.denyFeedbackMax > 10) {
		throw new TypeError("dsh-codex-approval: config.denyFeedbackMax must be an integer in 1..10");
	}
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
 * @param deps - { config, record, llmRunner, getSessionMode, denialFeed }
 *   `denialFeed` is an optional Map<sessionId, Array<DenialRecord>> used to
 *   stage plugin-originated denials for the `agent/pre-step` injector; when
 *   omitted the handler creates its own (shared only if the caller passes it).
 * @returns async (req, next) => ApprovalOutcome
 */
export function createHandler({ config, record, llmRunner, getSessionMode, denialFeed }) {
	const cfg = config;
	const feed = denialFeed ?? new Map();
	const stageDenial = (sessionId, denial) => {
		if (sessionId === undefined || sessionId === null) return;
		const queue = feed.get(sessionId) ?? [];
		queue.push(denial);
		if (queue.length > cfg.denyFeedbackMax) queue.shift();
		feed.set(sessionId, queue);
	};
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

		// Stage plugin-originated denials for the pre-step feedback injector.
		// Only denials the plugin itself produced are staged (rule / ai /
		// ai-error-failOpen / fallback, incl. ai-auto's mode3 ask-resolution),
		// so a human denial through the GUI answerer never gets re-attributed.
		if (verdict.outcome === "rejected" && cfg.denyFeedback) {
			stageDenial(sessionId, {
				command: argsText.slice(0, 200),
				source: verdict.kind,
				...verdict.match !== void 0 ? { match: verdict.match } : {},
				...verdict.risk !== void 0 ? { risk: verdict.risk } : {},
				...typeof verdict.aiReason === "string" && verdict.aiReason !== "" ? { aiReason: verdict.aiReason } : {},
				...verdict.viaAskResolution === true ? { viaAsk: true } : {},
				ts: Date.now()
			});
		}

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
				sessionOverrides: z.dict(z.union(MODES)).default({})
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
export function registerModeCommand(ctx, cfg, store, getLocale) {
	const locale = getLocale ? getLocale() : "en";
	ctx.inject(["commands"], (commandCtx) => {
		commandCtx.commands.register({
			name: "approval-mode",
			description: commandDescription(locale),
			input: { hint: "[manual|ai|ai-auto|default]" },
			handler: async ({ agent, rawInput }) => {
				const t = T[getLocale ? getLocale() : "en"];
				const sessionId = agent?.session?.id ?? agent?.id;
				const input = rawInput.trim();
				if (input === "") {
					const override = await store.get(sessionId);
					const effective = resolveMode(override, cfg.mode);
					const text = override === void 0
						? t.showNoOverride(effective, cfg.mode)
						: t.showWithOverride(effective, override, cfg.mode);
					return { kind: "success", text };
				}
				if (input === "default" || input === "off" || input === "reset") {
					const persisted = await store.clear(sessionId);
					const text = persisted === "persisted"
						? t.cleared(cfg.mode)
						: t.clearedMemoryOnly(cfg.mode);
					return { kind: "success", text };
				}
				const mode = parseMode(input);
				if (mode === null) {
					return { kind: "success", text: t.unknown(input) };
				}
				const persisted = await store.set(sessionId, mode);
				const text = persisted === "persisted"
					? t.switched(mode)
					: t.switchedMemoryOnly(mode);
				return { kind: "success", text };
			}
		});
	});
}

/**
 * Build the `agent/pre-step` listener that feeds staged denials back to the
 * main agent as corrective context. When the previous step's escalation was
 * denied by this plugin, the sandbox layer reports it as "the user rejected"
 * — this injects a plugin-source user message right after that failure in
 * the next model request, telling the agent the denial came from the
 * automatic reviewer (with rationale) and how to proceed safely.
 *
 * Mirrors the injection pattern used by dsh-time-context and dsh-tool-cordis
 * (`{ kind: "enter", messages: [...decision.messages, message] }`).
 * Each staged denial is injected exactly once (queue cleared on hand-off);
 * a denial staged while the agent ends its turn is picked up by the next
 * turn's first pre-step (the injected message is durable in the session).
 *
 * @param deps - { config, denialFeed, getLocale }
 * @returns the pre-step listener `(payload, next) => Promise<PreStepDecision>`
 */
export function makeDenialInjector({ config, denialFeed, getLocale }) {
	const cfg = config;
	const feed = denialFeed;
	return async ({ agent, messages, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal?.aborted || !cfg.denyFeedback) return decision;
		const sessionId = agent?.session?.id ?? agent?.id;
		const queue = sessionId === undefined ? undefined : feed.get(sessionId);
		if (queue === undefined || queue.length === 0) return decision;
		const text = renderDenialNotice(queue, getLocale ? getLocale() : "en");
		// Clearing happens only after a successful render; a render throw
		// keeps the queue intact for the next pre-step instead of losing it.
		feed.delete(sessionId);
		return {
			kind: "enter",
			messages: [...decision.messages, {
				id: randomUUID(),
				role: "user",
				content: [{ type: "text", text }],
				source: { kind: "plugin", plugin: name, form: "instructions" }
			}]
		};
	};
}

/**
 * Build the command-copy locale resolver. `auto` follows the dsh settings
 * preference (`locale.preference`, owned by dsh-client-locale); an explicit
 * `zh`/`en` config wins. Without settings or preference → English.
 */
export function makeGetLocale(cfg, ctx) {
	return () => {
		if (cfg.locale === "zh" || cfg.locale === "en") return cfg.locale;
		try {
			return pickLocale(ctx.get("settings", false)?.get?.("locale")?.preference);
		} catch {
			return "en";
		}
	};
}

/** Cordis plugin entry: register the answerer when approval is composed. */
export async function apply(ctx, userConfig) {
	const cfg = normalizeConfig(userConfig);
	const store = makeModeStore(ctx, ctx.logger);
	const getLocale = makeGetLocale(cfg, ctx);
	const denialFeed = new Map();
	const llmRunner = makeLlmRunner(ctx.llm, cfg.ai);
	const handler = createHandler({
		config: cfg,
		record: makeRecorder(cfg.logFile),
		llmRunner,
		getSessionMode: (sessionId) => store.get(sessionId),
		denialFeed
	});
	ctx.on("approval/request", handler);
	// Rejection-attribution feedback: inject staged denials into the next
	// model request so the main agent knows the denial was automatic.
	ctx.on("agent/pre-step", makeDenialInjector({ config: cfg, denialFeed, getLocale }));
	// Command copy follows config.locale ("auto" → dsh locale preference)
	registerModeCommand(ctx, cfg, store, getLocale);
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
		fallback: cfg.fallback,
		denyFeedback: cfg.denyFeedback,
		denyFeedbackMax: cfg.denyFeedbackMax
	});
	ctx.logger?.info?.("[dsh-codex-approval] answerer registered — mode=%s rules=%d ai=%s tolerance=%s log=%s",
		cfg.mode, cfg.rules.length, cfg.ai.enabled ? "on" : "off", cfg.ai.riskTolerance, cfg.logFile);
}
