import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModelCatalogLoader } from "../client-remote.js";

/**
 * The client runtime's cordis proxy refuses undeclared services, and the host
 * model catalog lives on the *dotted* service `remote.session`. Reading it from
 * the wrong fiber (or with the wrong name) throws
 * `cannot get property "remote.session" without inject` and the settings card
 * dies with "slot entry crashed in 'settings.plugin.item'" — so the loader is
 * resolved once, on our own fiber, and the card only ever sees a plain function.
 */

/** A scope whose dotted service is reachable as one property. */
function makeScope(modelCatalog) {
	return { "remote.session": { modelCatalog } };
}

test("resolveModelCatalogLoader: binds the dotted service as a plain function", async () => {
	const calls = [];
	const load = resolveModelCatalogLoader(makeScope(async () => {
		calls.push("called");
		return { ok: true, value: { groups: [] } };
	}));
	assert.equal(typeof load, "function");
	assert.deepEqual(await load(), { ok: true, value: { groups: [] } });
	assert.deepEqual(calls, ["called"]);
});

test("resolveModelCatalogLoader: falls back to the chained spelling", async () => {
	const scope = { remote: { session: { modelCatalog: async () => ({ ok: true, value: "chained" }) } } };
	const load = resolveModelCatalogLoader(scope);
	assert.equal(typeof load, "function");
	assert.deepEqual(await load(), { ok: true, value: "chained" });
});

test("resolveModelCatalogLoader: a guard-throwing spelling is skipped, not fatal", async () => {
	const scope = {
		get remote() {
			throw new Error('cannot get property "remote.session" without inject');
		},
		"remote.session": { modelCatalog: async () => ({ ok: true, value: "guarded" }) }
	};
	const load = resolveModelCatalogLoader(scope);
	assert.deepEqual(await load(), { ok: true, value: "guarded" });
});

test("resolveModelCatalogLoader: returns undefined when the service is missing", () => {
	assert.equal(resolveModelCatalogLoader(undefined), undefined);
	assert.equal(resolveModelCatalogLoader({}), undefined);
	assert.equal(resolveModelCatalogLoader({ "remote.session": {} }), undefined);
	assert.equal(resolveModelCatalogLoader({ "remote.session": { modelCatalog: "not a function" } }), undefined);
});
