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
 * - A shell command is only auto-approved when its text is a single plain
 *   command (shell-shape.js); compound/opaque text never reaches an allow rule.
 * - The operation is never truncated before rules or the judge see it, and
 *   missing/oversized evidence is never auto-approved.
 * - AI errors/timeouts fail open to the configured failOpen (default ask).
 * - The AI's closed-enum verdict is mapped onto the three outcomes, which
 *   bounds the *output* format; it does not make the judge immune to prompt
 *   injection, so the fixed policy and the untrusted request text are kept
 *   apart and the judge's `authorization` is checked against the hard rules.
 */

import { appendFile, readFile, realpath } from "node:fs/promises";
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, dirname, isAbsolute, relative, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";

import { classifyRequest, evaluateRules, FLAG_GUARDS, ruleLabel } from "./rules.js";
import { findToolCallArgs, argsPreview, shellCallFacts } from "./enrich.js";
import { commandFacts } from "./command-facts.js";
import { judgeWith, decidePolicy, parseVerdict } from "./judge.js";
import { parseNeeds, fetchEvidence } from "./evidence.js";
import { buildTranscript } from "./transcript.js";
import { MODES, parseMode, resolveMode, effectiveOnAsk } from "./modes.js";
import {
	T,
	pickLocale,
	commandDescription,
	renderDenialNotice,
	allowOnceCommandDescription,
	renderAllowOnceEmpty,
	renderAllowOnceGranted,
	renderAllowOnceList,
	renderAllowOnceUnknown
} from "./i18n.js";
import { createHash } from "node:crypto";
import { redactSensitive, boundedText } from "./redact.js";
import { isShellTool, positionalArgs } from "./shell-shape.js";

export const name = "dsh-codex-approval";

/**
 * Declarative dependency on the approval service. Cordis loads plugin entries
 * in parallel, so a runtime `ctx.get("approval")` check at apply time could
 * observe the service before it registers and silently no-op the plugin;
 * `inject` guarantees the service is ready before apply runs (fails loud at
 * load when the composition has no approval service).
 */
export const inject = ["approval", "llm"];

/**
 * Publishing commands that always need a human — the "red lines".
 *
 * A `hardAsk` rule is an ask that an unattended mode may not resolve through
 * `mode3OnAsk`: with no human around it fails closed (see
 * `ai.hardAskOnUnattended`, default deny). Matched with the tool prefix (so a
 * non-shell tool that merely mentions the text stays out) and with a wildcard
 * inside it (so `cd pkg && npm publish` is caught too), for bash and pwsh.
 */
const PUBLISH_COMMANDS = [
	"npm publish",
	"npm unpublish",
	"pnpm publish",
	"yarn publish",
	"bun publish",
	"twine upload",
	"cargo publish",
	"docker push",
	"gh release create",
	"git push"
];

/** Default configuration — tune via the profile patch id-targeted config. */
export const DEFAULT_CONFIG = {
	enabled: true,
	mode: "ai",
	// 无人值守红线之一：ai-auto 模式下「ask」的落点。**写死 deny、不可配**——
	// 见 `Config` 里三项红线的说明（要放开权限请改宿主权限，不要拆审批红线）。
	mode3OnAsk: "deny",
	locale: "auto",
	rules: [
		// ---- bash: read-only commands as structured argv prefixes -------------
		// An allow rule may only claim a command that shell-shape.js recognised
		// as `simple` — one command of plain words. `git status; rm -rf /tmp/x`,
		// `echo $(touch /tmp/x)`, `cat /dev/null > /tmp/x` and pwsh chains are
		// compound/opaque, so NO allow rule matches them; they reach the ask/deny
		// rules below and then the judge / human. `git diff --output=<file>`
		// writes a file, and `cat` only auto-approves workspace-relative paths.
		//
		// A read-only command can still *run* something: git executes external
		// programs named by repository config (`diff.external` runs **without**
		// any switch, a textconv filter likewise; `core.fsmonitor` runs on
		// `git status`). Those switches therefore veto the allow, and
		// `configGuard: "git-clean"` refuses the allow outright when the config
		// that could name such a program is present — see gitConfigGuard.
		// A path after `--` is a path even when it starts with `-`.
		{ tool: "bash", pattern: ["git", "status"], action: "allow", configGuard: "git-clean" },
		{ tool: "bash", pattern: ["git", "diff"], action: "allow", configGuard: "git-clean", forbidOptions: ["--output", "-O", "--ext-diff", "--textconv", "--show-signature"] },
		{ tool: "bash", pattern: ["git", "log"], action: "allow", configGuard: "git-clean", forbidOptions: ["--output", "-O", "--ext-diff", "--textconv", "--show-signature"] },
		{ tool: "bash", pattern: ["ls"], action: "allow" },
		{ tool: "bash", pattern: ["pwd"], action: "allow" },
		{ tool: "bash", pattern: ["which"], action: "allow" },
		{ tool: "bash", pattern: ["echo"], action: "allow" },
		{ tool: "bash", pattern: ["cat"], action: "allow", pathGuard: "workspace-relative" },
		// `wipefs -n` / `--no-act` is a dry run: it lists the signatures on the
		// device and writes nothing, so it is as read-only as `ls`. The denying
		// patterns for wipefs are written to fall *past* this one (deny beats
		// allow), which is why they name `-a` / `--all` and a device path.
		{ tool: "bash", pattern: ["wipefs", "-n"], action: "allow" },
		{ tool: "bash", pattern: ["wipefs", "--no-act"], action: "allow" },
		// ---- pwsh (Windows): the same families, pwsh tool calls only ---------
		// dsh's shell tool is `pwsh` on Windows; tool names are matched
		// case-insensitively and a structured rule only ever matches its own
		// tool, so the Bash and Pwsh families coexist.
		{ tool: "pwsh", pattern: ["git", "status"], action: "allow", configGuard: "git-clean" },
		{ tool: "pwsh", pattern: ["git", "diff"], action: "allow", configGuard: "git-clean", forbidOptions: ["--output", "-O", "--ext-diff", "--textconv", "--show-signature"] },
		{ tool: "pwsh", pattern: ["git", "log"], action: "allow", configGuard: "git-clean", forbidOptions: ["--output", "-O", "--ext-diff", "--textconv", "--show-signature"] },
		{ tool: "pwsh", pattern: ["Get-ChildItem"], action: "allow" },
		{ tool: "pwsh", pattern: ["ls"], action: "allow" },
		{ tool: "pwsh", pattern: ["Get-Location"], action: "allow" },
		{ tool: "pwsh", pattern: ["pwd"], action: "allow" },
		{ tool: "pwsh", pattern: ["Get-Command"], action: "allow" },
		{ tool: "pwsh", pattern: ["Write-Output"], action: "allow" },
		{ tool: "pwsh", pattern: ["Select-Object"], action: "allow" },
		{ tool: "pwsh", pattern: ["Get-Content"], action: "allow", pathGuard: "workspace-relative" },
		{ tool: "pwsh", pattern: ["cat"], action: "allow", pathGuard: "workspace-relative" },
		// ---- destructive: always deny ---------------------------------------
		// A deny claims the request outright — the human is never asked — so
		// these stay as narrow as the threat allows. The `*` prefix is what
		// catches a destructive command smuggled behind a separator; compound
		// and opaque text never reaches an allow rule anyway.
		{ match: "*rm -rf /*", action: "deny" },
		{ match: "*rm -rf ~*", action: "deny" },
		{ match: "*rm -fr /*", action: "deny" },
		{ match: "*sudo rm*", action: "deny" },
		{ match: "*mkfs*", action: "deny" },
		{ match: "Bash(shutdown*)", action: "deny" },
		{ match: "Bash(reboot*)", action: "deny" },
		// the same commands behind `sudo`/`doas` — the plain `Bash(shutdown*)`
		// form anchors at the start of the call and never saw them, and `sudo`
		// options (`sudo -n reboot`) sit between the two words
		{ match: "*sudo *shutdown*", action: "deny" },
		{ match: "*sudo *reboot*", action: "deny" },
		{ match: "*sudo *halt*", action: "deny" },
		{ match: "*sudo *poweroff*", action: "deny" },
		{ match: "*sudo *dd *", action: "deny" },
		{ match: "*doas *dd *", action: "deny" },
		// writing a raw device destroys whatever filesystem is on it
		{ match: "*of=/dev/sd*", action: "deny" },
		{ match: "*of=/dev/hd*", action: "deny" },
		{ match: "*of=/dev/vd*", action: "deny" },
		{ match: "*of=/dev/nvme*", action: "deny" },
		{ match: "*of=/dev/mmcblk*", action: "deny" },
		{ match: "*of=/dev/disk*", action: "deny" },
		{ match: "*of=/dev/mapper/*", action: "deny" },
		{ match: "*of=/dev/dm-*", action: "deny" },
		{ match: "*of=/dev/md*", action: "deny" },
		{ match: "*of=/dev/loop*", action: "deny" },
		// any other raw-device write: a human decides (`of=/dev/null` is caught
		// too — one confirmation for a rare, harmless form is the price)
		{ match: "*of=/dev/*", action: "ask" },
		{ match: "*:(){ :|:& };:*", action: "deny" },
		{ match: "Pwsh(Format-Volume*)", action: "deny" },
		{ match: "Pwsh(Stop-Computer*)", action: "deny" },
		{ match: "Pwsh(Restart-Computer*)", action: "deny" },
		// ---- whole-state deletion: version control, containers, cloud -------
		// These erase state that exists nowhere else — unstaged work, a dropped
		// stash, a deleted branch's commits, a volume, an object-store prefix —
		// so there is nothing for a human to weigh, and `/approval-allow-once`
		// could not bring the bytes back either: deny. Each pattern is written
		// for the shape that actually deletes, so the everyday forms of the same
		// commands are left alone: `git clean -n` (dry run) carries no `-f`,
		// `git clean --force` is still caught by the `-f` inside it, and the
		// branch/restore/kubernetes rules below name the destructive spelling.
		{ match: "Bash(git clean *-f*)", action: "deny" },
		{ match: "Bash(*git clean *-f*)", action: "deny" },
		{ match: "Bash(git reset --hard*)", action: "deny" },
		{ match: "Bash(*git reset --hard*)", action: "deny" },
		{ match: "Bash(git checkout -- *)", action: "deny" },
		{ match: "Bash(*git checkout -- *)", action: "deny" },
		// `git restore` discards working-tree content; `--staged` only rewrites
		// the index, and `git restore --staged .` is an everyday call. Text cannot
		// tell "has --staged" from "has nothing but --staged", so the rule denies
		// the restoring forms and exempts the index one through `unless` — which
		// only narrows a deny/ask rule (assertConfig refuses it on an allow). The
		// one combination `unless` cannot see (`--staged --worktree`, which does
		// discard work) is named explicitly *above* the exempted rules, because
		// same-action rules are taken in list order.
		{ match: "Bash(git restore*--worktree*)", action: "deny" },
		{ match: "Bash(*git restore*--worktree*)", action: "deny" },
		{ match: "Bash(git restore*)", action: "deny", unless: "Bash(*git restore --staged*)" },
		{ match: "Bash(*git restore*)", action: "deny", unless: "Bash(*git restore --staged*)" },
		{ match: "Bash(git stash clear*)", action: "deny" },
		{ match: "Bash(*git stash clear*)", action: "deny" },
		// case-sensitive on purpose — and therefore written without the `Bash(`
		// prefix the other rules carry. That prefix is spelled in the rules' own
		// capitalisation and only survives because matching folds case; under
		// `caseSensitive` it would never meet the real tool name (`bash`), so the
		// pattern anchors on the command text instead (bare-text surfaces cover
		// every tool, which for a `deny` is the safe direction). `-D` drops a
		// branch that may hold unmerged commits, `-d` refuses to — git enforces
		// that difference itself, and folding case would make one rule of the two.
		{ match: "*git branch -D *", action: "deny", caseSensitive: true },
		{ match: "Bash(git worktree remove*)", action: "deny" },
		{ match: "Bash(*git worktree remove*)", action: "deny" },
		{ match: "*docker system prune*", action: "deny" },
		{ match: "*docker volume rm *", action: "deny" },
		{ match: "*docker volume prune*", action: "deny" },
		{ match: "*docker compose down -v*", action: "deny" },
		{ match: "*docker-compose down -v*", action: "deny" },
		// Kubernetes: only the deletions that take a *whole* piece of state with
		// them — a namespace, a volume, or `--all` of a kind. `kubectl delete pod
		// web` is how a pod is restarted and stays with the judge.
		{ match: "*kubectl delete ns*", action: "deny" },
		{ match: "*kubectl delete namespace*", action: "deny" },
		{ match: "*kubectl delete pvc*", action: "deny" },
		{ match: "*kubectl delete pv*", action: "deny" },
		{ match: "*kubectl delete *--all*", action: "deny" },
		{ match: "*rclone purge*", action: "deny" },
		{ match: "*aws s3 rm --recursive*", action: "deny" },
		{ match: "*aws s3 rm *--recursive*", action: "deny" },
		// Erasing the filesystem signatures on a device is a deny; a plain
		// `wipefs /dev/sdX` (which also wipes) asks a human; `wipefs -n` is a dry
		// run that writes nothing at all and is allowed below — the patterns here
		// must therefore not match it, or deny > ask > allow would swallow the
		// allow (`wipefs -a` / `--all` erases every signature it can find).
		{ match: "*wipefs -a*", action: "deny" },
		{ match: "*wipefs --all*", action: "deny" },
		{ match: "*wipefs /dev/*", action: "ask" },
		{ match: "*wipefs -f /dev/*", action: "ask" },
		// ---- always ask a human ---------------------------------------------
		// Recursive deletion. `rm -rf` is the one shape that erases a whole
		// subtree in a single call, and the workspace being the sandbox's write
		// boundary does not make it a safe one — nothing backed those bytes up,
		// and regenerating them is the user's problem. `rm -r` alone counts too:
		// `-f` only decides whether read-only files stop it.
		//
		// Which spellings count is answered on the argv, not on the text: as text
		// `rm -rf`, `rm -fr`, `rm -r -f` and `rm -rvf` are four different strings,
		// and a glob list would have to enumerate every letter of every bundle in
		// every order. `flagGuard: "recursive-delete"` splits the bundle
		// (shell-shape.js), so all of them — plus `rm --recursive --force`, `/bin/rm -rvf`,
		// `cd pkg && rm -rvf dist`, and pwsh's `Remove-Item -Recurse` — match one rule.
		//
		// The text rules under the guard are not redundant: an *opaque* command
		// has no argv to inspect, and those are exactly the ones that carry the
		// literal (`rm -rf $DIR/x`, `rm -rf "$(cat target)"`). Rules match
		// characters, not paths, so neither form can tell "inside the workspace"
		// from "outside it"; what they cover in practice is the *relative*
		// spelling, because every absolute form is claimed by `*rm -rf /*` above
		// (deny > ask), which denies `rm -rf /tmp/x` exactly as it denies
		// `rm -rf /`. The `Bash(` prefix keeps a non-shell tool that merely
		// *mentions* the text (a file being written) out of the rule.
		{ tool: "bash", flagGuard: "recursive-delete", action: "ask" },
		{ tool: "pwsh", flagGuard: "recursive-delete", action: "ask" },
		{ match: "Bash(*rm -rf*)", action: "ask" },
		{ match: "Bash(*rm -fr*)", action: "ask" },
		// the same switches written apart; whitespace runs are normalized on the
		// safety side, so `rm  -r<TAB>-f` lands on the same text
		{ match: "Bash(*rm -r -f*)", action: "ask" },
		{ match: "Bash(*rm -f -r*)", action: "ask" },
		// Content destruction that is not a recursive delete: truncation,
		// overwrite, secure erase, single-file unlink. Irreversible for the bytes,
		// but none of them takes a subtree with it — so a human decides rather
		// than the request being refused outright.
		{ match: "Bash(truncate *)", action: "ask" },
		{ match: "Bash(*truncate *)", action: "ask" },
		{ match: "Bash(shred *)", action: "ask" },
		{ match: "Bash(*shred *)", action: "ask" },
		{ match: "Bash(unlink *)", action: "ask" },
		{ match: "Bash(*unlink *)", action: "ask" },
		{ match: "Bash(cp /dev/null *)", action: "ask" },
		{ match: "Bash(*cp /dev/null *)", action: "ask" },
		// `dd of=<file>` overwrites that file (`of=/dev/*` is handled above)
		{ match: "*dd *of=*", action: "ask" },
		// a redirection with no command truncates the file it names
		{ match: "Bash(> *)", action: "ask" },
		{ match: "Bash(: > *)", action: "ask" },
		// `find … -delete` is a recursive delete written without `rm`
		{ match: "Bash(find *-delete*)", action: "ask" },
		{ match: "Bash(*find *-delete*)", action: "ask" },
		// mirroring with deletion: whatever is missing on the source is removed
		// from the destination
		{ match: "*rsync*--delete*", action: "ask" },
		// one stash entry goes away, and it may be the only copy of that work
		{ match: "*git stash drop*", action: "ask" },
		// database and account destruction
		{ match: "*DROP TABLE*", action: "ask" },
		{ match: "*DROP DATABASE*", action: "ask" },
		{ match: "*FLUSHALL*", action: "ask" },
		// `userdel -r` takes the account's home directory with it
		{ match: "*userdel -r*", action: "ask" },
		{ match: "*userdel --remove*", action: "ask" },
		// PowerShell and cmd deletion spellings. `/s` is cmd's recursive switch
		// and it may sit anywhere in the argument list (`del /f /s /q x`,
		// `rd /q /s x`), so the pattern allows anything between the program and
		// the switch instead of spelling one order.
		{ match: "Pwsh(*Clear-Content*)", action: "ask" },
		{ match: "Pwsh(*rd*/s*)", action: "ask" },
		{ match: "Pwsh(*rmdir*/s*)", action: "ask" },
		{ match: "Pwsh(*del*/s*)", action: "ask" },
		// publishing: a red line — never auto-decided, and an unattended mode
		// cannot resolve it through `mode3OnAsk` (it fails closed instead).
		...PUBLISH_COMMANDS.flatMap((command) => [
			{ match: `Bash(${command}*)`, action: "ask", hardAsk: true },
			{ match: `Bash(*${command}*)`, action: "ask", hardAsk: true },
			{ match: `Pwsh(${command}*)`, action: "ask", hardAsk: true },
			{ match: `Pwsh(*${command}*)`, action: "ask", hardAsk: true }
		]),
		// credentials and approval configuration: reading, copying or writing
		// these always needs a human, however harmless the command looks. The
		// *directory* is the secret, so it is matched in three shapes —
		// `<dir>/`, `<dir>` at the end of the text, and `<dir> ` followed by
		// another argument — which catches `cp -r ~/.ssh /tmp/` and
		// `tar -czf x.tgz ~/.aws` without also catching a file that merely
		// starts with the name (`docs/.aws-guide.md`). The backslash forms cover
		// Windows paths, where the separator is `\` and the forward-slash
		// patterns never matched.
		{ match: "*id_rsa*", action: "ask", hardAsk: true },
		{ match: "*id_ed25519*", action: "ask", hardAsk: true },
		{ match: "*/.ssh/*", action: "ask", hardAsk: true },
		{ match: "*/.ssh", action: "ask", hardAsk: true },
		{ match: "*/.ssh *", action: "ask", hardAsk: true },
		// the same directory written relative to the workspace, with either
		// separator (`.ssh/config`, `.ssh\\config`, `x\\.ssh\\config`)
		{ match: "*.ssh/*", action: "ask", hardAsk: true },
		{ match: "*.ssh", action: "ask", hardAsk: true },
		{ match: "*.ssh *", action: "ask", hardAsk: true },
		{ match: "*.ssh\\*", action: "ask", hardAsk: true },
		{ match: "*.ssh\\", action: "ask", hardAsk: true },
		{ match: "*.ssh\\ *", action: "ask", hardAsk: true },
		{ match: "*\\.ssh\\*", action: "ask", hardAsk: true },
		{ match: "*\\.ssh", action: "ask", hardAsk: true },
		{ match: "*\\.ssh *", action: "ask", hardAsk: true },
		{ match: "*/.aws/*", action: "ask", hardAsk: true },
		{ match: "*/.aws", action: "ask", hardAsk: true },
		{ match: "*/.aws *", action: "ask", hardAsk: true },
		{ match: "*.aws/*", action: "ask", hardAsk: true },
		{ match: "*.aws", action: "ask", hardAsk: true },
		{ match: "*.aws *", action: "ask", hardAsk: true },
		{ match: "*.aws\\*", action: "ask", hardAsk: true },
		{ match: "*.aws\\", action: "ask", hardAsk: true },
		{ match: "*.aws\\ *", action: "ask", hardAsk: true },
		{ match: "*\\.aws\\*", action: "ask", hardAsk: true },
		{ match: "*\\.aws", action: "ask", hardAsk: true },
		{ match: "*\\.aws *", action: "ask", hardAsk: true },
		{ match: "*/.codex/auth.json*", action: "ask", hardAsk: true },
		{ match: "*\\.codex\\auth.json*", action: "ask", hardAsk: true },
		{ match: "*.codex/auth.json*", action: "ask", hardAsk: true },
		{ match: "*.codex\\auth.json*", action: "ask", hardAsk: true },
		{ match: "*/.dsh/profiles/*", action: "ask" },
		{ match: "*/.dsh/profiles", action: "ask" },
		{ match: "*/.dsh/profiles *", action: "ask" },
		{ match: "*.dsh/profiles/*", action: "ask" },
		{ match: "*.dsh/profiles", action: "ask" },
		{ match: "*.dsh/profiles *", action: "ask" },
		{ match: "*\\.dsh\\profiles\\*", action: "ask" },
		{ match: "*.dsh\\profiles\\*", action: "ask" },
		{ match: "*.dsh\\profiles\\", action: "ask" },
		{ match: "*.dsh\\profiles\\ *", action: "ask" },
		{ match: "*\\.dsh\\profiles", action: "ask" },
		{ match: "*\\.dsh\\profiles *", action: "ask" },
		{ match: "*/.dsh/settings.yaml*", action: "ask" },
		{ match: "*\\.dsh\\settings.yaml*", action: "ask" },
		{ match: "*.dsh/settings.yaml*", action: "ask" },
		{ match: "*.dsh\\settings.yaml*", action: "ask" },
		{ match: "*/.dsh/logs/approval.jsonl*", action: "ask" },
		{ match: "*\\.dsh\\logs\\approval.jsonl*", action: "ask" },
		{ match: "*.dsh/logs/approval.jsonl*", action: "ask" },
		{ match: "*.dsh\\logs\\approval.jsonl*", action: "ask" },
		{ match: "*/.dsh-codex-approval/*", action: "ask" },
		// the agent's own justification (`reason:`) can only raise strictness,
		// never grant: these patterns only ever add an ask
		{ match: "reason:*secret*", action: "ask" },
		{ match: "reason:*password*", action: "ask" },
		{ match: "reason:*credential*", action: "ask" },
		{ match: "reason:*token*", action: "ask" }
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
		// Display-only cap: the audit record / UI preview is truncated to this,
		// and it never feeds a decision.
		maxPromptChars: 2000,
		// The judge's command budget. The operation is never truncated before
		// rule matching; a command longer than this is treated as *incomplete
		// evidence* (human in `ai`, denied in `ai-auto`) instead of being judged
		// on a prefix.
		maxJudgeCommandChars: 8000,
		timeoutMs: 15000,
		maxTokens: 512,
		failOpen: "ask",
		// Where an *enforced* policy ask lands in an unattended mode: a high risk
		// nobody authorized, or an allow above the tolerance nobody asked for.
		// It is not the judge being unsure — `mode3OnAsk: allow` must not be able
		// to turn "no user consented" into permission, so this is its own knob.
		// **写死 deny、不可配**：非 deny 就等于在无人值守时直接授予完全权限，
		// 要放开权限请改宿主权限层（见 `Config` 里三项红线的说明）。
		enforcedAskOnUnattended: "deny",
		// Where a `hardAsk` red line lands when nobody can be asked. A red line
		// is an ask an unattended mode may not resolve through `mode3OnAsk`
		// (publishing, credentials): "nobody could consent" is not consent.
		// **写死 deny、不可配**（同上一项；"ask" 的语义是无人值守时无限等待，
		// 既不是拒绝也不是授权，故一并写死）。
		hardAskOnUnattended: "deny",
		// One budget for the WHOLE approval, not per candidate: a chain of slow
		// judges (and an evidence round) must not add up to minutes on the
		// approval critical path. Each candidate still gets `timeoutMs`, capped
		// by what is left. 0 disables the budget.
		totalBudgetMs: 30_000,
		// Read-only evidence fetch for the judge. "read-file" lets a verdict ask
		// for at most `evidenceMaxFiles` workspace-local files (each bounded by
		// `evidenceMaxBytes`) and be judged once more with them attached; "off"
		// keeps the single-round judge. The plugin — not the model — decides what
		// is readable (evidence.js): realpath-verified inside the workspace, no
		// credential files, no binaries, and a refusal reason when it says no.
		evidenceFetch: "read-file",
		evidenceMaxFiles: 2,
		evidenceMaxBytes: 16_384
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
	// Rejection circuit breaker, per session, plugin-originated denials only.
	// A session that keeps getting denied stops paying for judge calls:
	//   consecutive — plugin denials in a row that cool the session down (0 = off)
	//   duplicate   — denials of the SAME action before it is refused outright (0 = off)
	//   cooldownMs  — how long a tripped breaker refuses AI-judged requests
	denialBreaker: {
		consecutive: 3,
		duplicate: 2,
		cooldownMs: 600_000
	},
	// Compact session transcript for the AI judge: "short" (default since
	// 2026-10-06) adds a bounded two-level window skeleton (see transcript.js) so
	// the judge sees user intent and the surrounding tool chain; "off" keeps the
	// old v0.3.0 zero-context input. Measured on the 24-case set
	// (`command/deepseek/deepseek-v4.1-flash`, repeat=3): short 13/72 human
	// handoffs vs off 17/72, same non-disputed dangerous releases (0/66) — the
	// four extra interruptions were all "user already asked for this" cases the
	// judge could not see without the skeleton. Absolute size is capped by
	// transcriptMaxChars.
	transcript: "short",
	transcriptMaxChars: 4000,
	logFile: join(homedir(), ".dsh", "logs", "approval.jsonl"),
	// Rotate the audit log to `<logFile>.1` once it grows past this many bytes.
	// A log the plugin creates itself is created with mode 0600; an existing
	// file's permissions are left untouched (chmod is an operator decision).
	logMaxBytes: 5_000_000
};

const ACTIONS = ["allow", "ask", "deny"];
const TOLERANCES = ["low", "medium", "high"];
/** Extra wall-clock allowed past a candidate's own timeout before we stop waiting. */
const HARD_TIMEOUT_GRACE_MS = 250;

/** Evidence-fetch modes: single-round judge, or one bounded read round. */
const EVIDENCE_FETCH = ["off", "read-file"];
/** Upper bound on the ordered judge-fallback chain (the primary is not counted). */
const MAX_FALLBACKS = 4;

/**
 * 把字段标成 live（可热编辑）。
 *
 * 语义（实测自 `@deepseek-ai/schemastery` 与 `cordis-plugin-loader`）：
 *  1. 只有带 `meta.volatile` 的字段才进设置表单——`dsh-settings` 的
 *     `volatileForm` 在整个 schema 找不到 volatile 字段时会直接跳过该 entry；
 *  2. 只有带 `meta.volatile` 的字段能被**不重载插件**地改：loader 的
 *     `equalExceptVolatile` 把 volatile 字段一律视为相等，于是纯 volatile
 *     改动走 `_commitVolatile()` → `updateVolatile()` 把新快照原地写进引用；
 *  3. 已解析 config 里这类字段是 cosmokit 的**引用对象**
 *     `{ get(), [Symbol.for("cosmokit.volatile.write")] }`——不是值。
 *
 * `.volatile()` 只有 0.2.0 的 schemastery 有，0.1.x 上调用会抛
 * `schema.volatile is not a function`，所以按可用性调用。在 0.1.x 上它退化成
 * 普通字段：没有引用、没有热更新，行为与改动前完全一致。
 */
const live = (schema) => (typeof schema?.volatile === "function" ? schema.volatile() : schema);

/**
 * cosmokit 的 volatile 引用协议标记。用 `Symbol.for` 注册，所以跨 ESM/CJS
 * 副本也能识别，不依赖是否 import 到同一个 cosmokit 实例。
 */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/** 判定一个已解析的 config 值是不是 volatile 引用（而不是普通值）。
 * 引用被 `Object.freeze` 冻住、只有一个函数属性 `get` 和一个 symbol 属性，
 * 所以 `JSON.stringify(ref)` 得到 `{}`——它看起来像空对象，但值一直都在，
 * 任何「值检查」都必须先 `.get()` 摊平再判断。 */
function isVolatileRef(value) {
	return typeof value === "object" && value !== null && VOLATILE_WRITE in value;
}

/**
 * 把已解析 Config 里的 volatile 引用摊平成**当时的**快照值。
 *
 * 引用是「稳定引用、可变快照」：loader 在只改 volatile 字段时会原地写入新
 * 快照而不重载插件。所以摊平结果只对一次操作有效，长期持有会看到过期值——
 * 需要实时读的地方用 `installLiveGetters`，不要用本函数的结果做长期缓存。
 */
export function materializeConfig(value) {
	if (isVolatileRef(value)) return materializeConfig(value.get());
	if (Array.isArray(value)) return value.map(materializeConfig);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, materializeConfig(child)]));
	}
	return value;
}

/**
 * entry Config 里标了 volatile 的顶层字段 → 运行配置里的实际位置。
 *
 * 设置表单编辑的是前者（顶层），插件读的是后者（`cfg.ai.*`），两者由
 * `installLiveGetters` 接起来。`sessionOverrides` 不入此表：它是 mode 命令
 * 写入状态的镜像，`makeModeStore` 启动时即复制进内存 Map，引用语义不适用。
 */
const LIVE_FIELDS = [
	// 默认审批模式：设置页可选（manual / ai / ai-auto），改动**热生效、不重载插件**。
	// `resolveMode()`（会话覆盖优先）在每次审批请求里都读 `cfg.mode`，而这里是把它接成
	// getter，所以改完的下一个请求就走新模式；`/approval-mode` 显示的「配置默认」同源。
	["mode", ["mode"]],
	["provider", ["ai", "provider"]],
	["model", ["ai", "model"]],
	["fallbacks", ["ai", "fallbacks"]],
	["riskTolerance", ["ai", "riskTolerance"]],
	["failOpen", ["ai", "failOpen"]],
	["timeoutMs", ["ai", "timeoutMs"]],
	["maxTokens", ["ai", "maxTokens"]],
	// 会话骨架：设置页改动即刻生效（不重载插件）。
	["transcript", ["transcript"]],
	["transcriptMaxChars", ["transcriptMaxChars"]],
	["denyFeedback", ["denyFeedback"]]
];

/**
 * 把 `cfg` 上的 live 字段接成 getter：读取时实时从 volatile 引用取快照。
 *
 * 全部读取点（`createHandler` 的 `cfg.x`、`makeLlmRunner` 的 `getConfig()`、
 * `makeDenialInjector` / `makeGetLocale` 的 `current.x`）都是「每次访问才读」，
 * 所以装 getter 后**一行读点都不用改**，设置页改动即刻生效。
 *
 * **判据只有一条：引用值是不是 `undefined`。** 这依赖 `Config` 的设计约定——
 * 标量 volatile 字段不带默认值（`undefined` = patch 里没写过），数组字段带默认值
 * （default 数组 = 没写过，`[]` = 用户显式清空）。
 *
 * 之前两版在这里放过更复杂的判据，都被审查打回：
 *   - 「引用值等于 schema 默认值就回落到静态值」→ 用户改回默认值不生效，
 *     用户以为收紧了、运行期仍按旧值放宽审批；
 *   - 「查 patch 里显式写过的键集合」→ `_commitVolatile()` 在所有引用快照都相等时
 *     不发事件，缓存会过期；且拿不到来源时按「全部显式」降级会让 schema 默认值
 *     覆盖旧嵌套 `ai.*`，同样是静默放宽。
 * 数据自身可区分之后，这些推断连同它们的时序依赖一起消失了。
 *
 * @param cfg - 已 normalize 的运行配置（会被就地改写）
 * @param source - `apply()` 收到的原始 userConfig（volatile 字段是引用）
 * @returns 同一个 cfg 对象
 */
export function installLiveGetters(cfg, source, baseline = undefined) {
	for (const [refKey, path] of LIVE_FIELDS) {
		const ref = source?.[refKey];
		if (!isVolatileRef(ref)) continue; // 0.1.x 或字段未声明：保持静态值
		const leafKey = path[path.length - 1];
		const host = path.slice(0, -1).reduce((node, key) => node?.[key], cfg);
		if (host === null || typeof host !== "object") continue;
		// 兜底值取自**基线装配**（只含旧嵌套 `ai.*` 与内置默认，不含顶层显式值）：
		//   - 用 `cfg` 上装配期的静态值不行——那可能正是启动时从 patch 读到的旧配置，
		//     用户删掉字段后「恢复」它等于撤销用户的删除；
		//   - 用内置默认值也不行——那会把装配期从 nested `ai.*` 修正出来的值打回去
		//     （实测 `Config({ ai: { riskTolerance: "low" } })` 又被兜回 `medium`）。
		const fallbackHost = baseline === undefined
			? host
			: path.slice(0, -1).reduce((node, key) => node?.[key], baseline);
		const fallback = fallbackHost?.[leafKey] ?? host[leafKey];
		Object.defineProperty(host, leafKey, {
			enumerable: true,
			configurable: true,
			get() {
				const liveValue = materializeConfig(ref.get());
				// 用 `??` 而不是只判 `undefined`：schemastery 对**无 default 且非 required**
				// 的字段会接受 `null`（实测 `Config({ timeoutMs: null }).timeoutMs.get()`
				// 就是 `null`），只判 undefined 会让运行值变成 null —— `timeoutMs: null`
				// 会让模型调用在发出请求前抛错，进而触发放行。
				return liveValue ?? fallback;
			}
		});
	}
	return cfg;
}

/** User-editable model and policy settings, separate from per-session mode overrides. */
export const CONFIG_SETTINGS_NAMESPACE = "dsh-codex-approval-config";
export const CONFIG_SETTINGS_SCHEMA = z.object({
	// 默认审批模式。字段名与 entry Config 的顶层键一致（0.2.0 设置页读写的就是后者）：
	// 两版的可编辑字段同名，客户端卡片才能用一份代码同时服务两条设置路径。
	mode: z.union(MODES).default(DEFAULT_CONFIG.mode),
	provider: z.string().default(DEFAULT_CONFIG.ai.provider),
	model: z.string().default(DEFAULT_CONFIG.ai.model),
	fallbacks: z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) })).max(MAX_FALLBACKS).default(DEFAULT_CONFIG.ai.fallbacks),
	riskTolerance: z.union(TOLERANCES).default(DEFAULT_CONFIG.ai.riskTolerance),
	failOpen: z.union(ACTIONS).default(DEFAULT_CONFIG.ai.failOpen),
	timeoutMs: z.number().step(1).min(1).default(DEFAULT_CONFIG.ai.timeoutMs),
	maxTokens: z.number().step(1).min(1).default(DEFAULT_CONFIG.ai.maxTokens),
	transcript: z.union(["off", "short"]).default(DEFAULT_CONFIG.transcript),
	transcriptMaxChars: z.number().step(1).min(100).max(16_000).default(DEFAULT_CONFIG.transcriptMaxChars),
	denyFeedback: z.boolean().default(DEFAULT_CONFIG.denyFeedback)
});

/**
 * Cordis plugin Config —— 0.2.0 起插件的可编辑设置由本导出派生为设置表单。
 *
 * 设计原则：**运行期只认「值是否存在」，不做任何来源推断。**
 *
 * 前五轮审查打回的所有 major 几乎都出在推断上——先按「值是否等于默认值」判、再按
 * 「patch 里的显式键集合」判：前者让「改回默认值」失效，后者受 `_commitVolatile()`
 * 不发事件的影响而缓存过期、且拿不到来源时的降级方向会静默放宽审批。
 *
 * **标量一律不带 `.default()`**：默认值一旦注入，顶层字段就「恒有值」，
 * `applyConfigSettings` 里读旧嵌套 `ai.*` 的 `pick()` 分支便永远轮不到（实测
 * `Config({ ai: { riskTolerance: "low" } })` 的顶层值直接是 `medium`），旧配置里更
 * 严格的策略会被静默放宽。`undefined` 才是「没配过」的唯一可靠表达。两个代价各有对应：
 *  - `null` 不被回填 → 由 getter 的 `liveValue ?? fallback` 兜底；
 *  - 表单没有初始值可显示 → 由客户端 `primaryProvider` / `primaryModel` 兜底。
 *
 * **数组保留 default**：schemastery 对**无默认值的 array** 会返回 `[]` 而不是
 * `undefined`，那样「用户显式清空 `[]`」与「没配过」就分不开了。已知限制：顶层数组的
 * default 目前仍会遮住旧嵌套 `ai.fallbacks`（见 README「六之五」的已知限制一节）。
 *
 * 运行期字段（enabled/locale/fallback）保持普通字段 + 默认值：它们不进设置
 * 表单，改动它们会让 loader 走普通更新路径（重载插件），这正是期望行为。
 *
 * `mode`（默认审批模式）是这条规则唯一的例外，且**必须**是 volatile（live）：
 * 0.2.0 设置页写回 entry config 时，宿主按 `isVolatilePath()` 逐路径校验，非 volatile
 * 字段的写入会被直接拒绝（`Config field "mode" is not volatile`），所以想让用户能在
 * 设置页选默认模式，就只能走 live 通道。它同时是 `.default()` 的例外——其余标量不带
 * 默认值的理由是「默认值注入会让顶层恒有值，`applyConfigSettings` 里回退读旧嵌套
 * `ai.*` 的分支永远轮不到」；`mode` 从不参与那条回退（它一直只在顶层），默认值不会
 * 遮蔽任何更严格的旧配置，而带默认值反而让设置表单里这一行恒有值可显示。
 */
export const Config = z.object({
	enabled: z.boolean().default(DEFAULT_CONFIG.enabled),
	mode: live(z.union(MODES).default(DEFAULT_CONFIG.mode)),
	locale: z.union(["auto", "zh", "en"]).default(DEFAULT_CONFIG.locale),
	fallback: z.union(ACTIONS).default(DEFAULT_CONFIG.fallback),
	// **标量一律不带 `.default()`**：默认值一旦注入，顶层字段就「恒有值」，
	// `pick()` 里的旧嵌套 `ai.*` 分支便永远轮不到（实测 `Config({ ai: { riskTolerance: "low" } })`
	// 的顶层引用值直接是 `medium`），于是旧配置里更严格的策略被静默放宽。
	// `undefined` 是「没配过」的唯一可靠表达；默认值由装配期的 `??` 与 getter 兜底。
	provider: live(z.string()),
	model: live(z.string()),
	fallbacks: live(z.array(z.object({
		provider: z.string().min(1),
		model: z.string().min(1)
	})).max(MAX_FALLBACKS).default(DEFAULT_CONFIG.ai.fallbacks)),
	riskTolerance: live(z.union(TOLERANCES)),
	failOpen: live(z.union(ACTIONS)),
	timeoutMs: live(z.number().step(1).min(1)),
	maxTokens: live(z.number().step(1).min(1)),
	// 会话骨架（判定输入里的 [U]/[T]/[D]/[W] 行）：off = 零上下文，short = 有界两级窗口。
	// 两项都进设置表单且可热改（live）——它只改变判定**输入**，不改变任何权限判定。
	transcript: live(z.union(["off", "short"])),
	transcriptMaxChars: live(z.number().step(1).min(100).max(16_000)),
	// 三项无人值守红线：**写死 deny**，不接受配置，也不进设置表单。
	// 理由：无人可问时非 deny 的取值等价于「直接给这次调用完全权限」——`allow` 是放行，
	// `ask` 在 ai-auto 下还会被别的分支吸收成放行。要放开权限，正确层位是宿主的权限/
	// 沙箱授予（例如直接跑完全权限、无沙箱），不是在审批闸门里把红线拆掉。
	// schema 只接受 "deny"：patch 里写了别的值会在装配期直接失败，而不是被静默忽略。
	mode3OnAsk: z.union(["deny"]).default("deny"),
	hardAskOnUnattended: z.union(["deny"]).default("deny"),
	enforcedAskOnUnattended: z.union(["deny"]).default("deny"),
	totalBudgetMs: live(z.number().step(1).min(0)),
	evidenceFetch: live(z.union(EVIDENCE_FETCH)),
	evidenceMaxFiles: live(z.number().step(1).min(1)),
	evidenceMaxBytes: live(z.number().step(1).min(256)),
	denyFeedback: live(z.boolean()),
	denialBreaker: live(z.object({
		consecutive: z.number().step(1).min(0),
		duplicate: z.number().step(1).min(0),
		cooldownMs: z.number().step(1).min(0)
	})),
	sessionOverrides: live(z.dict(z.union(MODES)).default({}))
});

/** 判定运行时的 settings 服务是不是 0.2.0 的 SettingsForms。两版服务都叫 settings
 * 且都有 register，只能靠方法集差集区分（0.2.0 独有 importLegacyDocument）。 */
function usesEntryConfigSettings(settings) {
	return typeof settings?.importLegacyDocument === "function";
}

function assertConfig(cfg) {
	if (typeof cfg !== "object" || cfg === null) throw new TypeError("dsh-codex-approval: config must be an object");
	if (typeof cfg.enabled !== "boolean") throw new TypeError("dsh-codex-approval: config.enabled must be a boolean");
	if (!MODES.includes(cfg.mode)) throw new TypeError(`dsh-codex-approval: config.mode must be one of ${MODES.join("/")}`);
	// 三项无人值守红线写死 deny。报错要指向「该在哪一层放开」，否则用户只会以为
	// 配置写错了，然后去找下一个能放宽的开关。
	if (cfg.mode3OnAsk !== "deny") throw new TypeError("dsh-codex-approval: config.mode3OnAsk is a fixed red line and only accepts deny — 无人值守时放开权限请改宿主权限层（完全权限/无沙箱），不要拆审批红线");
	if (!["auto", "zh", "en"].includes(cfg.locale)) throw new TypeError("dsh-codex-approval: config.locale must be auto/zh/en");
	if (!Array.isArray(cfg.rules)) throw new TypeError("dsh-codex-approval: config.rules must be an array");
	for (const rule of cfg.rules) {
		if (rule === null || typeof rule !== "object") throw new TypeError("dsh-codex-approval: each rule must be an object");
		if (!ACTIONS.includes(rule.action)) throw new TypeError(`dsh-codex-approval: rule action must be one of ${ACTIONS.join("/")}`);
		// `hardAsk` means "this ask needs the human, and an unattended mode may not
		// resolve it away". On an allow rule the marker would be silently ignored —
		// and it would read as "a human confirmed this", the opposite of its
		// meaning. Checked here so it covers BOTH rule shapes (structured
		// `tool`/`pattern` rules return early below).
		if (rule.hardAsk !== void 0 && typeof rule.hardAsk !== "boolean") throw new TypeError("dsh-codex-approval: rule.hardAsk must be a boolean");
		if (rule.hardAsk === true && rule.action !== "ask") {
			throw new TypeError("dsh-codex-approval: rule.hardAsk is only meaningful on an ask rule");
		}
		// Two options tune a glob rule itself. Both are checked here so they
		// cannot reach a structured rule (whose argv comparison is already
		// exact) or an allow (where widening is the failure mode):
		//   - `caseSensitive` keeps `git branch -D` apart from `git branch -d`;
		//   - `unless` is the rule's own exception, and it can only narrow a
		//     deny/ask rule — on an allow it would widen a silent approval.
		const structured = Array.isArray(rule.pattern) || typeof rule.tool === "string";
		if (rule.caseSensitive !== void 0 && typeof rule.caseSensitive !== "boolean") {
			throw new TypeError("dsh-codex-approval: rule.caseSensitive must be a boolean");
		}
		if (rule.unless !== void 0) {
			const patterns = Array.isArray(rule.unless) ? rule.unless : [rule.unless];
			if (patterns.length === 0 || !patterns.every((pattern) => typeof pattern === "string" && pattern !== "")) {
				throw new TypeError("dsh-codex-approval: rule.unless must be a non-empty string or a list of them");
			}
			if (structured) throw new TypeError("dsh-codex-approval: rule.unless is a glob option and does not apply to a structured rule");
			if (rule.action === "allow") throw new TypeError("dsh-codex-approval: rule.unless can only narrow a deny/ask rule — on an allow it would widen it");
		}
		if (structured && rule.caseSensitive !== void 0) {
			throw new TypeError("dsh-codex-approval: rule.caseSensitive is a glob option and does not apply to a structured rule");
		}
		if (structured) {
			// structured argv-prefix rule (Codex `prefix_rule` style)
			if (typeof rule.tool !== "string" || rule.tool === "") throw new TypeError("dsh-codex-approval: a structured rule needs a non-empty tool");
			// A `flagGuard` rule is judged on the argv, so it carries no pattern —
			// and it is a strictness-only guard: on an `allow` it would authorize
			// the very shape it exists to catch, so it is refused here instead of
			// being silently honored.
			if (rule.flagGuard !== void 0) {
				if (!FLAG_GUARDS.includes(rule.flagGuard)) {
					throw new TypeError(`dsh-codex-approval: rule.flagGuard must be one of ${FLAG_GUARDS.join("/")}`);
				}
				if (rule.pattern !== void 0) throw new TypeError("dsh-codex-approval: a flagGuard rule takes no pattern — it is judged on the argv");
				if (rule.action === "allow") throw new TypeError("dsh-codex-approval: rule.flagGuard is a strictness guard and cannot sit on an allow rule");
				if (rule.forbidOptions !== void 0 || rule.pathGuard !== void 0 || rule.configGuard !== void 0) {
					throw new TypeError("dsh-codex-approval: rule.flagGuard does not combine with forbidOptions / pathGuard / configGuard");
				}
				continue;
			}
			if (!Array.isArray(rule.pattern) || rule.pattern.length === 0 || !rule.pattern.every((part) => typeof part === "string" && part !== "")) {
				throw new TypeError("dsh-codex-approval: a structured rule needs a non-empty string pattern");
			}
			if (rule.forbidOptions !== void 0 && (!Array.isArray(rule.forbidOptions) || !rule.forbidOptions.every((option) => typeof option === "string" && option !== ""))) {
				throw new TypeError("dsh-codex-approval: rule.forbidOptions must be a list of non-empty strings");
			}
			if (rule.pathGuard !== void 0 && rule.pathGuard !== "workspace-relative") {
				throw new TypeError("dsh-codex-approval: rule.pathGuard must be \"workspace-relative\"");
			}
			if (rule.configGuard !== void 0 && rule.configGuard !== "git-clean") {
				throw new TypeError("dsh-codex-approval: rule.configGuard must be \"git-clean\"");
			}
			continue;
		}
		if (typeof rule.match !== "string" || rule.match === "") throw new TypeError("dsh-codex-approval: each rule needs a non-empty match");
	}
	if (typeof cfg.ai !== "object" || cfg.ai === null) throw new TypeError("dsh-codex-approval: config.ai must be an object");
	if (typeof cfg.ai.enabled !== "boolean") throw new TypeError("dsh-codex-approval: config.ai.enabled must be a boolean");
	// The AI layer's own routing and timing. These are the switches for "is the
	// judge alive at all", and until now none of them was checked: `ai.provider:
	// ""` made every `prepareCall` throw (swallowed into `failOpen`), and a
	// non-numeric `ai.timeoutMs` — YAML `timeoutMs: "15s"` is a common way to
	// write it — reached `AbortSignal.timeout()`, which throws on anything that
	// is not a non-negative integer. `fallbacks` entries were validated at both
	// levels while the primary route was not.
	if (typeof cfg.ai.provider !== "string" || cfg.ai.provider === "") {
		throw new TypeError("dsh-codex-approval: config.ai.provider must be a non-empty string");
	}
	if (typeof cfg.ai.model !== "string" || cfg.ai.model === "") {
		throw new TypeError("dsh-codex-approval: config.ai.model must be a non-empty string");
	}
	if (!Number.isSafeInteger(cfg.ai.timeoutMs) || cfg.ai.timeoutMs < 1 || cfg.ai.timeoutMs > 600_000) {
		throw new TypeError("dsh-codex-approval: config.ai.timeoutMs must be an integer in 1..600000");
	}
	if (!Number.isSafeInteger(cfg.ai.maxTokens) || cfg.ai.maxTokens < 1 || cfg.ai.maxTokens > 32_768) {
		throw new TypeError("dsh-codex-approval: config.ai.maxTokens must be an integer in 1..32768");
	}
	if (!TOLERANCES.includes(cfg.ai.riskTolerance)) throw new TypeError(`dsh-codex-approval: config.ai.riskTolerance must be one of ${TOLERANCES.join("/")}`);
	if (!ACTIONS.includes(cfg.ai.failOpen)) throw new TypeError("dsh-codex-approval: config.ai.failOpen must be allow/ask/deny");
	if (!Number.isSafeInteger(cfg.ai.maxJudgeCommandChars) || cfg.ai.maxJudgeCommandChars < 200 || cfg.ai.maxJudgeCommandChars > 200_000) {
		throw new TypeError("dsh-codex-approval: config.ai.maxJudgeCommandChars must be an integer in 200..200000");
	}
	if (cfg.ai.hardAskOnUnattended !== "deny") throw new TypeError("dsh-codex-approval: config.ai.hardAskOnUnattended is a fixed red line and only accepts deny — 放开权限请改宿主权限层");
	if (cfg.ai.enforcedAskOnUnattended !== "deny") throw new TypeError("dsh-codex-approval: config.ai.enforcedAskOnUnattended is a fixed red line and only accepts deny — 放开权限请改宿主权限层");
	if (!Number.isSafeInteger(cfg.ai.totalBudgetMs) || cfg.ai.totalBudgetMs < 0 || cfg.ai.totalBudgetMs > 600_000) {
		throw new TypeError("dsh-codex-approval: config.ai.totalBudgetMs must be an integer in 0..600000");
	}
	if (!EVIDENCE_FETCH.includes(cfg.ai.evidenceFetch)) throw new TypeError(`dsh-codex-approval: config.ai.evidenceFetch must be one of ${EVIDENCE_FETCH.join("/")}`);
	if (!Number.isSafeInteger(cfg.ai.evidenceMaxFiles) || cfg.ai.evidenceMaxFiles < 1 || cfg.ai.evidenceMaxFiles > 8) {
		throw new TypeError("dsh-codex-approval: config.ai.evidenceMaxFiles must be an integer in 1..8");
	}
	if (!Number.isSafeInteger(cfg.ai.evidenceMaxBytes) || cfg.ai.evidenceMaxBytes < 256 || cfg.ai.evidenceMaxBytes > 512_000) {
		throw new TypeError("dsh-codex-approval: config.ai.evidenceMaxBytes must be an integer in 256..512000");
	}
	if (!Array.isArray(cfg.ai.fallbacks)) throw new TypeError("dsh-codex-approval: config.ai.fallbacks must be an array");	if (cfg.ai.fallbacks.length > MAX_FALLBACKS) throw new TypeError(`dsh-codex-approval: config.ai.fallbacks must hold at most ${MAX_FALLBACKS} entries`);
	for (const entry of cfg.ai.fallbacks) {
		if (typeof entry?.provider !== "string" || entry.provider === "" || typeof entry?.model !== "string" || entry.model === "") {
			throw new TypeError("dsh-codex-approval: each ai.fallbacks entry needs a non-empty provider and model");
		}
	}
	if (!ACTIONS.includes(cfg.fallback)) throw new TypeError("dsh-codex-approval: config.fallback must be allow/ask/deny");
	if (typeof cfg.denyFeedback !== "boolean") throw new TypeError("dsh-codex-approval: config.denyFeedback must be a boolean");
	if (typeof cfg.denialBreaker !== "object" || cfg.denialBreaker === null) throw new TypeError("dsh-codex-approval: config.denialBreaker must be an object");
	for (const key of ["consecutive", "duplicate", "cooldownMs"]) {
		const value = cfg.denialBreaker[key];
		if (!Number.isSafeInteger(value) || value < 0 || value > 86_400_000) {
			throw new TypeError(`dsh-codex-approval: config.denialBreaker.${key} must be an integer in 0..86400000`);
		}
	}
	if (!Number.isSafeInteger(cfg.denyFeedbackMax) || cfg.denyFeedbackMax < 1 || cfg.denyFeedbackMax > 10) {
		throw new TypeError("dsh-codex-approval: config.denyFeedbackMax must be an integer in 1..10");
	}
	if (!["off", "short"].includes(cfg.transcript)) throw new TypeError("dsh-codex-approval: config.transcript must be off/short");
	if (!Number.isSafeInteger(cfg.transcriptMaxChars) || cfg.transcriptMaxChars < 100 || cfg.transcriptMaxChars > 16000) {
		throw new TypeError("dsh-codex-approval: config.transcriptMaxChars must be an integer in 100..16000");
	}
	if (typeof cfg.logFile !== "string" || cfg.logFile === "") throw new TypeError("dsh-codex-approval: config.logFile must be a non-empty path");
	if (!Number.isSafeInteger(cfg.logMaxBytes) || cfg.logMaxBytes < 0) throw new TypeError("dsh-codex-approval: config.logMaxBytes must be a non-negative integer");
}

/** Deep-merge user config over defaults (ai sub-object merged). */
export function normalizeConfig(userConfig) {
	const cfg = {
		...DEFAULT_CONFIG,
		...(userConfig ?? {}),
		ai: { ...DEFAULT_CONFIG.ai, ...(userConfig?.ai ?? {}) },
		// An explicitly empty list means "no rules" — it must not silently be
		// replaced by the defaults, or a user who wants everything judged by the
		// AI keeps the default auto-approvals (and the escapes that came with
		// them). Only an absent `rules` key falls back to the defaults.
		rules: Array.isArray(userConfig?.rules) ? userConfig.rules : DEFAULT_CONFIG.rules
	};
	assertConfig(cfg);
	return cfg;
}

/**
 * Project the user-editable settings namespace onto a full plugin config.
 *
 * 判据只有一条 `??`：`undefined` 表示「patch 里没写过这个字段」。这能成立，是因为
 * `Config` 里标量 volatile 字段不带默认值、数组字段的默认值本身承载「未配置」语义
 * —— 见 `Config` 上方的设计说明。
 *
 * 之前这里要推断「顶层值 vs 旧嵌套 `ai.*` 谁优先」，因为 schema 注入的默认值让
 * 「顶层有值」不再等于「用户配过」；现在数据自身可区分，推断连同它的两个 helper
 * (`sameAsDefault` / `pickConfigured`) 一起删掉了。
 */
export function applyConfigSettings(baseConfig, settings) {
	// 只让**有值**的字段覆盖基线。`undefined` 表示「patch 里没写过这个字段」，
	// 直接 spread（`{ ...baseConfig, ...settings }`）会用它覆盖掉默认值——这正是
	// 装配期最容易踩的坑：`assertConfig` 会在 `mode3OnAsk` 变成 undefined 时直接拒绝。
	const merged = { ...baseConfig };
	for (const [key, value] of Object.entries(settings ?? {})) {
		if (value !== void 0) merged[key] = value;
	}
	const baseAi = baseConfig.ai ?? {};
	// 顶层字段的读取顺序：**顶层 → 旧嵌套 `ai.*` → 内置默认**。
	//
	// 第二级是给尚未迁移的旧配置留的退路：把可编辑字段从 `ai.*` 搬到顶层时，
	// 只搬了「写」，漏了「读」，于是 profile patch 里若还留着 `ai.riskTolerance: low`
	// 会被静默忽略、退回默认的 `medium` —— 又是一次放宽审批的静默变更。
	// 这里只是**回退读取**，不是原先那种来源推断：没有默认值参与，`undefined`
	// 就是「没写过」，三级都缺才用内置默认。
	const pick = (key, fallback) => settings?.[key] ?? settings?.ai?.[key] ?? fallback;
	// The breaker is the one nested object here, so it is picked key by key: the
	// schema answers with `{}` (not `undefined`) for an object it never saw, and
	// a partial object must not resurrect a default for the keys it does carry.
	const pickBreaker = (key, fallback) => settings?.denialBreaker?.[key] ?? fallback;
	return normalizeConfig({
		...merged,
		// 三项无人值守红线写死 deny：旧 settings 文档或旧 patch 里留下的 ask/allow
		// 一律不进入运行配置——放开权限的正确层位是宿主权限/沙箱授予。
		mode3OnAsk: "deny",
		transcript: pick("transcript", baseConfig.transcript),
		transcriptMaxChars: pick("transcriptMaxChars", baseConfig.transcriptMaxChars),
		denyFeedback: pick("denyFeedback", baseConfig.denyFeedback),
		denialBreaker: {
			consecutive: pickBreaker("consecutive", baseConfig.denialBreaker.consecutive),
			duplicate: pickBreaker("duplicate", baseConfig.denialBreaker.duplicate),
			cooldownMs: pickBreaker("cooldownMs", baseConfig.denialBreaker.cooldownMs)
		},
		ai: {
			...baseAi,
			// **先完整合并调用方传来的 `ai`**（含没有搬到顶层的那些字段：`enabled`、
			// `maxPromptChars`、`maxJudgeCommandChars`、`denyFeedbackMax`、`transcript`…）。
			// 只展开 `baseAi` 会把它们全丢掉：patch 里 `ai.enabled: false` 会变成默认的
			// `true`（**AI 被静默重新启用**），`maxJudgeCommandChars: 200` 会变成 8000
			// （证据长度限制放宽 40 倍，超长命令不再走「证据不足」分支）。
			...(settings?.ai ?? {}),
			provider: pick("provider", baseAi.provider),
			model: pick("model", baseAi.model),
			fallbacks: pick("fallbacks", baseAi.fallbacks),
			riskTolerance: pick("riskTolerance", baseAi.riskTolerance),
			failOpen: pick("failOpen", baseAi.failOpen),
			timeoutMs: pick("timeoutMs", baseAi.timeoutMs),
			maxTokens: pick("maxTokens", baseAi.maxTokens),
			hardAskOnUnattended: "deny",
			enforcedAskOnUnattended: "deny",
			totalBudgetMs: pick("totalBudgetMs", baseAi.totalBudgetMs),
			evidenceFetch: pick("evidenceFetch", baseAi.evidenceFetch),
			evidenceMaxFiles: pick("evidenceMaxFiles", baseAi.evidenceMaxFiles),
			evidenceMaxBytes: pick("evidenceMaxBytes", baseAi.evidenceMaxBytes)
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
/** Display cap for the `argsPreview` field of the audit record. */
const ARGS_PREVIEW_MAX_CHARS = 300;
/** Display cap for the command text embedded in the denial feedback. */
const DENIAL_COMMAND_MAX_CHARS = 200;

// `redactSensitive` / `boundedText` live in redact.js now: the same boundary has
// to cover the judge prompt, the audit record, the denial feedback and provider
// failure diagnostics, not just the last one.

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

/**
 * One judge attempt against a single provider/model pair, bounded by timeout.
 *
 * The stream can end in three distinct states, and the caller needs to tell
 * them apart:
 *   1. a `finish` chunk reporting `error`/`aborted` → `ok:false` + `finishKind`
 *      + `failure` (the pre-existing transport-failure shape, unchanged);
 *   2. the stream ends without any `finish` chunk — an `AbortSignal` cutoff or
 *      a dropped connection — which is flagged `endedWithoutFinish` so an empty
 *      reply can be told apart from "the provider answered with nothing";
 *   3. a normal ending (`finish` with `stop`/`length`/…).
 *
 * States 2 and 3 both return `ok:true` with the collected text: whether that
 * text is a *usable* verdict is decided by the chain (see makeLlmRunner), not
 * here — an empty reply is a candidate failure, not a successful attempt.
 * `textChars` is the diagnostic count of what actually arrived.
 */
async function attemptJudge(llm, candidate, { messages, signal, sessionId, timeoutMs, maxTokens }) {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const combined = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const run = (async () => {
	try {
		const prepared = await llm.prepareCall({ provider: candidate.provider, model: candidate.model, temperature: 0, maxTokens }, combined);
		let text = "";
		let sawFinish = false;
		for await (const chunk of prepared.stream({
			...prepared.config,
			messages,
			signal: combined,
			...sessionId === undefined ? {} : { sessionId }
		})) {
			if (chunk.type === "text-delta") text += chunk.text;
			else if (chunk.type === "finish") {
				if (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted") {
					const failure = normalizeFailure(chunk.reason);
					return {
						ok: false,
						finishKind: chunk.reason.kind,
						...failure === undefined ? {} : { failure },
						error: formatFailureError(chunk.reason.kind, failure)
					};
				}
				sawFinish = true;
			}
		}
		return {
			ok: true,
			text,
			textChars: text.length,
			...sawFinish ? {} : { endedWithoutFinish: true }
		};
	} catch (error) {
		const message = boundedText(error?.message ?? String(error), FAILURE_MESSAGE_MAX_CHARS) ?? "LLM judge failed";
		return { ok: false, error: message };
	}
	})();
	// The abort signal only stops an adapter that honours it. A stream that ignores
	// it would park the approval forever, so the attempt also races its own timer
	// (with a small grace, so a normal abort wins the race and keeps its report).
	let timer;
	try {
		return await Promise.race([
			run,
			new Promise((resolve) => {
				timer = setTimeout(() => resolve({
					ok: false,
					error: `judge attempt did not finish within ${timeoutMs}ms`,
					finishKind: "timeout",
					hardTimeout: true
				}), timeoutMs + HARD_TIMEOUT_GRACE_MS);
				timer.unref?.();
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Turn a candidate's unusable reply into the chain-failure record. Two shapes
 * are distinguished for the audit log: an empty/whitespace reply (the model
 * emitted no text at all) and a reply that carried text with no parseable
 * verdict. `textChars` and `endedWithoutFinish` are diagnostics only — the
 * truncated, redacted `rawText` keeps the pre-existing handling.
 */
function unparseableFailure(result) {
	const text = typeof result.text === "string" ? result.text : "";
	return {
		ok: false,
		error: text.trim() === ""
			? "unparseable judge output (empty reply)"
			: "unparseable judge output (no verdict)",
		rawText: redactSensitive(text).slice(0, 500),
		textChars: text.length,
		...result.endedWithoutFinish === true ? { endedWithoutFinish: true } : {}
	};
}

/**
 * The ordered judge runner: the configured provider/model first, then every
 * `ai.fallbacks` entry, deduplicated by pair. One timeout-bounded attempt runs
 * per candidate and the chain advances on provider failure (auth, quota,
 * upstream 5xx, transport, timeout) — a retired subscription or a cooled-down
 * route degrades to the next judge instead of disabling the AI layer — and on
 * an **unusable reply**: empty text, or text without a parseable verdict. That
 * second case is not cosmetic: a model that streams nothing used to count as a
 * *successful* attempt, which ended the chain on an empty string and left the
 * configured fallbacks unspent (audited as `ai-error` with an empty
 * `rawOutput`). A candidate only wins by returning a verdict `parseVerdict`
 * accepts.
 *
 * When every candidate fails the primary's failure is reported — it is the
 * configured intent — annotated with how many were tried. A single-candidate
 * chain keeps the pre-fallback result shape exactly (no `judge*` fields), and
 * a candidate is never retried: the judge sits on the approval critical path,
 * where an extra model call is latency the user pays.
 */
/**
 * The budget one approval really gets.
 *
 * `ai.totalBudgetMs` is a hard ceiling, and the chain still stops when it runs
 * out. But a ceiling SHORTER than one candidate's own timeout cannot express
 * what the deployment asked for: `attemptJudge` clips each candidate to what
 * the budget has left, so a primary that hangs consumes all of it and the
 * configured `fallbacks` are never tried — the failure mode a fallback chain
 * exists for. Measured on this machine before the fix: `timeoutMs: 60000`
 * against the default `totalBudgetMs: 30000`, `judgeAttempts` = 1 in all 82
 * records that carried it, `judgeFallbackFrom` = 0.
 *
 * The ceiling is therefore lifted to what one full attempt per candidate needs
 * — the deployment already consented to that wait by setting `timeoutMs`. The
 * configured value is never lowered, and `0` still disables the budget.
 * @param ai - the effective `ai` config section
 * @returns the effective budget in milliseconds, or 0 when unbudgeted
 */
export function judgeBudgetMs(ai) {
	const total = ai?.totalBudgetMs;
	if (!Number.isSafeInteger(total) || total <= 0) return 0;
	const candidates = 1 + (Array.isArray(ai.fallbacks) ? ai.fallbacks.length : 0);
	const perCandidate = Number.isSafeInteger(ai.timeoutMs) && ai.timeoutMs > 0 ? ai.timeoutMs : 0;
	return Math.max(total, perCandidate * candidates);
}

export function makeLlmRunner(llm, configOrGetter) {
	const getConfig = typeof configOrGetter === "function" ? configOrGetter : () => configOrGetter;
	return async (messages, { signal, sessionId, deadline } = {}) => {
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
		let budgetExhausted = false;
		for (let index = 0; index < chain.length; index += 1) {
			// A cancelled approval must not spend further judge calls.
			if (signal?.aborted === true) break;
			const candidate = chain[index];
			// The whole approval shares one budget (`ai.totalBudgetMs`), and it is a
			// HARD ceiling: an attempt is capped by what is left, and when nothing is
			// left the chain stops. There is deliberately no minimum restamp — a
			// floor would let every attempt overrun the budget it was given.
			const left = deadline === undefined ? Number.POSITIVE_INFINITY : deadline - Date.now();
			if (left <= 0) {
				budgetExhausted = true;
				break;
			}
			const candidateTimeout = left === Number.POSITIVE_INFINITY ? timeoutMs : Math.min(timeoutMs, Math.max(1, Math.floor(left)));
			tried.push(`${candidate.provider}/${candidate.model}`);
			const result = await attemptJudge(llm, candidate, { messages, signal, sessionId, timeoutMs: candidateTimeout, maxTokens });
			if (result.ok === true && parseVerdict(result.text) !== null) {
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
			// Either a transport failure or a reply this candidate cannot be judged
			// on: both mean "this candidate did not answer", so the chain advances.
			// Only the primary's failure is kept (it is the configured intent).
			if (primaryFailure === undefined) {
				primaryFailure = result.ok === true ? unparseableFailure(result) : result;
			}
		}
		const failed = primaryFailure ?? {
			ok: false,
			error: budgetExhausted ? "judge budget exhausted before any attempt" : "judge cancelled before any attempt"
		};
		const withBudget = budgetExhausted ? { ...failed, budgetExhausted: true } : failed;
		if (tried.length <= 1) return withBudget;
		return { ...withBudget, judgeAttempts: tried.length, judgeTried: tried };
	};
}

/**
 * Why the request's evidence is not good enough to auto-decide, or null.
 *
 * Two cases are deliberately never resolved by the judge:
 *   - `arguments-unavailable`: the tool arguments could not be recovered (no
 *     event for the callId, unparseable JSON, or a shell call without a command
 *     string). Asking a model about `command: null` produced `allowed-once` in
 *     the audit — the program, not the model, has to refuse.
 *   - `command-too-long`: the operation exceeds the judge's command budget. A
 *     truncated operation must never be *approved on its prefix*; either the
 *     whole operation is judged or the request goes to the human.
 * @param args - the recovered tool arguments (or null)
 * @param toolName - the request's tool name
 * @param argsText - the full redacted arguments text
 * @param cfg - effective config (uses ai.maxJudgeCommandChars)
 */
export function evidenceProblem({ args, toolName, argsText, cfg }) {
	if (args === null || args === undefined) return "arguments-unavailable";
	if (isShellTool(toolName) && (typeof args.command !== "string" || args.command.trim() === "")) return "arguments-unavailable";
	if (typeof argsText === "string" && argsText.length > cfg.ai.maxJudgeCommandChars) return "command-too-long";
	return null;
}

/**
 * Signals that ONE command line does several materially different things —
 * fetching, executing, destroying. Two or more signals mean a human (and the
 * judge) cannot credibly confirm the whole effect from the text alone.
 */
/** Path-valued argument keys of non-shell tools (edit / write / patch families). */
const PATH_ARG_KEYS = Object.freeze(["file_path", "filePath", "path", "notebook_path", "target_file", "output_path"]);
/** …and the ones that carry a list of them. */
const PATH_ARG_LIST_KEYS = Object.freeze(["files", "paths", "file_paths"]);

/**
 * The path-valued arguments of a NON-shell tool call.
 *
 * The shell recogniser never sees these tools, so `command-facts.js` reports
 * nothing about them — which is why an `edit` / `write` call carried no
 * structural signal at all and every `pathGuard`-style option was unavailable
 * to its rules. This is the smallest thing that gives them one.
 * @param args - the recovered tool arguments
 * @param toolName - the request's tool name
 * @returns the trimmed path strings (possibly empty)
 */
export function toolPathArgs(args, toolName) {
	if (args === null || typeof args !== "object" || isShellTool(toolName)) return [];
	const out = [];
	const push = (value) => {
		if (typeof value === "string" && value.trim() !== "") out.push(value.trim());
	};
	for (const key of PATH_ARG_KEYS) push(args[key]);
	for (const key of PATH_ARG_LIST_KEYS) {
		const value = args[key];
		if (Array.isArray(value)) for (const item of value) push(item);
	}
	return out;
}

/**
 * Whether a call's own structure shows anything reaching outside the current
 * task's blast radius — the input the policy layer needs to decide whether the
 * judge's "I am not sure" may be resolved by the tolerance (see
 * `decidePolicy`'s `scope` option) instead of always going to a human.
 *
 * Everything here is derived from the CALL, never from the model's prose: the
 * structured facts recovered from the command text (`command-facts.js`, which
 * reports what it could not fit as `*Omitted`), the working directory the call
 * actually runs in, and — for tools the shell recogniser cannot see — the
 * path-valued arguments themselves.
 *
 * Fail-closed on unknowns: a call whose target cannot be recovered, or whose
 * workspace root is unknown, is NOT clean. "I could not tell" must never read
 * like "in scope", which is the same rule the evidence layer follows.
 *
 * This is not a security boundary — the sandbox and the rule layer are. It is
 * the difference between "the model was unsure about a workspace-local edit"
 * and "the model was unsure about something that leaves the workspace".
 *
 * @param opts - { toolName, args, textFacts, cwd, runsInsideWorkspace }
 * @returns { clean, reasons } — `clean` is true only with zero risk signals.
 */
export function actionScope({ toolName, args, textFacts, cwd, runsInsideWorkspace, escalationTo }) {
	const reasons = [];
	if (runsInsideWorkspace === false) reasons.push("executes-outside-workspace");
	// Widening the sandbox is itself an out-of-scope act: the call asks to leave
	// the boundary the session is confined to, whatever its command text looks
	// like. Without this, `ls` + `sandbox_permissions: danger-full-access` was
	// in-scope (the command carries no other signal) and could be auto-approved
	// on the judge's uncertainty — after the rule layer had already refused it.
	if (typeof escalationTo === "string" && escalationTo !== "") reasons.push("sandbox-escalation");
	if (isShellTool(toolName)) {
		if (textFacts !== null && typeof textFacts === "object") {
			if (Array.isArray(textFacts.paths) && textFacts.paths.some((entry) => entry?.outside === true)) {
				reasons.push("path-outside-workspace");
			}
			if (Array.isArray(textFacts.hosts) && textFacts.hosts.length > 0) reasons.push("network-target");
			if (Array.isArray(textFacts.destructive) && textFacts.destructive.length > 0) reasons.push("destructive-option");
			for (const key of ["pathsOmitted", "flagsOmitted", "hostsOmitted"]) {
				if (typeof textFacts[key] === "number" && textFacts[key] > 0) reasons.push(`facts-truncated:${key}`);
			}
		}
		return { clean: reasons.length === 0, reasons };
	}
	const paths = toolPathArgs(args, toolName);
	if (paths.length === 0) {
		reasons.push("target-unknown");
		return { clean: false, reasons };
	}
	if (typeof cwd !== "string" || cwd === "") {
		reasons.push("workspace-unknown");
		return { clean: false, reasons };
	}
	for (const path of paths) {
		const rel = relative(cwd, resolve(cwd, path));
		if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) reasons.push(`path-outside-workspace:${path}`);
	}
	return { clean: reasons.length === 0, reasons };
}

const SIDE_EFFECT_SIGNALS = [
	/\b(?:curl|wget|invoke-webrequest|iwr|start-bitstransfer)\b/i,
	/\|\s*(?:sh|bash|zsh|dash|python3?|node|perl|ruby|pwsh|powershell|iex)\b/i,
	/\b(?:sh|bash|zsh|dash|python3?|node|perl|ruby|pwsh|powershell)\b\s+(?:-[ce]\b|--command\b)/i,
	/\b(?:rm|rmdir|unlink|del|remove-item)\b/i,
	/\b(?:chmod|chown|chgrp|icacls|takeown)\b\s+-?\w*(?:r\b|-recurse)/i,
	/\b(?:mkfs|dd|format-volume)\b/i,
	/(?:>>?)\s*(?:\/etc\/|\/usr\/|\/var\/|c:\\windows)/i
];

/**
 * Whether one command line mixes several materially different side effects.
 * @param argsText - the full (redacted) arguments text
 */
export function mixedSideEffects(argsText) {
	if (typeof argsText !== "string" || argsText === "") return false;
	let hits = 0;
	for (const pattern of SIDE_EFFECT_SIGNALS) if (pattern.test(argsText)) hits += 1;
	return hits >= 2;
}

/**
 * Whether a denial should ask for a *materially safer re-submission* instead of
 * the plain "do not work around this" directive.
 *
 * Two cases qualify, and both are about the request being hard to review rather
 * than about its risk: a command over the judge's budget (nothing guarantees
 * what the truncated remainder does) and one that fetches, executes and cleans
 * up in the same line. Everything else — a rule `deny`, a judge `deny`, a
 * failed judge call, a repeated identical action — keeps the plain directive,
 * because there the fix is a different plan, not a clearer submission.
 *
 * This only changes the corrective copy. The decision itself is untouched.
 * @param verdict - the decided verdict
 * @param argsText - the full redacted arguments text
 * @param toolName - the tool that was called
 */
export function needsRestructure({ verdict, argsText, toolName }) {
	if (verdict === null || typeof verdict !== "object") return false;
	if (verdict.kind === "evidence-incomplete") return verdict.evidenceIncomplete === "command-too-long";
	// Only a judge's own refusal can be "not as written": a rule decision is
	// deterministic, a judge failure is an outage, and a breaker is a repeat —
	// none of them is a request the human could re-shape.
	if (verdict.kind !== "ai") return false;
	return isShellTool(toolName) && mixedSideEffects(argsText);
}

/**
 * The realpath containment check behind a `pathGuard: "workspace-relative"`
 * allow rule. The static check in rules.js only rejects what is obviously
 * outside (absolute paths, `~`, `..`, drive letters); this catches a path that
 * *looks* relative but resolves outside the root through a symlink.
 *
 * Every failure mode is a refusal: no root to compare against, a path that does
 * not resolve, or a target outside the root all mean "no auto-approval".
 *
 * @param args - the rule's path arguments (already filtered to positionals)
 * @param opts - { cwd, root, resolvePath } — `resolvePath` is injectable so the
 *   check is unit-testable without touching the filesystem.
 * @returns true when every argument resolves inside the workspace root.
 */
export async function pathGuardAllows(args, { cwd, root, resolvePath = realpath } = {}) {
	if (args.length === 0) return true;
	if (typeof root !== "string" || root === "") return false;
	let rootReal;
	try {
		rootReal = await resolvePath(root);
	} catch {
		return false;
	}
	for (const arg of args) {
		let argReal;
		try {
			argReal = await resolvePath(resolve(typeof cwd === "string" && cwd !== "" ? cwd : root, arg));
		} catch {
			return false;
		}
		const rel = relative(rootReal, argReal);
		if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) return false;
	}
	return true;
}

/**
 * Config keys that make a *read-only* git command run a program somebody else
 * named. `diff.external` and a textconv driver run with **no switch at all** —
 * `--ext-diff` / `--textconv` only enable them explicitly — and `core.fsmonitor`
 * runs on a plain `git status`. So `forbidOptions` alone cannot close this: the
 * repository's own `.git/config` (or the user's `~/.gitconfig`) is the switch.
 */
const GIT_EXEC_CONFIG = [
	// `[section] key = value` on one line is legal config, so the section header
	// is optional in front of the key
	/^\s*(?:\[[^\]]*\]\s*)?external\s*=/im, // [diff] external = <command>
	/^\s*(?:\[[^\]]*\]\s*)?command\s*=/im, // [diff "<driver>"] command = <command>
	/^\s*(?:\[[^\]]*\]\s*)?textconv\s*=/im, // [diff "<driver>"] textconv = <command>
	/\bgpg\b/i, // [gpg] program = <command> (runs on a signature-verified log)
	/^\s*\[include(?:if)?\b/im, // [include] / [includeIf "..."] sections
	/^\s*include(?:if)?\s*\.\s*path\s*=/im // `include.path = <file>` in dotted form
];

/** `core.fsmonitor = <value>`; only a boolean/empty value runs no program. */
const GIT_FSMONITOR = /^\s*(?:\[[^\]]*\]\s*)?fsmonitor\s*=\s*(.*)$/gim;

/**
 * A git config value with its quoting honoured: a `;` or `#` **inside** quotes
 * belongs to the value, not to a comment — git reads
 * `fsmonitor = "true; exec evil"` as that command line, not as the boolean
 * `true`, and happily runs it.
 * @param raw - everything after the `=`, up to the end of the line
 */
function gitConfigValue(raw) {
	let out = "";
	let quote = null;
	for (const ch of raw) {
		if (quote !== null) {
			if (ch === quote) quote = null;
			out += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			out += ch;
			continue;
		}
		if (ch === "#" || ch === ";") break;
		out += ch;
	}
	return out.trim();
}

/** Whether a git config text names a program a read-only command would run. */
function gitConfigNamesProgram(text) {
	if (GIT_EXEC_CONFIG.some((pattern) => pattern.test(text))) return true;
	for (const match of text.matchAll(GIT_FSMONITOR)) {
		// git accepts a quoted boolean (`fsmonitor = "false"`), but only when the
		// quotes wrap the boolean and nothing else
		const value = gitConfigValue(match[1]).toLowerCase().replace(/^["']|["']$/g, "");
		// `true` uses git's built-in daemon and `false`/empty disable it; anything
		// else is a path or command line
		if (value !== "" && value !== "true" && value !== "false" && value !== "0") return true;
	}
	return false;
}

/**
 * The check behind `configGuard: "git-clean"`: may this git command be
 * auto-approved without running a program named in the repository's own git
 * config?
 *
 * Scope: the **repository** config (`<root>/.git/config`) — the part of the
 * setup that lives in the workspace and can therefore be influenced with the
 * agent's own tools. A user's `~/.gitconfig` (their pager, their difftool) is
 * their own environment, not something a request can reach, so it is out of
 * scope by design.
 *
 * Fail-closed by design. A `.git` **pointer file** (a worktree or submodule
 * checkout) means the real config lives elsewhere and cannot be verified here,
 * so no auto-approval. A missing file is fine — nothing is configured there.
 *
 * @param opts - { root, readFile } — `readFile` is injectable so the check is
 *   unit-testable without touching the filesystem.
 * @returns true when no config that could run a program is present.
 */
export async function gitConfigGuard({ root, readFile: readConfig = readFile } = {}) {
	if (typeof root !== "string" || root === "") return false;
	// Only "there is nothing there" may pass. A permission or I/O failure means
	// the config could not be verified, and an unverified config is never a reason
	// to auto-approve.
	const read = async (file) => {
		try {
			const value = await readConfig(file, "utf8");
			return typeof value === "string" ? value : null;
		} catch (error) {
			const code = error?.code;
			if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return null;
			throw error;
		}
	};
	try {
		// a gitdir pointer file means the config is not where we can read it
		if ((await read(join(root, ".git"))) !== null) return false;
		// `extensions.worktreeConfig` puts a second, per-worktree config next to
		// the main one; it can name a program just as well
		for (const file of [join(root, ".git", "config"), join(root, ".git", "config.worktree")]) {
			const text = await read(file);
			if (text === null) continue;
			if (gitConfigNamesProgram(text)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Stable identity of one action, shared by the breaker's per-action counts and
 * the one-shot human override (`/approval-allow-once`). Derived from the
 * redacted full text, so two requests that would be decided identically share a
 * key, and a credential's value never leaks into the key.
 * @param toolName - the tool that was called
 * @param argsText - the full redacted arguments text
 */
export function actionKeyOf(toolName, argsText, facts) {
	// The execution facts are part of the action's identity, not decoration: the
	// same command in another directory, or under a wider sandbox mode, is a
	// different action, and a human who approved one did not approve the other.
	// Encoded as a JSON tuple, not spliced with a separator: a `workdir` value may
	// itself contain whatever separator we picked, which would let a crafted
	// directory (or an escalation string) produce the same key as another action
	// and spend a grant the human gave for something else.
	const parts = [];
	if (typeof facts?.workdir === "string" && facts.workdir !== "") parts.push(`wd:${facts.workdir}`);
	if (typeof facts?.escalationTo === "string" && facts.escalationTo !== "") parts.push(`esc:${facts.escalationTo}`);
	return createHash("sha1").update(JSON.stringify([toolName, parts, argsText])).digest("hex").slice(0, 16);
}

/**
 * Create the approval/request handler with injected dependencies
 * (unit-testable without a cordis ctx).
 * @param deps - { config, record, llmRunner, getSessionMode, denialFeed, denialHistory, getCwd, resolvePath, readFile }
 *   `denialFeed` is an optional Map<sessionId, Array<DenialRecord>> used to
 *   stage plugin-originated denials for the `agent/pre-step` injector; when
 *   omitted the handler creates its own (shared only if the caller passes it).
 *   `denialHistory` is an optional Map<sessionId, Array<DenialRecord>>
 *   accumulating the last few denials of each session for the transcript
 *   context ([D] lines) and for `/approval-allow-once` — created internally
 *   when omitted.
 *   `breakerStore` is an optional Map<sessionId, state> holding the rejection
 *   breaker (consecutive run, per-action counts, cooldown) and the one-shot
 *   human approvals; created internally when omitted.
 *   `getCwd` optionally returns the workspace path for the transcript [W] line
 *   and for the path-guard check; `resolvePath` overrides the realpath used by
 *   that check (tests inject a pure resolver); `readFile` overrides the config
 *   reader behind `configGuard` and the evidence reader behind `ai.evidenceFetch`
 *   (tests inject a pure reader); `statFile` overrides the stat behind the
 *   evidence fetch's file-type and size checks.
 * @returns async (req, next) => ApprovalOutcome
 */
export function createHandler({ config, record, llmRunner, getSessionMode, denialFeed, denialHistory, breakerStore, getCwd, resolvePath, readFile: readConfigFile, statFile }) {
	let cfg = config;
	const feed = denialFeed ?? new Map();
	const history = denialHistory ?? new Map();
	const breakers = breakerStore ?? new Map();
	/**
	 * Per-session breaker state: the consecutive-denial run, per-action denial
	 * counts, an active cooldown, and the one-shot approvals a human granted
	 * with `/approval-allow-once`.
	 */
	const breakerFor = (sessionId) => {
		if (sessionId === undefined || sessionId === null) return null;
		let state = breakers.get(sessionId);
		if (state === undefined) {
			state = { consecutive: 0, cooledUntil: 0, actions: new Map(), oneShot: new Map() };
			breakers.set(sessionId, state);
		}
		return state;
	};
	/** The recent-denial ring buffer: the transcript's [D] lines and the allow-once list. */
	const rememberDenial = (sessionId, denial) => {
		if (sessionId === undefined || sessionId === null) return;
		const queue = history.get(sessionId) ?? [];
		queue.push(denial);
		if (queue.length > 5) queue.shift();
		history.set(sessionId, queue);
	};
	const stageDenial = (sessionId, denial) => {
		if (sessionId === undefined || sessionId === null) return;
		const queue = feed.get(sessionId) ?? [];
		queue.push(denial);
		if (queue.length > cfg.denyFeedbackMax) queue.shift();
		feed.set(sessionId, queue);
	};
	const updateConfig = (nextConfig) => {
		cfg = nextConfig;
	};
	/**
	 * The rule that decides this request, with each rule's guard applied: a rule
	 * whose path guard refuses (a "workspace-relative" path that resolves
	 * outside the root through a symlink) or whose config guard refuses (git
	 * config that could run a program) is dropped and evaluation continues, so a
	 * later ask/deny rule for the same command still wins instead of the request
	 * silently becoming "no rule matched".
	 */
	const resolveRule = async (request, shapeInfo, guardOpts) => {
		let remaining = cfg.rules;
		for (;;) {
			const match = evaluateRules(remaining, request, shapeInfo);
			if (match === null) return null;
			if (match.action !== "allow") return match;
			const pathsOk = match.pathGuard === "workspace-relative"
				? await pathGuardAllows(positionalArgs(shapeInfo.argv, match.pattern.length, shapeInfo), guardOpts.path)
				: true;
			const configOk = match.configGuard === "git-clean"
				? await gitConfigGuard({ ...guardOpts.config, readFile: readConfigFile })
				: true;
			// A call that widens the sandbox is never settled by a rule. The rule
			// layer judges the command TEXT; the escalation is a separate thing the
			// user consents to, and the host maps `allowed-once` straight onto
			// granting the wider mode (`dsh-sandbox`'s `approveEscalation`). Before
			// this check, a guard-free allow rule (`ls`, `pwd`, `echo`, `which`,
			// `wipefs -n`) plus `sandbox_permissions: danger-full-access` was
			// answered `allowed-once` — no judge call, no prompt, sandbox widened.
			// The judge already sees `escalation`, so such a call falls through to
			// it (or to the human) instead of being auto-approved.
			const escalationOk = guardOpts.escalation?.to === undefined;
			// `scopeOk` is false only when the call runs outside the workspace, and
			// undefined when the workspace root is unknown (then the other guards
			// decide, as before).
			const scopeOk = guardOpts.scopeOk !== false;
			if (pathsOk && configOk && escalationOk && scopeOk) return match;
			// A guard said no to this action. That fact outlives the rule layer:
			// losing the rule is not the same as "no rule applied", and the policy
			// layer may not treat this call as if nothing had objected to it (see
			// the guard-refused dirt in `policyScope`). Without this, `git status`
			// inside a sub-repository whose config runs a program — or any call
			// whose only allow rule was refused — came back as an in-scope medium
			// action and could be auto-approved on the judge's uncertainty.
			guardOpts.refused.value = true;
			remaining = remaining.filter((candidate) => candidate !== match);
		}
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

		const cwd = getCwd !== undefined ? getCwd(req.agent) : undefined;

		// 1) Recover the FULL tool arguments by callId. Nothing is truncated on
		//    the way to a decision: truncating first is what let
		//    `echo <2200 chars>; npm publish` match the `echo` allow rule while
		//    the publish tail was invisible. `argsPreview` without a cap keeps
		//    the whole text; the capped form is only used for the audit preview.
		const args = findToolCallArgs(req.agent?.session, req.callId);
		const fullText = argsPreview(args, req.toolName);

		// 1b) Execution facts the approval seam does not carry: the directory this
		//     call runs in and the sandbox widening it requests. They are recovered
		//     from the same arguments, so they cost nothing extra — and a judge
		//     that cannot see them is judging a bare command line. `justification`
		//     is the agent's own sentence: it travels redacted, as evidence to
		//     verify, never as authorization.
		const facts = shellCallFacts(args, req.toolName);
		const escalation = facts === null || (facts.escalationTo === undefined && facts.justification === undefined)
			? null
			: {
				...facts.escalationTo === undefined ? {} : { to: facts.escalationTo },
				...facts.justification === undefined ? {} : { justification: redactSensitive(facts.justification) }
			};

		// 1c) The directory THIS call actually runs in, resolved the way the host
		//     resolves it (`dsh-tool-bash`'s `resolveWorkdir`: a relative `workdir`
		//     is session-workspace-relative, and it becomes the spawn cwd). The two
		//     guards must judge the paths the command really reaches: with
		//     `workdir` ignored, `cat keep.txt` was auto-approved after checking
		//     `<workspace>/keep.txt` while the shell read `<elsewhere>/keep.txt`,
		//     and `git status` inside a sub-repository was approved after checking
		//     the workspace root's (clean) `.git/config` instead of the one whose
		//     `core.fsmonitor` / `diff.external` actually runs.
		// `facts === null` means "no workdir, no escalation, no background" — NOT
		// "no working directory": the call then runs in the session root, which is
		// what `cwd` already is.
		const workdir = facts === null || typeof facts.workdir !== "string" || facts.workdir === "" ? undefined : facts.workdir;
		const execDir = typeof cwd !== "string" || cwd === ""
			? undefined
			: workdir === undefined
				? cwd
				: resolve(cwd, workdir);
		// An allow rule may only settle a call that runs INSIDE the workspace. A
		// command whose workdir escapes it reaches paths and repository config the
		// user's allow rules were never written about, so it goes to the judge (or
		// the human) instead. Kept separate from `pathGuard`: the git rules carry
		// `configGuard` only, so they would otherwise stay auto-approvable.
		const execRel = typeof cwd !== "string" || cwd === "" || execDir === undefined ? undefined : relative(cwd, execDir);
		const runsInsideWorkspace = execRel === undefined
			? undefined
			: execRel === "" || (!execRel.startsWith("..") && !isAbsolute(execRel));

		// 2) Classify the command's shape from the ORIGINAL text — redaction must
		//    never turn an opaque command into an approvable one — then redact
		//    once, so the judge, the log and the denial feedback all see the same
		//    credential-free text.
		//
		//
		//    Rules are the exception: they match the ORIGINAL text. Redaction is
		//    a rewrite, and a rewrite can delete exactly the text a rule keys on
		//    (`token=Z|git reset --hard HEAD` used to lose its `git`, so the
		//    deny rule never fired and the command reached the judge). A rule's
		//    verdict is the deterministic half of the decision, so it must judge
		//    what will actually run — never a sanitised stand-in.
		const shapeInfo = classifyRequest(req.toolName, fullText);
		const argsText = redactSensitive(fullText);
		const reasonText = redactSensitive(req.reason ?? "");
		// Hints the judge would otherwise have to guess from the raw text: paths
		// that leave the workspace, network destinations, destructive options.
		// Derived from the redacted text, so no credential leaks into the prompt.
		const textFacts = commandFacts({ toolName: req.toolName, argsText, shapeInfo });
		// The call's own structural shape, as the policy layer sees it. What the
		// judge could not see about this call's blast radius is exactly what
		// decides whether its uncertainty may be settled by the tolerance
		// (`medium-uncertain-in-scope`) or has to go to a human / fail closed.
		const callScope = actionScope({ toolName: req.toolName, args, textFacts, cwd, runsInsideWorkspace, escalationTo: facts?.escalationTo });
		const matchReq = { toolName: req.toolName, argsText: fullText, reason: req.reason ?? "" };
		const preview = boundedText(argsText, ARGS_PREVIEW_MAX_CHARS) ?? "";
		const evidenceIssue = evidenceProblem({ args, toolName: req.toolName, argsText, cfg });

		let verdict;
		let context = "";
		let rule = null;
		// Session-level gates, evaluated before any paid model call, and only when
		// no rule matched (a rule's decision — including a `deny` — is never
		// overridden by either):
		//   - a one-shot human approval of THIS exact action, consumed here;
		//   - a tripped rejection breaker, so a session that keeps getting denied
		//     stops paying for judge calls it keeps losing.
		const actionKey = actionKeyOf(req.toolName, argsText, facts);
		let gate = null;
		// Set by `resolveRule` when an allow rule was dropped because one of its
		// guards refused this call. Losing a rule to a guard is a decision about
		// the call, and the policy layer must not be able to re-open it.
		const guardRefused = { value: false };
		if (evidenceIssue === null) {
			rule = await resolveRule(matchReq, shapeInfo, {
				path: { cwd: execDir, root: cwd, resolvePath },
				config: { root: execDir },
				escalation: { to: facts?.escalationTo },
				scopeOk: runsInsideWorkspace,
				refused: guardRefused
			});
		}
		if (evidenceIssue === null && rule === null) {
			const breakerState = breakerFor(sessionId);
			if (breakerState !== null) {
				const granted = breakerState.oneShot.get(actionKey) ?? 0;
				if (granted > 0) {
					breakerState.oneShot.delete(actionKey);
					gate = { kind: "manual-override", action: "allow", outcome: "allowed-once", manualOverride: true };
				} else if (breakerState.cooledUntil > Date.now()) {
					gate = {
						kind: "breaker",
						action: "deny",
						outcome: "rejected",
						breaker: "cooldown",
						breakerUntil: new Date(breakerState.cooledUntil).toISOString()
					};
				} else if (cfg.denialBreaker.duplicate > 0 && (breakerState.actions.get(actionKey) ?? 0) >= cfg.denialBreaker.duplicate) {
					gate = { kind: "breaker", action: "deny", outcome: "rejected", breaker: "duplicate-action" };
				}
			}
		}
		if (evidenceIssue !== null) {
			// Incomplete evidence is never auto-approved, and the judge is not
			// even asked (it would only be judging `command: null` / a prefix).
			verdict = {
				kind: "evidence-incomplete",
				action: "ask",
				outcome: "pass",
				evidenceIncomplete: evidenceIssue
			};
		} else if (rule !== null) {
			verdict = {
				kind: "rule",
				action: rule.action,
				outcome: outcomeFor(rule.action),
				match: ruleLabel(rule),
				...rule.hardAsk === true ? { hardAsk: true } : {}
			};
		} else if (gate !== null) {
			verdict = gate;
		} else if (cfg.ai.enabled) {
			// The skeleton quotes the session (user messages and tool-call
			// arguments verbatim), so it goes through the SAME redaction boundary
			// as the command: without this, `short` puts the un-redacted
			// `Authorization: Bearer …` back into the judge prompt right next to
			// the redacted copy — one leak path per transcript line.
			context = cfg.transcript === "short"
				? redactSensitive(buildTranscript({
					events: req.agent?.session,
					cfg,
					denialHistory: history,
					sessionId,
					mode,
					tolerance: cfg.ai.riskTolerance,
					mode3OnAsk: cfg.mode3OnAsk,
					cwd
				}))
				: "";
			const judgeInput = { toolName: req.toolName, argsText, reason: reasonText, context, cwd, workdir: facts?.workdir, escalation, facts: textFacts };
			// One budget for the whole approval: every candidate AND the evidence
			// round share it, so a slow chain cannot stretch an approval to minutes.
			// `judgeBudgetMs` lifts a ceiling that would otherwise be shorter than a
			// single candidate's own timeout — which is what silently disabled the
			// fallback chain on this machine (`timeoutMs: 60000` vs the default
			// `totalBudgetMs: 30000`).
			const budgetMs = judgeBudgetMs(cfg.ai);
			const deadline = budgetMs > 0 ? started + budgetMs : undefined;
			const judged = await judgeWith({
				runner: llmRunner,
				input: judgeInput,
				// Cancel propagation: without this the judge chain keeps spending
				// model calls (and fallbacks) after the approval was cancelled.
				signal: req.signal,
				allowAsk: mode !== "ai-auto",
				sessionId,
				deadline
			});
			if (judged.ok) {
				// The judge may name up to `evidenceMaxFiles` workspace-local files
				// whose content would change the verdict (`bash scripts/deploy.sh`
				// is one line; the deployment target lives in the script). The
				// plugin fetches them under its own whitelist (evidence.js) and
				// re-judges ONCE with them attached. A refusal is recorded, never
				// hidden — "I could not see it" is a judgement input, so the second
				// round gets the reason list as well.
				let answered = judged;
				let evidenceFetched;
				let evidenceRefused;
				let evidenceRoundFailed;
				const needs = cfg.ai.evidenceFetch === "read-file" ? parseNeeds(judged.verdict.needs, cfg.ai.evidenceMaxFiles) : [];
				if (needs.length > 0) {
					const fetched = await fetchEvidence(needs, {
						root: cwd,
						base: facts?.workdir === undefined || typeof cwd !== "string" ? cwd : resolve(cwd, facts.workdir),
						maxBytes: cfg.ai.evidenceMaxBytes,
						// The evidence round shares the approval's own budget: a slow
						// read must not outlive the deadline that governs the judge.
						deadline,
						resolvePath,
						readFile: readConfigFile,
						statFile
					});
					evidenceFetched = fetched.files.map((file) => ({
						path: file.path,
						bytes: file.bytes,
						...file.truncated === true ? { truncated: true } : {}
					}));
					evidenceRefused = fetched.refused;
					// A round that fetched nothing but refused something still tells the
					// judge something it needs: "I could not see it" is a judgement
					// input, not a reason to reuse a verdict formed without it.
					if ((fetched.files.length > 0 || fetched.refused.length > 0) && req.signal?.aborted !== true) {
						const second = await judgeWith({
							runner: llmRunner,
							input: { ...judgeInput, evidence: fetched.files, evidenceRefused: fetched.refused },
							signal: req.signal,
							allowAsk: mode !== "ai-auto",
							allowNeeds: false,
							sessionId,
							deadline
						});
						if (second.ok) answered = second;
						else evidenceRoundFailed = true;
					}
				}
				// A judge that asked for evidence and did not get it is not merely
				// unsure — it is blind on a point it itself flagged. "I could not
				// see it" must never be settled by the tolerance, so the scope is
				// dirtied whenever the evidence round failed or something was
				// refused. Same principle as the evidence layer's own rule that an
				// unreadable script is not an absent risk.
				// Two things dirty the scope beyond the call's own shape: a rule
				// guard that refused this exact call, and a judge that asked for
				// evidence it did not get (it is blind on a point it flagged, not
				// merely unsure). Neither may be settled by the tolerance.
				const scopeDirt = [];
				if (guardRefused.value === true) scopeDirt.push("rule-guard-refused");
				if (evidenceRoundFailed === true || (Array.isArray(evidenceRefused) && evidenceRefused.length > 0)) scopeDirt.push("evidence-unavailable");
				const policyScope = scopeDirt.length === 0
					? callScope
					: { clean: false, reasons: [...callScope.reasons, ...scopeDirt] };
				const decision = decidePolicy(answered.verdict, { tolerance: cfg.ai.riskTolerance, scope: policyScope });
				verdict = {
					kind: "ai",
					action: decision.action,
					outcome: outcomeFor(decision.action),
					// Which policy branch decided, so the audit says why an action
					// was auto-approved rather than only that it was.
					policy: decision.rule,
					...decision.enforced === true ? { enforced: true } : {},
					// Why the call's own shape allowed (or forbade) settling the
					// judge's uncertainty without a human — the audit has to be able
					// to answer that after the fact.
					...policyScope.reasons.length === 0 ? {} : { scopeReasons: policyScope.reasons },
					risk: answered.verdict.risk,
					// The judge's own opinion, kept next to the policy branch that
					// used it: without it a past decision cannot be replayed under a
					// new policy (scripts/eval.mjs --replay).
					judgeAuthorization: answered.verdict.authorization,
					// The tolerance in force, so the decision can be replayed later.
					tolerance: cfg.ai.riskTolerance,
					...answered.verdict.userAuthorization === undefined ? {} : { userAuthorization: answered.verdict.userAuthorization },
					// The judge's own words go through the same boundary as everything
					// else it was shown: it reads the (now redacted) evidence body, so
					// whatever it echoes back must not carry a credential into the log.
					...answered.verdict.evidence === undefined ? {} : { aiEvidence: answered.verdict.evidence.map((item) => redactSensitive(item)) },
					...answered.verdict.unknowns === undefined ? {} : { aiUnknowns: answered.verdict.unknowns.map((item) => redactSensitive(item)) },
					aiReason: redactSensitive(answered.verdict.reason),
					...evidenceFetched === undefined ? {} : { evidenceFetched },
					...evidenceRefused === undefined || evidenceRefused.length === 0 ? {} : { evidenceRefused },
					...evidenceRoundFailed === true ? { evidenceRoundFailed: true } : {},
					...needs.length === 0 ? {} : { evidenceRounds: answered === judged ? 1 : 2 },
					...answered.judgeModel === undefined ? {} : { judgeModel: answered.judgeModel },
					...answered.judgeFallbackFrom === undefined ? {} : { judgeFallbackFrom: answered.judgeFallbackFrom },
					...answered.judgeAttempts === undefined ? {} : { judgeAttempts: answered.judgeAttempts }
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
					...judged.textChars !== void 0 ? { textChars: judged.textChars } : {},
					...judged.endedWithoutFinish !== void 0 ? { endedWithoutFinish: judged.endedWithoutFinish } : {},
					...judged.judgeAttempts !== void 0 ? { judgeAttempts: judged.judgeAttempts } : {},
					...judged.judgeTried !== void 0 ? { judgeTried: judged.judgeTried } : {},
					...judged.budgetExhausted === true ? { budgetExhausted: true } : {}
				};
			}
		} else {
			verdict = { kind: "fallback", action: cfg.fallback, outcome: outcomeFor(cfg.fallback) };
		}

		// A request cancelled while the judge was running has no valid verdict:
		// answer `cancelled` (the host already races the request signal, so this
		// is about not auditing a stale `allowed-once` and not staging a denial).
		if (req.signal?.aborted === true) {
			await record({
				ts: new Date().toISOString(),
				sessionId: sessionId ?? "?",
				mode,
				toolName: req.toolName,
				callId: req.callId,
				argsPreview: preview,
				reason: boundedText(reasonText, 500) ?? "",
				commandChars: argsText.length,
				shape: shapeInfo.shape,
				transcriptChars: context.length,
				...textFacts === null ? {} : { commandFacts: textFacts },
				...cwd === undefined ? {} : { cwd },
				...facts?.workdir === undefined ? {} : { workdir: facts.workdir },
				...escalation === null ? {} : { escalation },
				...facts?.background === true ? { background: true } : {},
				kind: "cancelled",
				outcome: "cancelled",
				ms: Date.now() - started
			});
			return "cancelled";
		}

		// mode 3 (ai-auto): an "ask" is never routed to a human — resolve it
		// through mode3OnAsk (default deny), regardless of its source
		// (rule ask, AI ask over tolerance, failOpen=ask, fallback=ask).
		// Three exceptions, deliberately, because `mode3OnAsk: allow` must not be
		// able to grant what nobody consented to:
		//   - evidence-incomplete: a mode switch must not turn "the operation
		//     could not be seen" into permission;
		//   - hardAsk red lines (publishing, credentials): a consent only a human
		//     can give, landing on `ai.hardAskOnUnattended` (default deny);
		//   - an enforced policy ask (`enforced`: high risk without a strong user
		//     authorization, or an above-tolerance allow nobody asked for),
		//     landing on `ai.enforcedAskOnUnattended` (default deny).
		if (mode === "ai-auto" && verdict.action === "ask") {
			const resolved = verdict.kind === "evidence-incomplete"
				? "deny"
				: verdict.hardAsk === true
					? cfg.ai.hardAskOnUnattended
					: verdict.enforced === true
						? cfg.ai.enforcedAskOnUnattended
						: effectiveOnAsk(mode, cfg.mode3OnAsk);
			verdict = { ...verdict, action: resolved, outcome: outcomeFor(resolved), viaAskResolution: true };
		}

		// A denial that is really "not as written" asks for a materially safer
		// re-submission instead of forbidding the whole goal (needsRestructure).
		// It rides on the verdict so the audit record and the corrective message
		// carry the same label.
		if (verdict.outcome === "rejected" && needsRestructure({ verdict, argsText, toolName: req.toolName })) {
			verdict = { ...verdict, feedbackKind: "restructure" };
		}

		await record({
			ts: new Date().toISOString(),
			sessionId: sessionId ?? "?",
			mode,
			toolName: req.toolName,
			callId: req.callId,
			argsPreview: preview,
			reason: boundedText(reasonText, 500) ?? "",
			commandChars: argsText.length,
			shape: shapeInfo.shape,
			transcriptChars: context.length,
			...textFacts === null ? {} : { commandFacts: textFacts },
			...cwd === undefined ? {} : { cwd },
			...facts?.workdir === undefined ? {} : { workdir: facts.workdir },
			...escalation === null ? {} : { escalation },
			...facts?.background === true ? { background: true } : {},
			...verdict,
			ms: Date.now() - started
		});

		// Breaker bookkeeping. Only decisions the plugin actually reached count —
		// a breaker's own refusal must not extend its own cooldown, or a session
		// could never recover. Any non-denial resets the run (Codex does the same).
		const breakerState = breakerFor(sessionId);
		if (breakerState !== null && verdict.kind !== "breaker") {
			if (verdict.outcome === "rejected") {
				breakerState.consecutive += 1;
				breakerState.actions.set(actionKey, (breakerState.actions.get(actionKey) ?? 0) + 1);
				if (cfg.denialBreaker.consecutive > 0 && breakerState.consecutive >= cfg.denialBreaker.consecutive) {
					breakerState.cooledUntil = Date.now() + cfg.denialBreaker.cooldownMs;
				}
			} else {
				breakerState.consecutive = 0;
			}
		}

		// Stage plugin-originated denials for the pre-step feedback injector.
		// Only denials the plugin itself produced are staged (rule / ai /
		// ai-error-failOpen / fallback / breaker, incl. ai-auto's mode3
		// ask-resolution), so a human denial through the GUI answerer never gets
		// re-attributed. The recent-denial list is kept either way: it is what
		// `/approval-allow-once` lists from.
		if (verdict.outcome === "rejected") {
			// "Not as written" and "not at all" get different corrective copy: the
			// first asks for a materially safer re-submission, the second forbids
			// working around the denial. The decision is identical either way.
			const denial = {
				command: preview.slice(0, DENIAL_COMMAND_MAX_CHARS),
				key: actionKey,
				source: verdict.kind,
				...verdict.feedbackKind === undefined ? {} : { feedbackKind: verdict.feedbackKind },
				...verdict.match !== void 0 ? { match: verdict.match } : {},
				...verdict.risk !== void 0 ? { risk: verdict.risk } : {},
				...boundedText(verdict.aiReason, 200) !== void 0 ? { aiReason: boundedText(verdict.aiReason, 200) } : {},
				...verdict.finishKind !== void 0 ? { finishKind: verdict.finishKind } : {},
				...verdict.failure !== void 0 ? { failure: verdict.failure } : {},
				...verdict.viaAskResolution === true ? { viaAsk: true } : {},
				...verdict.breaker !== void 0 ? { breaker: verdict.breaker } : {},
				ts: Date.now()
			};
			rememberDenial(sessionId, denial);
			if (cfg.denyFeedback) stageDenial(sessionId, denial);
		}

		return verdict.outcome === "pass" ? next() : verdict.outcome;
	};
	handler.updateConfig = updateConfig;
	return handler;
}

/** Size of an existing log file, or 0 when it is absent/unreadable. */
function existingLogBytes(logFile) {
	try {
		return statSync(logFile).size;
	} catch {
		return 0;
	}
}

/** Move the audit log aside to `<logFile>.1` (the previous `.1` is replaced). */
function rotateLog(logFile) {
	const target = `${logFile}.1`;
	try {
		unlinkSync(target);
	} catch {
		/* no previous rotation */
	}
	renameSync(logFile, target);
}

/**
 * Fire-and-forget JSONL appender (never throws into the approval path).
 *
 * A log this recorder creates is created with mode 0600 — audit records carry
 * command text (redacted, but still operator data) and must not be
 * world-readable. An already-existing file keeps its permissions: tightening
 * those is an operator decision, not something the plugin does behind a user's
 * back. Once the file passes `maxBytes` it is rotated to `<logFile>.1`.
 *
 * @param logFile - the JSONL path
 * @param opts - { maxBytes } rotation threshold (0/undefined disables rotation)
 */
export function makeRecorder(logFile, { maxBytes = 0 } = {}) {
	let ready = false;
	let bytes = 0;
	return async (entry) => {
		try {
			const line = `${JSON.stringify(entry)}\n`;
			if (!ready) {
				mkdirSync(dirname(logFile), { recursive: true });
				bytes = existingLogBytes(logFile);
				ready = true;
			}
			if (Number.isFinite(maxBytes) && maxBytes > 0 && bytes > 0 && bytes + line.length > maxBytes) {
				rotateLog(logFile);
				bytes = 0;
			}
			await appendFile(logFile, line, { encoding: "utf8", mode: 0o600 });
			bytes += line.length;
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
export function makeModeStore(ctx, logger, entryOverrides = {}) {
	const memory = new Map();
	// 本地刚写入、但还没从持久层确认的**意图**：sessionId -> { mode, intent, epoch }。
	// 这些条目不能被远端快照覆盖或删除——用户在 /approval-mode 之后已经被告知
	// 「已切换」，若紧接着一次无关的 volatile 同步把远端旧快照盖上来，他的 manual
	// 就被静默撤销、继续自动放行。
	//
	// 用「意图 + 代次」而不是一个布尔集合，是因为布尔表达不了四件事：同键被旧快照
	// 覆盖、被删掉、连续写入时先成功的那次提前解除保护、以及 clear() 表达不了「我要
	// 删除」。代次保证只有**最新一次**写入才解除保护。
	const pending = new Map();
	let epochSeq = 0;
	// 0.2.0：sessionOverrides 由 entry Config 承载，启动值取自 apply 收到的 userConfig。
	for (const [key, value] of Object.entries(entryOverrides ?? {})) memory.set(key, value);
	let settings = null;
	ctx.inject(["settings"], (sctx) => {
		settings = sctx.settings;
		// 0.2.0 的 SettingsForms 走 entry config，不再读写旧命名空间。
		if (usesEntryConfigSettings(sctx.settings)) return;
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
		const next = {};
		for (const [key, value] of memory) next[key] = value;
		// 记下提交时的代次：整表提交成功意味着**本次快照里所有键**都已在持久层落地，
		// 它们的待确认意图可以一并解除（只要期间没有更新的写入）。少了这一步，被
		// 顺带持久化的键会永久保留保护标记，之后远端真的删除它时内存却仍留着。
		const submitted = new Map();
		for (const key of Object.keys(next)) submitted.set(key, pending.get(key)?.epoch);
		try {
			// 0.2.0 的 SettingsForms.replace 是**整份重置**语义：它先把该 namespace 的
			// 全部 live 字段还原再填入传参。只传 sessionOverrides 会把同一个 entry 上的
			// provider/model/riskTolerance 等一起冲回默认值——用户执行一次 /approval-mode
			// 就会丢掉刚在设置页配好的模型与风险策略。必须改用 mutate 精确定位到
			// sessionOverrides 这一个路径（mutate → write 只改 ops 指定的 path）。
			if (usesEntryConfigSettings(settings)) {
				const row = settings.describe().find((candidate) => candidate.ns === name);
				if (row === undefined) return "memory-only";
				await settings.mutate(name, [{ op: "set", path: ["sessionOverrides"], value: next }], row.revision);
			} else {
				await settings.replace("dsh-codex-approval", { sessionOverrides: next });
			}
			for (const [key, epoch] of submitted) {
				const entry = pending.get(key);
				if (entry !== undefined && entry.epoch === epoch) pending.delete(key);
			}
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
			// 写入**即刻**登记意图，而不是等 persist 结束：并发时另一次写入触发的同步
			// 可能发生在本条确认之前，那时它若还没登记就会被删掉。
			const entry = { mode, intent: "set", epoch: ++epochSeq };
			pending.set(sessionId, entry);
			const outcome = await persist();
			// 只有仍是该键**最新**一次写入时才解除：连续两次 set 时，先成功的那次
			// 不能把后一次的保护区清掉。
			if (outcome === "persisted" && pending.get(sessionId) === entry) pending.delete(sessionId);
			return outcome;
		},
		async clear(sessionId) {
			if (sessionId === undefined || sessionId === null) return "memory-only";
			memory.delete(sessionId);
			// 删除同样是一个需要保护的意图：否则较早提交的旧快照会把该会话重新加回来。
			const entry = { mode: undefined, intent: "delete", epoch: ++epochSeq };
			pending.set(sessionId, entry);
			const outcome = await persist();
			if (outcome === "persisted" && pending.get(sessionId) === entry) pending.delete(sessionId);
			return outcome;
		},
		/**
		 * 外部改动了 `sessionOverrides`（volatile 热更新、框架迁移旧 settings、
		 * 另一处写入）时把新值同步进内存 Map。
		 *
		 * 该字段刻意不在 `LIVE_FIELDS` 里——它的语义是「mode 命令写入状态的镜像」，
		 * 不适合挂 getter。但正因如此，它不会自动跟随引用变化：少了这一步，外部把
		 * 某个会话改成 `manual` 之后 store 仍返回旧值，审批会继续按自动模式放行。
		 * @returns 是否有条目发生变化（调用方可据此决定是否记审计）
		 */
		syncOverrides(next) {
			if (next === null || typeof next !== "object" || Array.isArray(next)) return false;
			let changed = false;
			// volatile 引用承载的是**完整快照**，不是增量补丁：新快照里消失的键
			// 代表该会话的 override 被删除了，必须一并从 Map 移除。少了这一步，
			// 「全局模式 manual + 该会话曾设 ai-auto」在删除 override 之后仍会
			// 自动放行，而且下一次 persist() 序列化整张 Map 时会把删掉的条目写回去。
			// 1) 按远端快照同步，但跳过**有未确认意图**的键（本地写入优先于远端旧快照）
			for (const key of [...memory.keys()]) {
				if (!Object.hasOwn(next, key) && !pending.has(key)) {
					memory.delete(key);
					changed = true;
				}
			}
			for (const [key, value] of Object.entries(next)) {
				if (pending.has(key)) continue;
				if (memory.get(key) !== value) {
					memory.set(key, value);
					changed = true;
				}
			}
			// 2) 再把未确认的本地意图覆盖回去：set 恢复成本地值，delete 保持删除
			for (const [key, entry] of pending) {
				if (entry.intent === "set") {
					if (memory.get(key) !== entry.mode) {
						memory.set(key, entry.mode);
						changed = true;
					}
				} else if (memory.has(key)) {
					memory.delete(key);
					changed = true;
				}
			}
			return changed;
		},
		/** 当前覆盖表的浅拷贝，仅供审计记录使用。 */
		snapshot() {
			return Object.fromEntries(memory);
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
 * Register the `/approval-allow-once` command: the recovery path after a denial.
 *
 * It lists this session's recent denials (the same ring buffer the transcript
 * and the feedback injector read) and grants ONE retry of the chosen action.
 * The grant is deliberately narrow — it mirrors Codex's `/approve`:
 *   - it applies to that exact action (the `actionKeyOf` hash), not to similar
 *     future actions, and is consumed by the next matching request;
 *   - the rule layer still runs first, so a rule `deny` cannot be re-enabled
 *     through this command;
 *   - granting it also clears the session's breaker cooldown: a human decision
 *     is exactly what the breaker was waiting for.
 *
 * @param ctx - cordis context
 * @param deps - { history, breakerStore, getLocale }
 */
export function registerAllowOnceCommand(ctx, { history, breakerStore, getLocale }) {
	const readLocale = () => (getLocale ? getLocale() : "en");
	ctx.inject(["commands"], (commandCtx) => {
		commandCtx.commands.register({
			name: "approval-allow-once",
			description: allowOnceCommandDescription(getLocale ? getLocale() : "en"),
			input: { hint: "[number]" },
			handler: async ({ agent, rawInput }) => {
				const locale = readLocale();
				const sessionId = agent?.session?.id ?? agent?.id;
				const list = sessionId === undefined || sessionId === null ? [] : history.get(sessionId) ?? [];
				const newestFirst = list.slice().reverse();
				const input = typeof rawInput === "string" ? rawInput.trim() : "";
				if (input === "") {
					return {
						kind: "success",
						text: newestFirst.length === 0 ? renderAllowOnceEmpty(locale) : renderAllowOnceList(newestFirst, locale)
					};
				}
				const index = Number.parseInt(input, 10);
				const denial = Number.isSafeInteger(index) && index >= 1 && index <= newestFirst.length
					? newestFirst[index - 1]
					: undefined;
				if (denial === undefined || typeof denial.key !== "string" || denial.key === "") {
					return { kind: "success", text: renderAllowOnceUnknown(input, locale) };
				}
				let state = breakerStore.get(sessionId);
				if (state === undefined) {
					state = { consecutive: 0, cooledUntil: 0, actions: new Map(), oneShot: new Map() };
					breakerStore.set(sessionId, state);
				}
				state.oneShot.set(denial.key, (state.oneShot.get(denial.key) ?? 0) + 1);
				state.consecutive = 0;
				state.cooledUntil = 0;
				return { kind: "success", text: renderAllowOnceGranted(denial.command, locale) };
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
				source: { kind: `plugin:${name}`, form: "instructions" }
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

/**
 * 升级路径：报告仍留在旧 settings 文档里的 `dsh-codex-approval-config`。
 *
 * 0.2.0 的 `importLegacyDocument` 按 **section 名**映射 entry，而它的映射表
 * （`LEGACY_SECTION_ENTRIES`）里没有本插件的命名空间，所以旧设置页写下的
 * provider/model/riskTolerance/fallbacks 不会被自动搬进新 entry —— 它们只会
 * 留在 `$DSH_HOME/settings.yaml.imported` 里，插件侧也读不到（`settings.get(ns)`
 * 在 0.2.0 只按 entry id 查）。结果是「升级后模型与风险策略静默消失」。
 *
 * 插件不该替用户改 profile 文档，所以这里做**可发现**：检测到就把原文片段打出来
 * 并写一条审计记录，照着它把值填进 `cordis.patch.yml` 的 `- id: dsh-codex-approval`
 * → `config:` 即可。
 *
 * 只做文本切段、不解析 YAML：不引入依赖，也不会因为文档里别处的语法问题翻车。
 * @returns 旧配置的原文片段，没有则 undefined
 */
export async function findLegacySettings(home = process.env.DSH_HOME ?? join(homedir(), ".dsh")) {
	// **两个文件名都要查**。框架（dsh-settings）是先 `loader.await()`、再
	// `importLegacyDocument()`，导入完才把 `settings.yaml` 重命名成
	// `settings.yaml.imported`。首次升级那一刻，磁盘上只有 `settings.yaml`
	// ——只盯 `.imported` 会让「最需要告警的那一次」恰好漏发。
	for (const name of ["settings.yaml", "settings.yaml.imported"]) {
		const found = await readLegacySection(join(home, name));
		if (found !== undefined) return found;
	}
	return undefined;
}

/** Read one settings document and cut out this plugin's legacy section. */
async function readLegacySection(file) {
	if (!existsSync(file)) return undefined;
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return undefined;
	}
	const lines = text.split("\n");
	const start = lines.findIndex((line) => new RegExp(`^${CONFIG_SETTINGS_NAMESPACE}\\s*:`).test(line));
	if (start === -1) return undefined;
	const segment = [lines[start]];
	for (let index = start + 1; index < lines.length; index += 1) {
		// 缩进行属于这一节；遇到下一个顶层键就收工。
		if (/^\S/.test(lines[index])) break;
		segment.push(lines[index]);
	}
	return { file, segment: segment.join("\n") };
}

/** Cordis plugin entry: register the answerer when approval is composed. */
export async function apply(ctx, userConfig) {
	// 0.2.0 的 entry Config 里，标了 volatile 的字段在已解析 config 中是 cosmokit 的
	// **引用对象**，不是值。直接当值用会在 assertConfig 处炸掉——报错文本里的
	// `got {}` 就是这个引用被 JSON.stringify 的结果，值其实一直都在引用里。
	// 因此：先摊平快照做校验与默认值兜底，再把 volatile 字段接成 getter，让设置页
	// 的改动经 loader 的 `updateVolatile` 原地生效（引用身份不变、值更新、插件不重载）。
	const source = userConfig ?? {};
	const provided = materializeConfig(source);
	// 基线用**未被污染的** DEFAULT_CONFIG：`{ ...DEFAULT_CONFIG, ...provided }` 会让
	// provided 里的 undefined 覆盖掉默认值，而 undefined 正是「这个字段没配过」的
	// 表达。合并由 applyConfigSettings 内部按「只让有值的字段覆盖」完成。
	// 基线装配：**只喂旧嵌套 `ai.*`**（不含任何顶层显式值），得到「这些字段都没配过」
	// 时应当采用的值。getter 在引用值缺失/null 时回落到它——这样既不会在用户删掉
	// 字段后「恢复」启动时的旧值，也不会把装配期从 nested 修正出来的值打回内置默认。
	const baseline = normalizeConfig(applyConfigSettings(
		DEFAULT_CONFIG,
		provided?.ai === undefined ? {} : { ai: provided.ai }
	));
	let cfg = installLiveGetters(normalizeConfig(applyConfigSettings(DEFAULT_CONFIG, provided)), source, baseline);
	const store = makeModeStore(ctx, ctx.logger, cfg.sessionOverrides);
	const denialFeed = new Map();
	const denialHistory = new Map();
	const breakerStore = new Map();
	const getConfig = () => cfg;
	const getLocale = makeGetLocale(cfg, ctx, getConfig);
	const llmRunner = makeLlmRunner(ctx.llm, () => cfg.ai);
	const record = makeRecorder(cfg.logFile, { maxBytes: cfg.logMaxBytes });
	const handler = createHandler({
		config: cfg,
		record,
		llmRunner,
		getSessionMode: (sessionId) => store.get(sessionId),
		denialFeed,
		denialHistory,
		breakerStore,
		// The session's workspace root. On 0.2.x it lives on the session HEADER
		// (`dsh-session` validates it as an absolute path, and `dsh-sandbox-policy`
		// resolves confinement from the same field), not on `session.policy`. The
		// previous spelling evaluated to `undefined` in production, which made
		// `pathGuardAllows` and `gitConfigGuard` refuse on every call and silently
		// disabled both guards (22 of the default allow rules, the transcript's
		// `[W]` line, and the evidence root).
		getCwd: (agent) => agent?.session?.header?.cwd ?? agent?.session?.policy?.workspaceRoot ?? agent?.cwd
	});
	ctx.on("approval/request", handler);
	// volatile 热更新审计：设置页改配置走 loader 的 `updateVolatile` 原地写快照，
	// 插件不重载。这条记录读到的若是新值，就证明 live 链路真的跑通了。
	ctx.on("loader/volatile-update", (paths) => {
		const changed = Array.isArray(paths)
			? paths.map((path) => (Array.isArray(path) ? path.join(".") : String(path)))
			: [];
		// 只有 sessionOverrides **自己**变了才同步覆盖表。
		//
		// 原来在任何 volatile 更新（比如只改了 provider）时都用快照覆盖内存 Map，
		// 这会撤销本地写入：用户刚下的 `/approval-mode manual` 若 persist 失败、
		// 只留在内存里，紧接着一次无关的配置改动就会把它冲回旧值——人工审批模式
		// 被静默撤销，而用户以为它已经生效。
		let synced = false;
		if (changed.includes("sessionOverrides")) {
			const overridesRef = source?.sessionOverrides;
			if (isVolatileRef(overridesRef)) synced = store.syncOverrides(materializeConfig(overridesRef.get()));
		}
		void record({
			ts: new Date().toISOString(),
			event: "config-live-update",
			sessionId: "boot",
			paths: changed,
			sessionOverridesSynced: synced,
			overrides: store.snapshot ? store.snapshot() : {},
			mode3OnAsk: cfg.mode3OnAsk,
			judge: `${cfg.ai.provider}/${cfg.ai.model}`,
			tolerance: cfg.ai.riskTolerance,
			timeoutMs: cfg.ai.timeoutMs,
			maxTokens: cfg.ai.maxTokens,
			denyFeedback: cfg.denyFeedback
		});
	});
	ctx.inject(["settings"], (settingsCtx) => {
		// 0.2.0：可编辑设置由 entry Config 派生，值经上面的 userConfig 直接生效。
		if (usesEntryConfigSettings(settingsCtx.settings)) {
			// 旧命名空间不会被框架自动搬进 entry config（见 findLegacySettings 注释）。
			// 检测到就告警 + 留审计，避免「升级后模型与风险策略静默消失」。
			void findLegacySettings()
				.then((found) => {
					if (found === undefined) return;
					// 措辞刻意只说「发现备份、请核对」，不断言「尚未迁移」：用户把值搬进
					// entry config 之后 `.imported` 备份会长期留着，若每次都断言未迁移，
					// 就会指导用户反复覆盖已经正确的当前配置。
					ctx.logger?.warn?.(
						"[dsh-codex-approval] 发现旧设置备份：%s（%s）。0.2.0 不会自动把它搬进 entry config。若当前配置已是最新，忽略本条；如需核对，请对照 cordis.patch.yml 的 `- id: dsh-codex-approval` → `config:`：\n%s",
						found.file, CONFIG_SETTINGS_NAMESPACE, found.segment
					);
					void record({
						ts: new Date().toISOString(),
						event: "legacy-settings-backup-found",
						sessionId: "boot",
						file: found.file,
						namespace: CONFIG_SETTINGS_NAMESPACE,
						segment: found.segment
					});
				})
				.catch(() => {});
			void record({ ts: new Date().toISOString(), event: "config-settings", sessionId: "boot", ok: true, namespace: CONFIG_SETTINGS_NAMESPACE, applies: "live", scope: "entry-config" });
			return;
		}
		installConfigSettings({
			settings: settingsCtx.settings,
			base: {
				mode: cfg.mode,
				provider: cfg.ai.provider,
				model: cfg.ai.model,
				fallbacks: cfg.ai.fallbacks,
				riskTolerance: cfg.ai.riskTolerance,
				failOpen: cfg.ai.failOpen,
				mode3OnAsk: cfg.mode3OnAsk,
				timeoutMs: cfg.ai.timeoutMs,
				maxTokens: cfg.ai.maxTokens,
				totalBudgetMs: cfg.ai.totalBudgetMs,
				hardAskOnUnattended: cfg.ai.hardAskOnUnattended,
				enforcedAskOnUnattended: cfg.ai.enforcedAskOnUnattended,
				denyFeedback: cfg.denyFeedback,
				denialBreaker: cfg.denialBreaker
			},
			onValue: (settingsValue) => {
				// 0.1.x 的 namespace 值就是实际生效值，`??` 直接覆盖即可。
				cfg = installLiveGetters(applyConfigSettings(cfg, settingsValue), source);
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
	registerAllowOnceCommand(ctx, { history: denialHistory, breakerStore, getLocale });
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
		// The budget actually in force, next to the configured one: a ceiling
		// shorter than one candidate's own timeout is lifted (see judgeBudgetMs),
		// and without this line that difference stayed invisible.
		judgeBudget: {
			configured: cfg.ai.totalBudgetMs,
			effective: judgeBudgetMs(cfg.ai),
			perCandidateMs: cfg.ai.timeoutMs,
			candidates: 1 + cfg.ai.fallbacks.length
		},
		tolerance: cfg.ai.riskTolerance,
		fallback: cfg.fallback,
		denyFeedback: cfg.denyFeedback,
		denyFeedbackMax: cfg.denyFeedbackMax,
		denialBreaker: cfg.denialBreaker,
		transcript: cfg.transcript,
		transcriptMaxChars: cfg.transcriptMaxChars
	});
	ctx.logger?.info?.("[dsh-codex-approval] answerer registered — mode=%s rules=%d ai=%s judge=%s fallbacks=%d tolerance=%s log=%s",
		cfg.mode, cfg.rules.length, cfg.ai.enabled ? "on" : "off", `${cfg.ai.provider}/${cfg.ai.model}`, cfg.ai.fallbacks.length, cfg.ai.riskTolerance, cfg.logFile);
}
