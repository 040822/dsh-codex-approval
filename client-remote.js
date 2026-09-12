/**
 * dsh-codex-approval — client-remote.js
 *
 * Resolve the host model-catalog call against the *owning plugin's* fiber.
 *
 * The client runtime hands out services through a cordis context proxy: a
 * property that is not declared in the plugin's `inject` throws
 * `cannot get property "remote.session" without inject`. The catalog lives on
 * the dotted service `remote.session`, and slot rendering happens in the tab's
 * fiber — not ours — so the card must never touch that proxy. This helper is
 * called once inside our own `ctx.inject` callback and returns either a plain
 * bound function or a safe no-op.
 *
 * Plain JS (no JSX/TS) so `node --test` can cover it.
 */

/**
 * @param scope - the injected client context (declares `remote.session`)
 * @returns a bound `modelCatalog()` call, or undefined when the service is absent
 */
export function resolveModelCatalogLoader(scope) {
	const candidates = [
		() => scope?.remote?.session,
		() => scope?.["remote.session"]
	];
	for (const read of candidates) {
		let namespace;
		try {
			namespace = read();
		} catch {
			// The proxy refuses undeclared services; try the next spelling.
			continue;
		}
		if (namespace !== undefined && namespace !== null && typeof namespace.modelCatalog === "function") {
			return () => namespace.modelCatalog();
		}
	}
	return undefined;
}
