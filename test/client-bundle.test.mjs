import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

/** Minimal React stand-in: element construction, hooks, and effects that run. */
function makeReact() {
	let hooks = [];
	let cursor = 0;
	return {
		createElement: (type, props, ...children) => ({
			type,
			props: { ...(props ?? {}), ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
		}),
		Fragment: Symbol.for("react.fragment"),
		__reset: () => { hooks = []; cursor = 0 },
		__rewind: () => { cursor = 0 },
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
	if (typeof node.type === "function") return collectText(node.type(node.props), out);
	collectText(node.props?.children, out);
	return out;
}

function collectElements(node, out = []) {
	if (node === null || node === undefined || typeof node !== "object") return out;
	if (Array.isArray(node)) { for (const child of node) collectElements(child, out); return out }
	if (typeof node.type === "function") return collectElements(node.type(node.props), out);
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

/** Drive the real apply(): capture the card component and its slot props. */
function mountCard(mod, { value, modelCatalog = null }) {
	const scope = makeScope(value);
	let component;
	let slotProps;
	mod.apply({
		inject: (_services, callback) => {
			callback({
				settingsScope: { bind: () => scope },
				...modelCatalog === null ? {} : { "remote.session": { modelCatalog } },
				slots: {
					inject: (_slot, factory) => factory(),
					register: (spec, card) => { component = card; slotProps = spec.inject() }
				}
			});
		}
	});
	return { scope, component, slotProps };
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

test("bundle: loads, exports inject and registers the settings card", () => {
	const react = makeReact();
	const mod = loadBundle(react);
	assert.deepEqual(mod.inject, ["locale", "settingsScope", "slots", "remote", "remote.session"]);
	assert.equal(typeof mod.apply, "function");

	let registered;
	let services;
	mod.apply({
		inject: (injected, callback) => {
			services = injected;
			callback({
				settingsScope: { bind: (binding) => { assert.deepEqual(binding, { namespace: "dsh-codex-approval-config" }); return makeScope({}) } },
				slots: { inject: (slot, factory) => { assert.equal(slot, "settings.plugin.item"); factory() }, register: (spec) => { registered = spec } }
			});
		}
	});
	assert.deepEqual(services, ["slots", "settingsScope", "locale", "remote", "remote.session"]);
	assert.equal(registered.name, "settings.plugin.item");
	assert.equal(registered.key, "dsh-codex-approval-config");
	assert.equal(registered.locale, "dsh-codex-approval");
	assert.equal(typeof registered.inject().settingsScope.mutate, "function");
});

test("card: is a collapsed plugin card that expands into the full form", () => {
	const react = makeReact();
	const mod = loadBundle(react);
	const { component, scope, slotProps } = mountCard(mod, { value: VALUE });
	assert.equal(typeof component, "function");
	assert.deepEqual(Object.keys(slotProps).sort(), ["loadModelCatalog", "settingsScope"]);

	react.__reset();
	const collapsed = component({ settingsScope: scope, loadModelCatalog: slotProps.loadModelCatalog });
	assert.equal(collapsed.type, "li", "cards render as <li> inside the section's <ul>");
	assert.match(String(collapsed.props.className), /dsh-ca-card/);
	assert.equal(byClass(collapsed, "dsh-ca-header").length, 1);
	assert.equal(byClass(collapsed, "dsh-ca-chevron").length, 1);
	assert.equal(byClass(collapsed, "dsh-ca-body").length, 0, "the body is hidden while collapsed");
	assert.match(collectText(collapsed).join(" | "), /审批模型/);
	assert.doesNotMatch(collectText(collapsed).join(" | "), /风险容忍度/, "fields live in the expanded body");

	const tree = expand(react, component, { settingsScope: scope, loadModelCatalog: slotProps.loadModelCatalog });
	const text = collectText(tree).join(" | ");
	assert.match(String(tree.props.className), /dsh-ca-cardOpen/);
	assert.match(text, /主模型/);
	assert.match(text, /兜底候选/);
	assert.match(text, /添加兜底候选/);
	assert.match(text, /调用顺序：/);
	assert.match(text, /cpa-wx301 \/ command\/deepseek\/deepseek-v4\.1-flash → deepseek-official \/ deepseek-flash/);
	assert.doesNotMatch(text, /undefined/, `card leaked "undefined": ${text}`);

	assert.equal(collectElements(tree).filter((element) => element.type === "select").length, 5, "primary + 1 fallback + 3 policy selects");
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
	const { component, scope, slotProps } = mountCard(mod, { value: VALUE });
	const props = { settingsScope: scope, loadModelCatalog: slotProps.loadModelCatalog };
	let tree = expand(react, component, props);

	const tolerance = collectElements(tree).filter((element) => element.type === "select")[3];
	tolerance.props.onChange({ target: { value: "high" } });
	react.__rewind();
	tree = component(props);

	assert.equal(byClass(tree, "dsh-ca-pending").length, 1, "the unsaved tag appears");
	assert.equal(collectText(byClass(tree, "dsh-ca-pending")[0]).join(""), "未保存");
	assert.equal(byClass(tree, "dsh-ca-save")[0].props.disabled, false);
	assert.equal(byClass(tree, "dsh-ca-discard")[0].props.disabled, false);
});

test("card: catalog options carry availability and the primary diagnostic shows", async () => {
	const react = makeReact();
	const mod = loadBundle(react);
	const healthy = async () => ({ ok: true, value: CATALOG });
	const mounted = mountCard(mod, { value: { provider: "opencode-go", model: "deepseek-v4-flash", fallbacks: [] }, modelCatalog: healthy });
	assert.equal(typeof mounted.slotProps.loadModelCatalog, "function", "the loader is bound on our own fiber");

	const tree = await expandWithCatalog(react, mounted.component, { settingsScope: mounted.scope, loadModelCatalog: mounted.slotProps.loadModelCatalog });
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

	const tree = await expandWithCatalog(react, mounted.component, { settingsScope: mounted.scope, loadModelCatalog: mounted.slotProps.loadModelCatalog });
	const elements = collectElements(tree);
	assert.deepEqual(elements.filter((element) => element.type === "optgroup").map((element) => element.props.label), ["可用", "不可用（渠道失败或未路由）"]);
	const options = elements.filter((element) => element.type === "option").map((element) => collectText(element.props.children).join(""));
	assert.ok(options.includes("⚠ CPA WX301 / V4.1 Flash"), `unavailable marking missing: ${JSON.stringify(options)}`);
	assert.match(collectText(tree).join(" | "), /该 provider 当前不可路由/);
});
