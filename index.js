/**
 * dsh-codex-approval — index.js
 *
 * Codex-style approval autopilot for DeepSeek Harness. Registers an
 * `approval/request` answerer (waterfall listener) that decides each request:
 *
 *   1. enrich — recover the full tool arguments by callId from the session snapshot
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
import { buildTranscript } from "./transcript.js";
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
		{ match: "Bash(*npm publish*)", action: "ask" },
		// PowerShell (Windows) counterparts for the read-only allow family:
		// dsh's shell tool is `pwsh` on Windows, so the Bash(...) rules above
		// never match there and every request went to the AI judge. These
		// Pwsh(...) rules match only pwsh tool calls (tool names are
		// case-insensitive); the Bash rules stay effective on Linux/Raspberry
		// Pi, where the tool is `bash`. Both families coexist in this array.
		{ match: "Pwsh(git status*)", action: "allow" },
		{ match: "Pwsh(git diff*)", action: "allow" },
		{ match: "Pwsh(git log*)", action: "allow" },
		{ match: "Pwsh(Get-ChildItem *)", action: "allow" },
		{ match: "Pwsh(ls *)", action: "allow" },
		{ match: "Pwsh(Get-Content *)", action: "allow" },
		{ match: "Pwsh(cat *)", action: "allow" },
		{ match: "Pwsh(Get-Location)", action: "allow" },
		{ match: "Pwsh(pwd)", action: "allow" },
		{ match: "Pwsh(Get-Command *)", action: "allow" },
		{ match: "Pwsh(Write-Output *)", action: "allow" },
		{ match: "Pwsh(Select-Object *)", action: "allow" }
	],
	ai: {
		enabled: true,
		// Primary judge: the local CLIProxyAPI route (Command Code channel).
		// The retired OpenCode Go subscription used to serve this model and now
		// answers 401 CreditsError, so the default points at a route that is
		// actually billable.
		provider: "cpa-wx301",
		model: "command/deepseek/deepseek-v4.1-flash",
		// Ordered judge chain: each entry is tried when every entry before it
		// failed (auth, quota, upstream 5xx, transport, timeout). The native
		// DeepSeek adapter (api.deepseek.com via DEEPSEEK_API_KEY) is a
		// different route to the same model family, so losing one third-party
		// subscription can no longer disable the AI layer.
		fallbacks: [
			{ provider: "deepseek-official", model: "deepseek-flash" }
		],
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
	// Compact session transcript for the AI judge: "off" (default) keeps the
	// v0.3.0 zero-context input; "short" adds a bounded two-level window
	// skeleton (see transcript.js) so the judge sees user intent and the
	// surrounding tool chain. Absolute size is capped by transcriptMaxChars.
	transcript: "off",
	transcriptMaxChars: 4000,
	logFile: join(homedir(), ".dsh", "logs", "approval.jsonl")
};

const ACTIONS = ["allow", "ask", "deny"];
const TOLERANCES = ["low", "medium", "high"];
/** Upper bound on the ordered judge-fallback chain (the primary is not counted). */
const MAX_FALLBACKS = 4;

/** User-editable model and policy settings, separate from per-session mode overrides. */
export const CONFIG_SETTINGS_NAMESPACE = "dsh-codex-approval-config";
export const CONFIG_SETTINGS_SCHEMA = z.object({
	provider: z.string().default(DEFAULT_CONFIG.ai.provider),
	model: z.string().default(DEFAULT_CONFIG.ai.model),
	fallbacks: z.array(z.object({ provider: z.string(), model: z.string() })).default(DEFAULT_CONFIG.ai.fallbacks),
	riskTolerance: z.union(TOLERANCES).default(DEFAULT_CONFIG.ai.riskTolerance),
	failOpen: z.union(ACTIONS).default(DEFAULT_CONFIG.ai.failOpen),
	mode3OnAsk: z.union(["deny", "allow"]).default(DEFAULT_CONFIG.mode3OnAsk),
	timeoutMs: z.number().step(1).min(1).default(DEFAULT_CONFIG.ai.timeoutMs),
	maxTokens: z.number().step(1).min(1).default(DEFAULT_CONFIG.ai.maxTokens),
	denyFeedback: z.boolean().default(DEFAULT_CONFIG.denyFeedback)
});

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
	if (!Array.isArray(cfg.ai.fallbacks)) throw new TypeError("dsh-codex-approval: config.ai.fallbacks must be an array");
	if (cfg.ai.fallbacks.length > MAX_FALLBACKS) throw new TypeError(`dsh-codex-approval: config.ai.fallbacks must hold at most ${MAX_FALLBACKS} entries`);
	for (const entry of cfg.ai.fallbacks) {
		if (typeof entry?.provider !== "string" || entry.provider === "" || typeof entry?.model !== "string" || entry.model === "") {
			throw new TypeError("dsh-codex-approval: each ai.fallbacks entry needs a non-empty provider and model");
		}
	}
	if (!ACTIONS.includes(cfg.fallback)) throw new TypeError("dsh-codex-approval: config.fallback must be allow/ask/deny");
	if (typeof cfg.denyFeedback !== "boolean") throw new TypeError("dsh-codex-approval: config.denyFeedback must be a boolean");
	if (!Number.isSafeInteger(cfg.denyFeedbackMax) || cfg.denyFeedbackMax < 1 || cfg.denyFeedbackMax > 10) {
		throw new TypeError("dsh-codex-approval: config.denyFeedbackMax must be an integer in 1..10");
	}
	if (!["off", "short"].includes(cfg.transcript)) throw new TypeError("dsh-codex-approval: config.transcript must be off/short");
	if (!Number.isSafeInteger(cfg.transcriptMaxChars) || cfg.transcriptMaxChars < 100 || cfg.transcriptMaxChars > 16000) {
		throw new TypeError("dsh-codex-approval: config.transcriptMaxChars must be an integer in 100..16000");
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

/** Project the user-editable settings namespace onto a full plugin config. */
export function applyConfigSettings(baseConfig, settings) {
	return normalizeConfig({
		...baseConfig,
		mode3OnAsk: settings?.mode3OnAsk ?? baseConfig.mode3OnAsk,
		denyFeedback: settings?.denyFeedback ?? baseConfig.denyFeedback,
		ai: {
			...baseConfig.ai,
			provider: settings?.provider ?? baseConfig.ai.provider,
			model: settings?.model ?? baseConfig.ai.model,
			fallbacks: settings?.fallbacks ?? baseConfig.ai.fallbacks,
			riskTolerance: settings?.riskTolerance ?? baseConfig.ai.riskTolerance,
			failOpen: settings?.failOpen ?? baseConfig.ai.failOpen,
			timeoutMs: settings?.timeoutMs ?? baseConfig.ai.timeoutMs,
			maxTokens: settings?.maxTokens ?? baseConfig.ai.maxTokens
		}
	});
}

function outcomeFor(action) {
	if (action === "allow") return "allowed-once";
	if (action === "deny") return "rejected";
	return "pass";
}

const FAILURE_CODE_MAX_CHARS = 100;
const FAILURE_MESSAGE_MAX_CHARS = 500;
const FAILURE_REQUEST_ID_MAX_CHARS = 160;

/** Redact common credential-shaped values before they reach logs or prompts. */
function redactSensitive(text) {
	return text
		.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
		.replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
		.replace(/([?&](?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|token)=)[^&#\s]*/gi, "$1[REDACTED]")
		.replace(/\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|token)\s*[:=]\s*[^\s,;]+/gi, (match) => {
			const separator = match.match(/\s*[:=]\s*/)?.[0] ?? "=";
			const label = match.slice(0, match.indexOf(separator));
			return `${label}${separator}[REDACTED]`;
		});
}

function boundedText(value, maxChars) {
	if (typeof value !== "string") return undefined;
	const text = redactSensitive(value).trim();
	if (text === "") return undefined;
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function boundedCode(value) {
	return boundedText(value, FAILURE_CODE_MAX_CHARS);
}

function normalizeFailure(reason) {
	const raw = reason?.failure;
	if (raw === null || typeof raw !== "object") return undefined;
	const code = boundedCode(raw.code);
	const message = boundedText(raw.message, FAILURE_MESSAGE_MAX_CHARS);
	const failure = {
		...code === undefined ? {} : { code },
		...message === undefined ? {} : { message }
	};
	if (Number.isInteger(raw.status) && raw.status >= 100 && raw.status <= 599) failure.status = raw.status;
	if (Number.isFinite(raw.providerRetryAfterMs) && raw.providerRetryAfterMs > 0) {
		failure.providerRetryAfterMs = Math.min(raw.providerRetryAfterMs, 86_400_000);
	}
	const requestId = boundedText(raw.requestId, FAILURE_REQUEST_ID_MAX_CHARS);
	if (requestId !== undefined) failure.requestId = requestId;
	return Object.keys(failure).length === 0 ? undefined : failure;
}

function formatFailureError(kind, failure) {
	const prefix = `judge stream finished with ${kind}`;
	if (failure === undefined) return prefix;
	const code = failure.code === undefined ? "" : ` [${failure.code}]`;
	const message = failure.message === undefined ? "" : `: ${failure.message}`;
	return `${prefix}${code}${message}`;
}

/** One judge attempt against a single provider/model pair, bounded by timeout. */
async function attemptJudge(llm, candidate, { messages, signal, sessionId, timeoutMs, maxTokens }) {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const combined = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		const prepared = await llm.prepareCall({ provider: candidate.provider, model: candidate.model, temperature: 0, maxTokens }, combined);
		let text = "";
		for await (const chunk of prepared.stream({
			...prepared.config,
			messages,
			signal: combined,
			...sessionId === undefined ? {} : { sessionId }
		})) {
			if (chunk.type === "text-delta") text += chunk.text;
			else if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
				const failure = normalizeFailure(chunk.reason);
				return {
					ok: false,
					finishKind: chunk.reason.kind,
					...failure === undefined ? {} : { failure },
					error: formatFailureError(chunk.reason.kind, failure)
				};
			}
		}
		return { ok: true, text };
	} catch (error) {
		const message = boundedText(error?.message ?? String(error), FAILURE_MESSAGE_MAX_CHARS) ?? "LLM judge failed";
		return { ok: false, error: message };
	}
}

/**
 * The ordered judge runner: the configured provider/model first, then every
 * `ai.fallbacks` entry, deduplicated by pair. One timeout-bounded attempt runs
 * per candidate and the chain advances on provider failure (auth, quota,
 * upstream 5xx, transport, timeout), so a retired subscription or a cooled-down
 * route degrades to the next judge instead of disabling the AI layer. The first
 * candidate that answers wins; when all candidates fail the primary's failure
 * is reported — it is the configured intent — annotated with how many were
 * tried. A single-candidate chain keeps the pre-fallback result shape exactly.
 */
export function makeLlmRunner(llm, configOrGetter) {
	const getConfig = typeof configOrGetter === "function" ? configOrGetter : () => configOrGetter;
	return async (messages, { signal, sessionId } = {}) => {
		const { provider, model, timeoutMs, maxTokens, fallbacks } = getConfig();
		const chain = [{ provider, model }];
		for (const entry of Array.isArray(fallbacks) ? fallbacks : []) {
			if (entry === null || typeof entry !== "object") continue;
			if (typeof entry.provider !== "string" || entry.provider === "" || typeof entry.model !== "string" || entry.model === "") continue;
			if (chain.some((candidate) => candidate.provider === entry.provider && candidate.model === entry.model)) continue;
			chain.push({ provider: entry.provider, model: entry.model });
		}
		const tried = [];
		let primaryFailure;
		for (let index = 0; index < chain.length; index += 1) {
			// A cancelled approval must not spend further judge calls.
			if (signal?.aborted === true) break;
			const candidate = chain[index];
			tried.push(`${candidate.provider}/${candidate.model}`);
			const result = await attemptJudge(llm, candidate, { messages, signal, sessionId, timeoutMs, maxTokens });
			if (result.ok === true) {
				// A chain that answered on its first candidate still records which
				// model judged (audit value); a chain-less runner keeps the legacy
				// result shape untouched.
				if (index === 0) {
					if (chain.length === 1) return result;
					return { ...result, judgeAttempts: 1, judgeModel: `${candidate.provider}/${candidate.model}` };
				}
				return {
					...result,
					judgeAttempts: tried.length,
					judgeFallbackFrom: `${chain[0].provider}/${chain[0].model}`,
					judgeModel: `${candidate.provider}/${candidate.model}`
				};
			}
			if (primaryFailure === undefined) primaryFailure = result;
		}
		const failed = primaryFailure ?? { ok: false, error: "judge cancelled before any attempt" };
		if (tried.length <= 1) return failed;
		return { ...failed, judgeAttempts: tried.length, judgeTried: tried };
	};
}

/**
 * Create the approval/request handler with injected dependencies
 * (unit-testable without a cordis ctx).
 * @param deps - { config, record, llmRunner, getSessionMode, denialFeed, denialHistory, getCwd }
 *   `denialFeed` is an optional Map<sessionId, Array<DenialRecord>> used to
 *   stage plugin-originated denials for the `agent/pre-step` injector; when
 *   omitted the handler creates its own (shared only if the caller passes it).
 *   `denialHistory` is an optional Map<sessionId, Array<DenialRecord>>
 *   accumulating the last few denials of each session for the transcript
 *   context ([D] lines) — created internally when omitted.
 *   `getCwd` optionally returns the workspace path for the transcript [W] line.
 * @returns async (req, next) => ApprovalOutcome
 */
export function createHandler({ config, record, llmRunner, getSessionMode, denialFeed, denialHistory, getCwd }) {
	let cfg = config;
	const feed = denialFeed ?? new Map();
	const history = denialHistory ?? new Map();
	const stageDenial = (sessionId, denial) => {
		if (sessionId === undefined || sessionId === null) return;
		const queue = feed.get(sessionId) ?? [];
		queue.push(denial);
		if (queue.length > cfg.denyFeedbackMax) queue.shift();
		feed.set(sessionId, queue);
		const hq = history.get(sessionId) ?? [];
		hq.push(denial);
		if (hq.length > 5) hq.shift();
		history.set(sessionId, hq);
	};
	const updateConfig = (nextConfig) => {
		cfg = nextConfig;
	};
	const handler = async (req, next) => {
		const started = Date.now();
		if (req.signal?.aborted === true) return "cancelled";
		if (!cfg.enabled) return next();

		const sessionId = req.agent?.session?.id ?? req.agent?.id;
		const override = await getSessionMode?.(sessionId);
		const mode = resolveMode(override, cfg.mode);

		// mode 1: fully bypassed — the pre-plugin experience (no decision, no audit)
		if (mode === "manual") return next();

		const args = findToolCallArgs(req.agent?.session, req.callId);
		const argsText = argsPreview(args, req.toolName, cfg.ai.maxPromptChars);
		const matchReq = { toolName: req.toolName, argsText, reason: req.reason ?? "" };

		let verdict;
		let context = "";
		const rule = evaluateRules(cfg.rules, matchReq);
		if (rule !== null) {
			verdict = { kind: "rule", action: rule.action, outcome: outcomeFor(rule.action), match: rule.match };
		} else if (cfg.ai.enabled) {
			context = cfg.transcript === "short"
				? buildTranscript({
					events: req.agent?.session,
					cfg,
					denialHistory: history,
					sessionId,
					mode,
					tolerance: cfg.ai.riskTolerance,
					mode3OnAsk: cfg.mode3OnAsk,
					cwd: getCwd !== undefined ? getCwd(req.agent) : undefined
				})
				: "";
			const judged = await judgeWith({
				runner: llmRunner,
				input: { toolName: req.toolName, argsText, reason: req.reason ?? "", context },
				allowAsk: mode !== "ai-auto",
				sessionId
			});
			if (judged.ok) {
				const authorization = decideAuthorization(judged.verdict, cfg.ai.riskTolerance);
				verdict = {
					kind: "ai",
					action: authorization,
					outcome: outcomeFor(authorization),
					risk: judged.verdict.risk,
					aiReason: judged.verdict.reason,
					...judged.judgeModel === undefined ? {} : { judgeModel: judged.judgeModel },
					...judged.judgeFallbackFrom === undefined ? {} : { judgeFallbackFrom: judged.judgeFallbackFrom },
					...judged.judgeAttempts === undefined ? {} : { judgeAttempts: judged.judgeAttempts }
				};
			} else {
				verdict = {
					kind: "ai-error",
					action: cfg.ai.failOpen,
					outcome: outcomeFor(cfg.ai.failOpen),
					error: judged.error,
					...judged.finishKind !== void 0 ? { finishKind: judged.finishKind } : {},
					...judged.failure !== void 0 ? { failure: judged.failure } : {},
					...judged.rawText !== void 0 ? { rawOutput: judged.rawText } : {},
					...judged.judgeAttempts !== void 0 ? { judgeAttempts: judged.judgeAttempts } : {},
					...judged.judgeTried !== void 0 ? { judgeTried: judged.judgeTried } : {}
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
			transcriptChars: context.length,
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
				...verdict.finishKind !== void 0 ? { finishKind: verdict.finishKind } : {},
				...verdict.failure !== void 0 ? { failure: verdict.failure } : {},
				...verdict.viaAskResolution === true ? { viaAsk: true } : {},
				ts: Date.now()
			});
		}

		return verdict.outcome === "pass" ? next() : verdict.outcome;
	};
	handler.updateConfig = updateConfig;
	return handler;
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
export function makeDenialInjector({ config, getConfig, denialFeed, getLocale }) {
	const feed = denialFeed;
	const readConfig = getConfig ?? (() => config);
	return async ({ agent, messages, signal }, next) => {
		const decision = await next();
		const cfg = readConfig();
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
export function makeGetLocale(cfg, ctx, getConfig = () => cfg) {
	return () => {
		const current = getConfig();
		if (current.locale === "zh" || current.locale === "en") return current.locale;
		try {
			return pickLocale(ctx.get("settings", false)?.get?.("locale")?.preference);
		} catch {
			return "en";
		}
	};
}

/**
 * Register the user-editable settings namespace and keep the runtime config in
 * sync with it.
 *
 * DSH 0.1.5's `settings.register(ns, schema, options)` returns the namespace's
 * **owner scope** (`get`/`watch`/`update`/`replace`) and exposes no service-level
 * `watch`, so watching through the service throws and live updates silently stop.
 * Older releases (0.1.2) only had the service-level `get`/`watch`; both shapes
 * are accepted here.
 *
 * @param deps - { settings, base, onValue, record, logger }
 *   `onValue` receives the effective settings value once at install time and
 *   again on every committed write; `record` appends the self-proving log line
 *   that tells a restart whether the namespace came up.
 * @returns the effective settings value, or undefined when registration failed.
 */
export function installConfigSettings({ settings, base, onValue, record, logger }) {
	try {
		const scope = settings.register(CONFIG_SETTINGS_NAMESPACE, CONFIG_SETTINGS_SCHEMA, { base, applies: "live" });
		const read = () => (typeof scope?.get === "function" ? scope.get() : settings.get(CONFIG_SETTINGS_NAMESPACE));
		const watch = (callback) => (typeof scope?.watch === "function" ? scope.watch(callback) : settings.watch(callback));
		const initial = read();
		onValue(initial);
		watch((next) => onValue(next));
		void record?.({
			ts: new Date().toISOString(),
			event: "config-settings",
			sessionId: "boot",
			ok: true,
			namespace: CONFIG_SETTINGS_NAMESPACE,
			applies: "live",
			scope: typeof scope?.get === "function" ? "owner-scope" : "service",
			fields: Object.keys(CONFIG_SETTINGS_SCHEMA({}) ?? {})
		});
		return initial;
	} catch (error) {
		const message = String(error?.message ?? error);
		// The Web settings card is dead without this namespace, so the failure is
		// logged loudly and recorded where a restart can be checked afterwards.
		logger?.error?.("[dsh-codex-approval] config settings unavailable: %s", message);
		void record?.({ ts: new Date().toISOString(), event: "config-settings", sessionId: "boot", ok: false, namespace: CONFIG_SETTINGS_NAMESPACE, error: message.slice(0, 400) });
		return undefined;
	}
}

/** Cordis plugin entry: register the answerer when approval is composed. */
export async function apply(ctx, userConfig) {
	let cfg = normalizeConfig(userConfig);
	const store = makeModeStore(ctx, ctx.logger);
	const denialFeed = new Map();
	const denialHistory = new Map();
	const getConfig = () => cfg;
	const getLocale = makeGetLocale(cfg, ctx, getConfig);
	const llmRunner = makeLlmRunner(ctx.llm, () => cfg.ai);
	const record = makeRecorder(cfg.logFile);
	const handler = createHandler({
		config: cfg,
		record,
		llmRunner,
		getSessionMode: (sessionId) => store.get(sessionId),
		denialFeed,
		denialHistory,
		getCwd: (agent) => agent?.session?.policy?.workspaceRoot ?? agent?.cwd
	});
	ctx.on("approval/request", handler);
	ctx.inject(["settings"], (settingsCtx) => {
		installConfigSettings({
			settings: settingsCtx.settings,
			base: {
				provider: cfg.ai.provider,
				model: cfg.ai.model,
				fallbacks: cfg.ai.fallbacks,
				riskTolerance: cfg.ai.riskTolerance,
				failOpen: cfg.ai.failOpen,
				mode3OnAsk: cfg.mode3OnAsk,
				timeoutMs: cfg.ai.timeoutMs,
				maxTokens: cfg.ai.maxTokens,
				denyFeedback: cfg.denyFeedback
			},
			onValue: (settingsValue) => {
				cfg = applyConfigSettings(cfg, settingsValue);
				handler.updateConfig(cfg);
			},
			record,
			logger: ctx.logger
		});
	});
	// Rejection-attribution feedback: inject staged denials into the next
	// model request so the main agent knows the denial was automatic.
	ctx.on("agent/pre-step", makeDenialInjector({ getConfig, denialFeed, getLocale }));
	// Command copy follows config.locale ("auto" → dsh locale preference)
	registerModeCommand(ctx, cfg, store, getLocale);
	// Self-proving startup record: this line in the log after a restart proves
	// the plugin loaded (decision records follow it). Awaited so a boot that
	// cannot even write its own log fails loud instead of silently degrading.
	await record({
		ts: new Date().toISOString(),
		event: "plugin-loaded",
		sessionId: "boot",
		mode: cfg.mode,
		mode3OnAsk: cfg.mode3OnAsk,
		rules: cfg.rules.length,
		ai: cfg.ai.enabled,
		judge: `${cfg.ai.provider}/${cfg.ai.model}`,
		judgeFallbacks: cfg.ai.fallbacks.map((entry) => `${entry.provider}/${entry.model}`),
		tolerance: cfg.ai.riskTolerance,
		fallback: cfg.fallback,
		denyFeedback: cfg.denyFeedback,
		denyFeedbackMax: cfg.denyFeedbackMax,
		transcript: cfg.transcript,
		transcriptMaxChars: cfg.transcriptMaxChars
	});
	ctx.logger?.info?.("[dsh-codex-approval] answerer registered — mode=%s rules=%d ai=%s judge=%s fallbacks=%d tolerance=%s log=%s",
		cfg.mode, cfg.rules.length, cfg.ai.enabled ? "on" : "off", `${cfg.ai.provider}/${cfg.ai.model}`, cfg.ai.fallbacks.length, cfg.ai.riskTolerance, cfg.logFile);
}
