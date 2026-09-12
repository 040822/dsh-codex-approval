/**
 * dsh-codex-approval — client-model-picker.js
 *
 * Pure, JSX-free helpers for the settings card's judge-model picker: turn the
 * host's model catalog into selectable options, order them so dead providers
 * sink to the bottom, and validate the fallback chain before it is saved.
 *
 * Kept out of the .tsx so it can be unit-tested with `node --test` (the card
 * itself needs a browser React runtime; this module needs nothing).
 */

/** Upper bound on the fallback chain — must match index.js `MAX_FALLBACKS`. */
export const MAX_FALLBACKS = 4;

/** Stable key for one provider/model pair (NUL-joined, matching the card's values). */
export function optionKey(provider, model) {
	return `${provider}\u0000${model}`;
}

/**
 * The selectable judge models for a catalog snapshot.
 *
 * A provider is unavailable when its catalog lookup failed (`failures`) or the
 * host does not list it as currently routable. Unavailable providers stay
 * selectable — they are marked and sorted last, never hidden, so a route that
 * is merely cooling down can still be picked deliberately.
 *
 * @param catalog - host `session.modelCatalog()` value, or null while loading
 * @param fallbackModels - static list used when the catalog is empty/unavailable
 * @returns Array<{ provider, model, label, available, note? }>
 */
export function buildModelOptions(catalog, fallbackModels = []) {
	const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
	const failures = new Map((Array.isArray(catalog?.failures) ? catalog.failures : []).map((failure) => [failure.id, failure.message]));
	// The field is authoritative when present — an empty array means no provider
	// can serve right now. A missing/`undefined` field states nothing, so no
	// option is penalized for it.
	const routable = Array.isArray(catalog?.routableProviders) ? new Set(catalog.routableProviders) : undefined;
	const options = [];
	for (const group of groups) {
		if (group === null || typeof group !== "object") continue;
		const failure = failures.get(group.id);
		const available = failure === undefined && (routable === undefined || routable.has(group.id));
		for (const model of Array.isArray(group.models) ? group.models : []) {
			if (model === null || typeof model !== "object") continue;
			options.push({
				provider: group.id,
				model: model.id,
				label: `${group.name ?? group.id} / ${model.name ?? model.id}`,
				available,
				...failure === undefined ? {} : { note: failure }
			});
		}
	}
	if (options.length === 0) {
		for (const item of fallbackModels) {
			options.push({ provider: item.provider, model: item.model, label: `${item.provider} / ${item.model}`, available: true });
		}
	}
	return options;
}

/** Available options first, unavailable ones last; catalog order preserved within each part. */
export function splitByAvailability(options) {
	return {
		available: options.filter((option) => option.available),
		unavailable: options.filter((option) => !option.available)
	};
}

/** The option matching a provider/model pair, when the catalog has it. */
export function findOption(options, provider, model) {
	if (provider === undefined || model === undefined) return undefined;
	return options.find((option) => option.provider === provider && option.model === model);
}

/**
 * The fallback chain as stored in settings, tolerating hand-edited values:
 * malformed entries are dropped and the list is capped.
 */
export function readChain(settings, max = MAX_FALLBACKS) {
	if (!Array.isArray(settings)) return [];
	const chain = [];
	for (const entry of settings) {
		if (entry === null || typeof entry !== "object") continue;
		if (typeof entry.provider !== "string" || entry.provider === "") continue;
		if (typeof entry.model !== "string" || entry.model === "") continue;
		chain.push({ provider: entry.provider, model: entry.model });
		if (chain.length === max) break;
	}
	return chain;
}

/**
 * Why the chain cannot be saved, or "" when it can. The primary model is part
 * of the duplicate check because an entry equal to it would never be reached.
 */
export function validateChain(chain, primary) {
	if (chain.length > MAX_FALLBACKS) return `兜底最多 ${MAX_FALLBACKS} 项`;
	const seen = new Set();
	if (primary?.provider !== undefined && primary?.model !== undefined) seen.add(optionKey(primary.provider, primary.model));
	for (const entry of chain) {
		if (typeof entry?.provider !== "string" || entry.provider === "" || typeof entry?.model !== "string" || entry.model === "") {
			return "每个兜底条目都要选 provider 与 model";
		}
		const key = optionKey(entry.provider, entry.model);
		if (seen.has(key)) return `重复的候选：${entry.provider} / ${entry.model}`;
		seen.add(key);
	}
	return "";
}

/** The effective judge order: primary first, then the chain (primary dropped). */
export function buildChainSummary(primary, chain) {
	const parts = [];
	if (primary?.provider !== undefined && primary?.model !== undefined) parts.push(`${primary.provider} / ${primary.model}`);
	for (const entry of chain) {
		const label = `${entry.provider} / ${entry.model}`;
		if (!parts.includes(label)) parts.push(label);
	}
	return parts;
}
