import { test } from "node:test";
import assert from "node:assert/strict";
import { installConfigSettings, CONFIG_SETTINGS_NAMESPACE } from "../index.js";

/**
 * `installConfigSettings` exists because DSH 0.1.5 changed the settings API:
 * `settings.register()` now returns the namespace's owner scope and the service
 * exposes no `watch`, so watching through the service throws and live updates
 * silently stop (and the settings card never sees changes). These tests pin both
 * the 0.1.5 owner-scope shape and the older service-level shape.
 */

/** A settings service stub in the 0.1.5 owner-scope shape. */
function makeScopedSettings(initial) {
	const watchers = [];
	const calls = { register: [] };
	return {
		calls,
		watchers,
		register: (ns, schema, options) => {
			calls.register.push({ ns, schema, options });
			let current = { ...(options?.base ?? {}), ...(initial ?? {}) };
			return {
				get: () => current,
				watch: (callback) => {
					watchers.push(callback);
					return () => {};
				},
				update: () => {},
				replace: () => {}
			};
		},
		// A service-level watch must never be needed on this shape.
		get: () => {
			throw new Error("service-level get must not be used when the scope provides one");
		},
		watch: () => {
			throw new Error("service-level watch must not be used when the scope provides one");
		},
		emit: (next) => { for (const callback of watchers) callback(next); }
	};
}

/** A settings service stub in the older service-level shape. */
function makeServiceSettings() {
	const watchers = [];
	let current = { provider: "service/provider", model: "service/model" };
	return {
		watchers,
		register: (ns, schema, options) => {
			// 0.1.2 returned nothing useful; callers read through the service.
			return undefined;
		},
		get: () => current,
		watch: (callback) => {
			watchers.push(callback);
			return () => {};
		},
		emit: (next) => { current = next; for (const callback of watchers) callback(next); }
	};
}

const BASE = { provider: "cpa-wx301", model: "command/deepseek/deepseek-v4.1-flash", fallbacks: [{ provider: "deepseek-official", model: "deepseek-flash" }] };

test("owner-scope settings: registers the namespace and watches through the returned scope", () => {
	const settings = makeScopedSettings({ provider: "cpa-wx301", model: "command/deepseek/deepseek-v4.1-flash" });
	const seen = [];
	const records = [];
	const initial = installConfigSettings({
		settings,
		base: BASE,
		onValue: (value) => seen.push(value),
		record: (entry) => records.push(entry)
	});

	assert.equal(settings.calls.register.length, 1);
	assert.equal(settings.calls.register[0].ns, CONFIG_SETTINGS_NAMESPACE);
	assert.equal(settings.calls.register[0].options.applies, "live");
	assert.deepEqual(settings.calls.register[0].options.base, BASE);
	assert.equal(initial.model, "command/deepseek/deepseek-v4.1-flash");
	assert.equal(seen.length, 1, "the current value is applied once at install time");

	settings.emit({ provider: "cpa-wx301", model: "opencode/deepseek-flash" });
	assert.equal(seen.length, 2, "a committed write reaches the runtime config");
	assert.equal(seen[1].model, "opencode/deepseek-flash");

	assert.deepEqual(records.map((entry) => [entry.event, entry.ok, entry.scope]), [["config-settings", true, "owner-scope"]]);
	assert.ok(records[0].fields.includes("fallbacks"), `self-proving record lists the fields: ${JSON.stringify(records[0])}`);
});

test("service settings: still works on the older service-level API", () => {
	const settings = makeServiceSettings();
	const seen = [];
	const records = [];
	installConfigSettings({ settings, base: BASE, onValue: (value) => seen.push(value), record: (entry) => records.push(entry) });

	assert.equal(seen[0].model, "service/model");
	settings.emit({ provider: "p", model: "m" });
	assert.equal(seen[1].model, "m");
	assert.equal(records[0].scope, "service");
});

test("a registration failure is reported, not swallowed silently", () => {
	const records = [];
	const errors = [];
	const result = installConfigSettings({
		settings: { register: () => { throw new Error("settings namespace \"dsh-codex-approval-config\" is already registered"); } },
		base: BASE,
		onValue: () => { throw new Error("must not run"); },
		record: (entry) => records.push(entry),
		logger: { error: (...args) => errors.push(args.join(" ")) }
	});
	assert.equal(result, undefined);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /already registered/);
	assert.deepEqual(records.map((entry) => [entry.event, entry.ok]), [["config-settings", false]]);
	assert.match(records[0].error, /already registered/);
});
