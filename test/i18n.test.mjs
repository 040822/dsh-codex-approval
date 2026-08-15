import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCALES, T, pickLocale, commandDescription } from "../i18n.js";

test("pickLocale: zh and en pass through", () => {
	assert.equal(pickLocale("zh"), "zh");
	assert.equal(pickLocale("en"), "en");
});

test("pickLocale: anything else falls back to en", () => {
	assert.equal(pickLocale(undefined), "en");
	assert.equal(pickLocale(null), "en");
	assert.equal(pickLocale(""), "en");
	assert.equal(pickLocale("fr"), "en");
	assert.equal(pickLocale("ZH"), "en");
	assert.equal(pickLocale("ja"), "en");
});

test("message table: zh and en expose identical keys", () => {
	const zhKeys = Object.keys(T.zh).sort();
	const enKeys = Object.keys(T.en).sort();
	assert.deepEqual(zhKeys, enKeys);
});

test("message table: every message renders for both locales", () => {
	for (const locale of LOCALES) {
		const t = T[locale];
		const samples = [
			t.showNoOverride("ai", "ai"),
			t.showWithOverride("ai-auto", "ai-auto", "ai"),
			t.cleared("ai"),
			t.clearedMemoryOnly("ai"),
			t.switched("manual"),
			t.switchedMemoryOnly("manual"),
			t.unknown("xx")
		];
		for (const sample of samples) {
			assert.equal(typeof sample, "string");
			assert.ok(sample.length > 0, `${locale} message must not be empty`);
		}
	}
});

test("zh copy is compact (no 'approval mode' echo duplication)", () => {
	assert.doesNotMatch(T.zh.switched("ai-auto"), /approval mode/);
	assert.doesNotMatch(T.en.switched("ai-auto"), /approval mode/i);
	assert.doesNotMatch(T.zh.showNoOverride("ai", "ai"), /approval-mode/);
});

test("commandDescription: bilingual", () => {
	assert.match(commandDescription("zh"), /显示或切换审批模式/);
	assert.match(commandDescription("en"), /Show or switch the approval mode/);
	assert.match(commandDescription("fr"), /Show or switch/); // falls back to en copy
});
