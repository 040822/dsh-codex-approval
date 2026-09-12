/**
 * dsh-codex-approval — client-card-style.js
 *
 * The settings card's stylesheet, injected once into the page.
 *
 * The values are copied from the shipped plugin-card stylesheets
 * (`ui-settings-plugins/.../PluginCard.module.css` and `fields.module.css`) so
 * this card is visually indistinguishable from the built-in ones — same
 * `.5px` borders, 16px card radius, 34px controls, 13px labels and the
 * `--dsw-alias-*` design tokens. Class names are prefixed `dsh-ca-` to stay
 * scoped to this plugin.
 *
 * Plain JS so the client half can import it without a CSS toolchain.
 */

export const CARD_STYLE_ID = "dsh-codex-approval/card.css";

export const CARD_CSS = `
.dsh-ca-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}
.dsh-ca-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dsh-ca-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dsh-ca-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dsh-ca-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-ca-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dsh-ca-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dsh-ca-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dsh-ca-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.dsh-ca-chevronOpen{transform:rotate(180deg)}
.dsh-ca-pending{flex:none}
.dsh-ca-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.dsh-ca-readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}
.dsh-ca-field{margin-top:14px;display:flex;flex-direction:column;gap:6px}
.dsh-ca-fieldHead{align-items:center;gap:8px;display:flex}
.dsh-ca-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.dsh-ca-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.dsh-ca-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.dsh-ca-input,.dsh-ca-select{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}
.dsh-ca-input{width:120px}
.dsh-ca-select{min-width:0;width:100%}
.dsh-ca-input:focus-visible,.dsh-ca-select:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dsh-ca-input:disabled,.dsh-ca-select:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dsh-ca-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px 16px;margin-top:4px}
.dsh-ca-row{align-items:center;gap:8px;display:flex}
.dsh-ca-rowIndex{color:var(--dsw-alias-label-tertiary);flex:none;min-width:14px;font-size:12px;font-variant-numeric:tabular-nums;line-height:1.5}
.dsh-ca-rowUnavailable{color:var(--dsw-alias-label-error);flex:none;font-size:12px;line-height:1.5}
.dsh-ca-iconButton{appearance:none;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid transparent;border-radius:8px;flex:none;align-items:center;justify-content:center;width:28px;height:28px;display:inline-flex}
.dsh-ca-iconButton:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ca-iconButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-ca-iconButton:disabled{opacity:.4;cursor:default}
.dsh-ca-ghostButton{appearance:none;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;align-items:center;gap:6px;padding:5px 12px;font-size:13px;line-height:1.5;display:inline-flex}
.dsh-ca-ghostButton:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dsh-ca-ghostButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-ca-ghostButton:disabled{opacity:.4;cursor:default}
.dsh-ca-toggleRow{align-items:center;justify-content:space-between;gap:12px;margin-top:14px;display:flex}
.dsh-ca-order{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.dsh-ca-footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.dsh-ca-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.dsh-ca-discard,.dsh-ca-save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsh-ca-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.dsh-ca-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dsh-ca-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsh-ca-discard:disabled,.dsh-ca-save:disabled{opacity:.4;cursor:default}
.dsh-ca-discard:focus-visible,.dsh-ca-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
`.trim();

/**
 * Inject the stylesheet once per page. Guarded by a `data-plugin-css` tag id,
 * the same convention the shipped plugins use for their own stylesheets.
 * @returns whether a document was available to inject into
 */
export function ensureCardStyle(doc = typeof document === "undefined" ? undefined : document) {
	if (doc === undefined || doc === null) return false;
	if (doc.querySelector(`style[data-plugin-css=${JSON.stringify(CARD_STYLE_ID)}]`) !== null) return true;
	const style = doc.createElement("style");
	style.setAttribute("data-plugin-css", CARD_STYLE_ID);
	style.textContent = CARD_CSS;
	doc.head.appendChild(style);
	return true;
}
