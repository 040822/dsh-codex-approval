import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_FALLBACKS,
	buildChainSummary,
	buildModelOptions,
	findOption,
	optionKey,
	readChain,
	splitByAvailability,
	validateChain
} from "../client-model-picker.js";

const CATALOG = {
	routableProviders: ["cpa-wx301", "deepseek-official"],
	groups: [
		{ id: "cpa-wx301", name: "CPA WX301", models: [{ id: "command/deepseek/deepseek-v4.1-flash", name: "V4.1 Flash" }, { id: "opencode/deepseek-flash" }] },
		{ id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-flash", name: "DeepSeek Flash" }] }
	],
	failures: [{ id: "opencode-go", name: "OpenCode Go", message: "Insufficient balance." }]
};

test("buildModelOptions: maps the catalog and marks unavailable providers", () => {
	const options = buildModelOptions(CATALOG);
	assert.deepEqual(options.map((option) => [option.provider, option.model, option.available]), [
		["cpa-wx301", "command/deepseek/deepseek-v4.1-flash", true],
		["cpa-wx301", "opencode/deepseek-flash", true],
		["deepseek-official", "deepseek-flash", true]
	]);
	assert.equal(options[0].label, "CPA WX301 / V4.1 Flash");
	assert.equal(options[1].label, "CPA WX301 / opencode/deepseek-flash");
});

test("buildModelOptions: a provider outside routableProviders is unavailable with no failure note", () => {
	const options = buildModelOptions({ ...CATALOG, routableProviders: ["deepseek-official"] });
	assert.equal(options[0].available, false);
	assert.equal(options[0].note, undefined);
	assert.equal(options[2].available, true);
});

test("buildModelOptions: catalog failures carry the reason and empty catalogs fall back to the static list", () => {
	const failed = buildModelOptions({
		routableProviders: [],
		groups: [{ id: "opencode-go", name: "OpenCode Go", models: [{ id: "deepseek-v4-flash" }] }],
		failures: [{ id: "opencode-go", message: "401 CreditsError" }]
	});
	assert.deepEqual(failed, [{ provider: "opencode-go", model: "deepseek-v4-flash", label: "OpenCode Go / deepseek-v4-flash", available: false, note: "401 CreditsError" }]);

	const staticOnly = buildModelOptions(null, [{ provider: "p", model: "m" }]);
	assert.deepEqual(staticOnly, [{ provider: "p", model: "m", label: "p / m", available: true }]);
	assert.deepEqual(buildModelOptions({ groups: [] }, []), []);
});

test("buildModelOptions: an empty routableProviders list marks everything unavailable, a missing field states nothing", () => {
	const empty = buildModelOptions({ ...CATALOG, routableProviders: [] });
	assert.deepEqual(empty.map((option) => option.available), [false, false, false]);

	const missing = buildModelOptions({ groups: CATALOG.groups, failures: [] });
	assert.deepEqual(missing.map((option) => option.available), [true, true, true]);
});

test("splitByAvailability: available options keep catalog order and unavailable ones sink", () => {
	const options = buildModelOptions({ ...CATALOG, routableProviders: ["deepseek-official"] });
	const { available, unavailable } = splitByAvailability(options);
	assert.deepEqual(available.map((option) => option.provider), ["deepseek-official"]);
	assert.deepEqual(unavailable.map((option) => option.provider), ["cpa-wx301", "cpa-wx301"]);
});

test("findOption / optionKey: locate the exact route and build a stable key", () => {
	const options = buildModelOptions(CATALOG);
	assert.equal(findOption(options, "deepseek-official", "deepseek-flash")?.label, "DeepSeek / DeepSeek Flash");
	assert.equal(findOption(options, "nope", "deepseek-flash"), undefined);
	assert.equal(optionKey("a", "b"), "a\u0000b");
});

test("readChain: drops malformed entries and caps the chain", () => {
	assert.deepEqual(readChain(undefined), []);
	assert.deepEqual(readChain("nope"), []);
	assert.deepEqual(readChain([null, "x", { provider: "p" }, { model: "m" }, { provider: "", model: "m" }, { provider: "p", model: "m" }]), [{ provider: "p", model: "m" }]);
	const long = Array.from({ length: 6 }, (_, index) => ({ provider: `p${index}`, model: "m" }));
	assert.equal(readChain(long).length, MAX_FALLBACKS);
	assert.equal(readChain(long, 2).length, 2);
});

test("validateChain: refuses empties, duplicates (including the primary) and oversized chains", () => {
	const primary = { provider: "cpa-wx301", model: "m" };
	assert.equal(validateChain([], primary), "");
	assert.equal(validateChain([{ provider: "p", model: "m" }], primary), "");
	assert.equal(validateChain([{ provider: "", model: "m" }], primary), "每个兜底条目都要选 provider 与 model");
	assert.equal(validateChain([{ provider: "p", model: "" }], primary), "每个兜底条目都要选 provider 与 model");
	assert.match(validateChain([{ provider: "cpa-wx301", model: "m" }], primary), /重复的候选/);
	assert.match(validateChain([{ provider: "p", model: "m" }, { provider: "p", model: "m" }], primary), /重复的候选/);
	assert.match(validateChain(Array.from({ length: MAX_FALLBACKS + 1 }, (_, index) => ({ provider: `p${index}`, model: "m" })), primary), /兜底最多 4 项/);
});

test("buildChainSummary: primary first, chain order kept, duplicates collapsed", () => {
	assert.deepEqual(buildChainSummary({ provider: "a", model: "b" }, [{ provider: "a", model: "b" }, { provider: "c", model: "d" }]), ["a / b", "c / d"]);
	assert.deepEqual(buildChainSummary(undefined, []), []);
	assert.deepEqual(buildChainSummary({}, [{ provider: "c", model: "d" }]), ["c / d"]);
});
