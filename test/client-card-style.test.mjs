import { test } from "node:test";
import assert from "node:assert/strict";
import { CARD_CSS, CARD_STYLE_ID, ensureCardStyle } from "../client-card-style.js";

/**
 * The card styles are injected into the page once, with the same
 * `data-plugin-css` convention the shipped plugins use for theirs — and the
 * values are copied from those stylesheets, so a card that "looks foreign" is a
 * regression this file can catch (borders, radius and the control height are
 * the giveaways).
 */

/** A document stub that records appended styles. */
function makeDocument() {
	const appended = [];
	const head = { appendChild: (node) => appended.push(node) };
	return {
		appended,
		head,
		querySelector: (selector) => appended.find((node) => `style[data-plugin-css=${JSON.stringify(node.getAttribute("data-plugin-css"))}]` === selector) ?? null,
		createElement: (tag) => ({
			tag,
			attributes: {},
			textContent: "",
			setAttribute(name, value) { this.attributes[name] = value },
			getAttribute(name) { return this.attributes[name] }
		})
	};
}

test("ensureCardStyle: injects one stylesheet tagged like the shipped plugins", () => {
	const doc = makeDocument();
	assert.equal(ensureCardStyle(doc), true);
	assert.equal(doc.appended.length, 1);
	assert.equal(doc.appended[0].tag, "style");
	assert.equal(doc.appended[0].getAttribute("data-plugin-css"), CARD_STYLE_ID);
	assert.equal(doc.appended[0].textContent, CARD_CSS);
});

test("ensureCardStyle: is idempotent and safe without a document", () => {
	const doc = makeDocument();
	ensureCardStyle(doc);
	ensureCardStyle(doc);
	assert.equal(doc.appended.length, 1, "a second call must not append another <style>");
	assert.equal(ensureCardStyle(undefined), false);
	assert.equal(ensureCardStyle(null), false);
});

test("card css: keeps the built-in card look (tokens, card chrome, 34px controls)", () => {
	// card chrome, copied from PluginCard.module.css
	assert.match(CARD_CSS, /\.dsh-ca-card\{[^}]*border:\.5px solid var\(--dsw-alias-border-l4\)/);
	assert.match(CARD_CSS, /\.dsh-ca-card\{[^}]*background:var\(--dsw-alias-bg-layer-3\)/);
	assert.match(CARD_CSS, /\.dsh-ca-card\{[^}]*border-radius:16px/);
	assert.match(CARD_CSS, /\.dsh-ca-cardOpen\{[^}]*background:var\(--dsw-alias-bg-layer-2\)/);
	assert.match(CARD_CSS, /\.dsh-ca-header\{[^}]*padding:14px 16px/);
	assert.match(CARD_CSS, /\.dsh-ca-name\{[^}]*font-size:15px;font-weight:600/);
	assert.match(CARD_CSS, /\.dsh-ca-description\{[^}]*color:var\(--dsw-alias-label-tertiary\);font-size:13px/);
	assert.match(CARD_CSS, /\.dsh-ca-chevronOpen\{transform:rotate\(180deg\)\}/);
	// fields, copied from fields.module.css
	assert.match(CARD_CSS, /\.dsh-ca-input,\.dsh-ca-select\{[^}]*height:34px/);
	assert.match(CARD_CSS, /\.dsh-ca-input:focus-visible,\.dsh-ca-select:focus-visible\{[^}]*border-color:var\(--dsw-alias-brand-primary\)/);
	assert.match(CARD_CSS, /\.dsh-ca-hint\{color:var\(--dsw-alias-label-tertiary\)/);
	assert.match(CARD_CSS, /\.dsh-ca-invalid\{color:var\(--dsw-alias-label-error\)/);
	// footer buttons
	assert.match(CARD_CSS, /\.dsh-ca-save\{background:var\(--dsw-alias-label-primary\);color:var\(--dsw-alias-bg-layer-3\)\}/);
	assert.match(CARD_CSS, /\.dsh-ca-discard,.dsh-ca-save\{[^}]*padding:5px 14px/);
	// no hard-coded palette: everything resolves through design tokens, except the
	// `#0000` transparent border the shipped buttons also use.
	const literals = [...new Set(CARD_CSS.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])];
	assert.deepEqual(literals, ["#0000"], `colors must come from --dsw-alias-* tokens, found ${JSON.stringify(literals)}`);
});
