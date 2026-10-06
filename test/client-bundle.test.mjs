import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { resolveModelCatalogLoader } from "../src/client/client-remote.js";

/**
 * Loads the shipped browser bundle (lib/client.js) in a fake module loader and
 * renders the card with a minimal React stand-in, so a broken artifact or a
 * broken card fails here instead of silently showing nothing in the Web UI.
 *
 * The card mirrors the built-in plugin cards: an `<li>` with a collapsible
 * header, so these tests expand it before asserting on the form.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleSource = readFileSync(join(packageRoot, "lib", "client.js"), "utf8");

/**
 * The most recently created React stand-in, so the tree walkers below can
 * isolate the hook state a component consumes while being inspected.
 */
let probeReact = null;

/** Minimal React stand-in: element construction, hooks, and effects that run. */
function makeReact() {
	let hooks = [];
	let cursor = 0;
	probeReact = {
		createElement: (type, props, ...children) => ({
			type,
			props: { ...(props ?? {}), ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
		}),
		Fragment: Symbol.for("react.fragment"),
		__reset: () => { hooks = []; cursor = 0 },
		__rewind: () => { cursor = 0 },
		// 遍历（collectText/collectElements）展开函数组件时，会二次调用组件函数。
		// 没有快照/恢复的话，那次调用会**再消耗一组 hooks 槽位**，真实的渲染读到的
		// 就是另一组——表现为「点击标题展不开」。真实 React 里每个组件有自己的
		// hooks 单元，所以这里按「遍历产生的状态一律回滚」来对齐这个语义。
		__snapshot: () => ({ cursor, length: hooks.length }),
		__restore: (snap) => { cursor = snap.cursor; hooks.length = snap.length },
		useState: (initial) => {
			const index = cursor++;
			if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
			return [hooks[index], (next) => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next }];
		},
		useMemo: (factory, deps) => {
			const index = cursor++;
			const previous = hooks[index];
			const changed = previous === undefined
				|| !Array.isArray(deps)
				|| previous.deps.length !== deps.length
				|| deps.some((dep, i) => !Object.is(dep, previous.deps[i]));
			if (changed) hooks[index] = { value: factory(), deps: Array.isArray(deps) ? [...deps] : [] };
			return hooks[index].value;
		},
		useEffect: (effect) => {
			cursor++;
			try {
				effect();
			} catch {
				/* effects only need to run; their cleanups are irrelevant here */
			}
		}
	};
	return probeReact;
}

/** Run `inspect` with the hook cursor isolated, then roll back whatever it consumed. */
function isolatedInspect(inspect) {
	if (probeReact === null) return inspect();
	const snapshot = probeReact.__snapshot();
	try {
		return inspect();
	} finally {
		probeReact.__restore(snapshot);
	}
}

/** Stand-in for @deepseek-ai/dsh-client-ui-primitives (a shell static-table module). */
function makePrimitives(react) {
	const icon = (name) => (props) => react.createElement("span", {
		...props,
		className: `x-icon x-icon-${name} ${props?.className ?? ""}`.trim()
	});
	return {
		Tag: (props) => react.createElement("span", { ...props, className: `x-tag ${props.className ?? ""}`.trim() }),
		Switch: (props) => react.createElement("button", {
			type: "button",
			className: "x-switch",
			"aria-checked": String(props.checked),
			disabled: props.disabled,
			title: props.label,
			onClick: () => props.onChange?.(!props.checked)
		}),
		IconChevronUpOutline14: icon("up"),
		IconChevronDownOutline14: icon("down"),
		IconPlusOutline16: icon("plus"),
		IconTrashOutline16: icon("trash")
	};
}

function loadBundle(react, primitives = makePrimitives(react)) {
	let captured;
	const requireStub = (id) => {
		if (id === "react") return react;
		if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
		throw new Error(`unexpected require: ${id}`);
	};
	globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec } } };
	try {
		// eslint-disable-next-line no-new-func
		new Function("require", bundleSource)(requireStub);
	} finally {
		globalThis.window = undefined;
	}
	assert.equal(captured?.id, "dsh-codex-approval");
	return captured.factory(requireStub);
}

function collectText(node, out = []) {
	if (node === null || node === undefined || typeof node === "boolean") return out;
	if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out }
	if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
	if (typeof node.type === "function") return isolatedInspect(() => collectText(node.type(node.props), out));
	collectText(node.props?.children, out);
	return out;
}

function collectElements(node, out = []) {
	if (node === null || node === undefined || typeof node !== "object") return out;
	if (Array.isArray(node)) { for (const child of node) collectElements(child, out); return out }
	if (typeof node.type === "function") return isolatedInspect(() => collectElements(node.type(node.props), out));
	out.push(node);
	collectElements(node.props?.children, out);
	return out;
}

const byClass = (tree, klass) => collectElements(tree).filter((element) => String(element.props?.className ?? "").includes(klass));

const CATALOG = {
	routableProviders: ["cpa-wx301", "deepseek-official"],
	groups: [
		{ id: "cpa-wx301", name: "CPA WX301", models: [{ id: "command/deepseek/deepseek-v4.1-flash", name: "V4.1 Flash" }] },
		{ id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-flash", name: "DeepSeek Flash" }] }
	],
	failures: [{ id: "opencode-go", name: "OpenCode Go", message: "Insufficient balance." }]
};

function makeScope(value) {
	const state = { value, revision: 1, writable: true, mutated: null };
	return {
		getSnapshot: () => ({ status: "ready", ...state }),
		subscribe: () => () => {},
		mutate: async (ops) => { state.mutated = ops },
		state
	};
}

/**
 * Drive the real apply(): capture the card component and its slot props.
 *
 * The fake ctx must supply `get(name, strict)` because the plugin resolves the
 * settings service by probing (`settingsScope` on 0.1.x / `configForms` on
 * 0.2.0) rather than declaring either in `inject` — declaring one would leave
 * the other version's fiber pending forever.
 */
function mountCard(mod, { value, modelCatalog = null }) {
	const scope = makeScope(value);
	let component;
	let slotProps;
	const services = {
		settingsScope: { bind: () => scope },
		...modelCatalog === null ? {} : { "remote.session": { modelCatalog } },
		slots: {
			inject: (_slot, factory) => factory(),
			register: (spec, card) => { component = card; slotProps = spec.inject() }
		}
	};
	const ctx = {
		get: (name) => services[name],
		logger: { warn: () => {} },
		locale: { register: () => {}, bind: () => () => "dsh-codex-approval" },
		effect: (fn) => { fn(); },
		inject: (_services, callback) => { callback(services) }
	};
	mod.apply(ctx);
	// Built exactly the way the plugin builds it, so the catalog assertions run
	// against the same loader the card would receive in the browser.
	const loadModelCatalog = modelCatalog === null ? undefined : resolveModelCatalogLoader(services);
	return { scope, component, slotProps, loadModelCatalog };
}

/** Render once (collapsed), click the header, re-render expanded. */
function expand(react, component, props) {
	react.__reset();
	const collapsed = component(props);
	const header = collectElements(collapsed).find((element) => element.type === "button" && String(element.props?.className ?? "").includes("dsh-ca-header"));
	assert.ok(header !== undefined, "the card renders a header button");
	header.props.onClick({ preventDefault() {} });
	react.__rewind();
	return component(props);
}

/** Expand, then let the async catalog load land in a third pass. */
async function expandWithCatalog(react, component, props) {
	expand(react, component, props);
	await new Promise((resolve) => setTimeout(resolve, 0));
	react.__rewind();
	return component(props);
}

const VALUE = { provider: "cpa-wx301", model: "command/deepseek/deepseek-v4.1-flash", fallbacks: [{ provider: "deepseek-official", model: "deepseek-flash" }] };

/** The risk-tolerance `<select>`, found by its option values rather than its position. */
function toleranceSelect(tree) {
	return collectElements(tree)
		.filter((element) => element.type === "select")
		.find((select) => collectElements(select)
			.filter((element) => element.type === "option")
			.map((option) => option.props.value)
			.join(",") === "low,medium,high");
}

/** The default-approval-mode `<select>`, found by its option values. */
function modeSelect(tree) {
	return collectElements(tree)
		.filter((element) => element.type === "select")
		.find((select) => collectElements(select)
			.filter((element) => element.type === "option")
			.map((option) => option.props.value)
			.join(",") === "manual,ai,ai-auto");
}

const optionLabels = (select) => collectElements(select)
	.filter((element) => element.type === "option")
	.map((option) => collectText(option.props.children).join(""));

test("bundle: loads, exports inject and registers the settings card", () => {
	const react = makeReact();
	const mod = loadBundle(react);
	// 设置服务只能**探测**、不能声明：0.1.x 有 settingsScope、0.2.0 有 configForms，
	// 两个都写进 inject 必有一版永远 pending，所以 inject 里两个都不出现。
	assert.deepEqual(mod.inject, ["locale", "slots", "remote", "remote.session"]);
	assert.equal(typeof mod.apply, "function");

	let registered;
	let registeredSlot;
	let services;
	let boundNamespace;
	const injections = [];
	mod.apply({
		get: (name) => name === "settingsScope"
			? { bind: (binding) => { boundNamespace = binding?.namespace; return makeScope({}) } }
			: undefined,
		logger: { warn: () => {} },
		locale: { register: () => {}, bind: () => () => "dsh-codex-approval" },
		effect: (fn) => { fn(); },
		inject: (injected, callback) => {
			injections.push(injected);
			// 只有主 fiber 会注册；另两条是等待 settings 服务的分支。
			if (!injected.includes("slots")) return;
			services = injected;
			callback({
				slots: {
					inject: (slot, factory) => { registeredSlot = slot; factory() },
					register: (spec) => { registered = spec }
				}
			});
		}
	});
	assert.deepEqual(services, ["slots", "locale", "remote", "remote.session"]);
	assert.equal(registeredSlot, "settings.section");
	assert.equal(registered.name, "settings.section");
	assert.equal(registered.id, "dsh-codex-approval");
	assert.equal(registered.locale, "dsh-codex-approval");
	// 卡片从闭包拿表单与目录加载器，slot 注入声明是空的。
	assert.deepEqual(registered.inject(), {});
	// 0.1.x 的命名空间名仍然被探测到（另一版走 configForms）。
	assert.equal(boundNamespace, "dsh-codex-approval-config");
	// 两个候选服务各挂一条等待分支，服务迟到时还能补注册。
	assert.ok(injections.some((list) => list.length === 1 && list[0] === "settingsScope"), "waits for settingsScope");
	assert.ok(injections.some((list) => list.length === 1 && list[0] === "configForms"), "waits for configForms");
});

test("card: is a collapsed plugin card that expands into the full form", () => {
	const react = makeReact();
	const mod = loadBundle(react);
	const { component, scope, slotProps, loadModelCatalog } = mountCard(mod, { value: VALUE });
	assert.equal(typeof component, "function");
	// 表单与目录加载器都由注册闭包提供，slot 声明不再注入服务。
	assert.deepEqual(slotProps, {});

	react.__reset();
	const collapsed = component({ settingsScope: scope, loadModelCatalog });
	// `settings.section` 的 owner 期望一个列表容器，卡片是其中的 `<li>`
	// （与内置插件卡片同构）。
	assert.equal(collapsed.type, "ul", "the section renders a list container");
	assert.match(String(collapsed.props.className), /dsh-ca-sectionList/);
	const collapsedCard = collectElements(collapsed)
		.find((element) => String(element.props?.className ?? "").includes("dsh-ca-card"));
	assert.ok(collapsedCard !== undefined, "the card renders inside the list");
	assert.equal(collapsedCard.type, "li", "cards render as <li> inside the section's <ul>");
	assert.equal(byClass(collapsed, "dsh-ca-header").length, 1);
	assert.equal(byClass(collapsed, "dsh-ca-chevron").length, 1);
	assert.equal(byClass(collapsed, "dsh-ca-body").length, 0, "the body is hidden while collapsed");
	assert.match(collectText(collapsed).join(" | "), /审批模型/);
	assert.doesNotMatch(collectText(collapsed).join(" | "), /风险容忍度/, "fields live in the expanded body");

	const tree = expand(react, component, { settingsScope: scope, loadModelCatalog });
	const text = collectText(tree).join(" | ");
	const openCard = collectElements(tree)
		.find((element) => String(element.props?.className ?? "").includes("dsh-ca-card"));
	assert.match(String(openCard?.props.className), /dsh-ca-cardOpen/);
	assert.match(text, /主模型/);
	assert.match(text, /回退模型/);
	assert.match(text, /添加回退模型/);
	// UI 精简：旧的「兜底候选」与「调用顺序」那行都已删除，钉住它们不再回来。
	assert.doesNotMatch(text, /兜底候选|未配置兜底/);
	assert.doesNotMatch(text, /调用顺序/);
	assert.doesNotMatch(text, /undefined/, `card leaked "undefined": ${text}`);

	assert.equal(collectElements(tree).filter((element) => element.type === "select").length, 6, "primary + 1 fallback + 4 policy selects（默认审批模式 / 风险容忍度 / AI 故障时 / 上下文）");
	// 默认审批模式进了表单：它是配置层的 `mode`，也是 `/approval-mode default` 的落点。
	assert.match(text, /默认审批模式/);
	assert.match(text, /会话内用 \/approval-mode 覆盖/);
	// 无人值守的三道红线不再有控件、也不再占一段说明文字：它们写死 deny。
	assert.doesNotMatch(text, /ai-auto 模式下遇到 ask/);
	assert.doesNotMatch(text, /高风险无授权无人值守时/);
	assert.doesNotMatch(text, /红条（发布\/凭据）无人值守时/);
	assert.doesNotMatch(text, /固定拒绝，无开关/);
	// 判定上下文进了表单，且带字符上限（术语统一为「上下文」，不再叫「会话骨架」）。
	assert.match(text, /上下文/);
	assert.match(text, /上下文字符上限/);
	assert.doesNotMatch(text, /会话骨架/);
	assert.equal(byClass(tree, "dsh-ca-save").length, 1);
	assert.equal(byClass(tree, "dsh-ca-discard").length, 1);
	assert.equal(byClass(tree, "dsh-ca-save")[0].props.disabled, true, "save is disabled until something changes");
	assert.equal(byClass(tree, "dsh-ca-discard")[0].props.disabled, true);
	assert.equal(byClass(tree, "x-switch").length, 1, "the deny-feedback switch renders");
	assert.equal(byClass(tree, "x-icon-trash").length, 1, "one remove button per fallback row");
});

test("card: an edit marks the card unsaved and enables save", () => {
	const react = makeReact();
	const mod = loadBundle(react);
	const { component, scope, slotProps, loadModelCatalog } = mountCard(mod, { value: VALUE });
	const props = { settingsScope: scope, loadModelCatalog: loadModelCatalog };
	let tree = expand(react, component, props);

	const tolerance = toleranceSelect(tree);
	assert.ok(tolerance !== undefined, "the card renders the risk-tolerance select");
	tolerance.props.onChange({ target: { value: "high" } });
	react.__rewind();
	tree = component(props);

	assert.equal(byClass(tree, "dsh-ca-pending").length, 1, "the unsaved tag appears");
	assert.equal(collectText(byClass(tree, "dsh-ca-pending")[0]).join(""), "未保存");
	assert.equal(byClass(tree, "dsh-ca-save")[0].props.disabled, false);
	assert.equal(byClass(tree, "dsh-ca-discard")[0].props.disabled, false);
});

test("card: the default approval mode is selectable and saves as one live field", async () => {
	const react = makeReact();
	const mod = loadBundle(react);
	const { component, scope, loadModelCatalog } = mountCard(mod, { value: VALUE });
	const props = { settingsScope: scope, loadModelCatalog };
	let tree = expand(react, component, props);

	const select = modeSelect(tree);
	assert.ok(select !== undefined, "the card renders the default-approval-mode select");
	// `mode` 是配置层唯一带默认值的 live 标量，未配置时显示内置默认（服务端
	// `DEFAULT_CONFIG.mode`），与 `/approval-mode default` 的落点一致。
	assert.equal(select.props.value, "ai", "未配置时显示内置默认 ai");

	// 标签只留名字：括号里的后果说明于 2026-10-06 按要求删除（字段名已经叫
	// 「默认审批模式」，再写「（默认）」是重复）。完整后果住在 docs/configuration.md
	// 与 docs/client-card.md；这里反向钉住括号不再回来。
	const labels = optionLabels(select);
	assert.equal(labels.length, 3);
	assert.equal(labels[0], "manual · 仅人工");
	assert.equal(labels[1], "ai · AI 判定 + 人工兜底");
	assert.equal(labels[2], "ai-auto · AI 全自动");
	for (const label of labels) {
		assert.ok(!label.includes("（"), `${label} 不应再带括号说明`);
	}

	select.props.onChange({ target: { value: "manual" } });
	react.__rewind();
	tree = component(props);
	assert.equal(modeSelect(tree).props.value, "manual", "草稿立即反映在控件上");

	byClass(tree, "dsh-ca-save")[0].props.onClick();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(scope.state.mutated, [{ op: "set", path: ["mode"], value: "manual" }],
		"保存只写 mode 一个字段，路径就是 entry config / 设置命名空间的顶层键");
});

test("card: an already-configured default mode wins over the display fallback", () => {
	const react = makeReact();
	const mod = loadBundle(react);
	const { component, loadModelCatalog } = mountCard(mod, { value: { ...VALUE, mode: "ai-auto" } });
	const scope = makeScope({ ...VALUE, mode: "ai-auto" });
	const tree = expand(react, component, { settingsScope: scope, loadModelCatalog });
	assert.equal(modeSelect(tree).props.value, "ai-auto");
});

test("card: catalog options carry availability and the primary diagnostic shows", async () => {
	const react = makeReact();
	const mod = loadBundle(react);
	const healthy = async () => ({ ok: true, value: CATALOG });
	const mounted = mountCard(mod, { value: { provider: "opencode-go", model: "deepseek-v4-flash", fallbacks: [] }, modelCatalog: healthy });
	assert.equal(typeof mounted.loadModelCatalog, "function", "the loader is bound on our own fiber");

	const tree = await expandWithCatalog(react, mounted.component, { settingsScope: mounted.scope, loadModelCatalog: mounted.loadModelCatalog });
	const elements = collectElements(tree);
	assert.deepEqual(elements.filter((element) => element.type === "optgroup").map((element) => element.props.label), ["可用"]);
	const options = elements.filter((element) => element.type === "option").map((element) => collectText(element.props.children).join(""));
	assert.ok(options.includes("CPA WX301 / V4.1 Flash"), `catalog option missing: ${JSON.stringify(options)}`);
	assert.ok(options.includes("DeepSeek / DeepSeek Flash"), `catalog option missing: ${JSON.stringify(options)}`);
	// the configured value is absent from the catalog → it stays selectable
	assert.ok(options.includes("opencode-go / deepseek-v4-flash（不在模型目录中）"), `pinned value missing: ${JSON.stringify(options)}`);
	assert.match(collectText(tree).join(" | "), /该 provider 当前不可用：.*Insufficient balance\./);
});

test("card: a downgraded catalog sinks unavailable providers and flags a dead primary", async () => {
	const react = makeReact();
	const mod = loadBundle(react);
	const degraded = async () => ({ ok: true, value: { ...CATALOG, routableProviders: ["deepseek-official"] } });
	const mounted = mountCard(mod, { value: { provider: "cpa-wx301", model: "command/deepseek/deepseek-v4.1-flash", fallbacks: [] }, modelCatalog: degraded });

	const tree = await expandWithCatalog(react, mounted.component, { settingsScope: mounted.scope, loadModelCatalog: mounted.loadModelCatalog });
	const elements = collectElements(tree);
	assert.deepEqual(elements.filter((element) => element.type === "optgroup").map((element) => element.props.label), ["可用", "不可用（渠道失败或未路由）"]);
	const options = elements.filter((element) => element.type === "option").map((element) => collectText(element.props.children).join(""));
	assert.ok(options.includes("⚠ CPA WX301 / V4.1 Flash"), `unavailable marking missing: ${JSON.stringify(options)}`);
	assert.match(collectText(tree).join(" | "), /该 provider 当前不可路由/);
});

test("card: risk-tolerance copy agrees with the judge's actual permissiveness", async () => {
	const { decidePolicy } = await import("../judge.js");
	const react = makeReact();
	const mod = loadBundle(react);
	const { component, scope, slotProps, loadModelCatalog } = mountCard(mod, { value: VALUE });
	const tree = expand(react, component, { settingsScope: scope, loadModelCatalog: loadModelCatalog });

	// The risk-tolerance select is found by its option values, not its position.
	const tolerance = toleranceSelect(tree);
	const options = collectElements(tolerance).filter((element) => element.type === "option");
	assert.deepEqual(options.map((option) => option.props.value), ["low", "medium", "high"]);
	const labels = options.map((option) => collectText(option.props.children).join(""));

	// Ground truth from the policy layer: a higher tolerance is more permissive,
	// with two deliberate exceptions that no tolerance can wave through — a high
	// risk, and a judge that doubts a medium-or-worse action, both without the
	// user having asked for exactly this.
	assert.equal(decidePolicy({ risk: "high", authorization: "ask" }, { tolerance: "low" }).action, "ask");
	assert.equal(decidePolicy({ risk: "medium", authorization: "ask" }, { tolerance: "low" }).action, "ask");
	assert.equal(decidePolicy({ risk: "medium", authorization: "ask" }, { tolerance: "high" }).action, "ask");
	assert.equal(decidePolicy({ risk: "low", authorization: "ask" }, { tolerance: "low" }).action, "allow");
	assert.equal(decidePolicy({ risk: "low", authorization: "ask" }, { tolerance: "high" }).action, "allow");
	assert.equal(decidePolicy({ risk: "medium", authorization: "ask", userAuthorization: "strong" }, { tolerance: "medium" }).action, "allow");
	assert.equal(decidePolicy({ risk: "medium", authorization: "allow", userAuthorization: "strong" }, { tolerance: "medium" }).action, "allow");
	assert.equal(decidePolicy({ risk: "high", authorization: "allow", userAuthorization: "strong" }, { tolerance: "low" }).action, "allow");

	// The copy must not claim the opposite of that, which is exactly what the
	// shipped labels did ("low · 尽量放行" / "high · 尽量询问").
	assert.match(labels[0], /严格/);
	assert.match(labels[2], /宽松/);
	assert.doesNotMatch(labels[0], /尽量放行|宽松/);
	assert.doesNotMatch(labels[2], /尽量询问|严格/);
	// UI 精简（2026-10-06）：风险范围的说明文字从卡片移除，只留方向词。
	// 那条「两档与档位无关的底线」写在 docs/configuration.md 与 decision-chain.md。
	assert.doesNotMatch(collectText(tree).join(" | "), /越高越宽松/);
});
