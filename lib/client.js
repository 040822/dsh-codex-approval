window.__ModuleLoader__.load({ id: "dsh-codex-approval", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/DshCodexApprovalCard.tsx
var import_react = __toESM(require("react"), 1);
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// client-model-picker.js
var MAX_FALLBACKS = 4;
function optionKey(provider, model) {
  return `${provider}\0${model}`;
}
function buildModelOptions(catalog, fallbackModels2 = []) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  const failures = new Map((Array.isArray(catalog?.failures) ? catalog.failures : []).map((failure) => [failure.id, failure.message]));
  const routable = Array.isArray(catalog?.routableProviders) ? new Set(catalog.routableProviders) : void 0;
  const options = [];
  for (const group of groups) {
    if (group === null || typeof group !== "object") continue;
    const failure = failures.get(group.id);
    const available = failure === void 0 && (routable === void 0 || routable.has(group.id));
    for (const model of Array.isArray(group.models) ? group.models : []) {
      if (model === null || typeof model !== "object") continue;
      options.push({
        provider: group.id,
        model: model.id,
        label: `${group.name ?? group.id} / ${model.name ?? model.id}`,
        available,
        ...failure === void 0 ? {} : { note: failure }
      });
    }
  }
  if (options.length === 0) {
    for (const item of fallbackModels2) {
      options.push({ provider: item.provider, model: item.model, label: `${item.provider} / ${item.model}`, available: true });
    }
  }
  return options;
}
function splitByAvailability(options) {
  return {
    available: options.filter((option) => option.available),
    unavailable: options.filter((option) => !option.available)
  };
}
function findOption(options, provider, model) {
  if (provider === void 0 || model === void 0) return void 0;
  return options.find((option) => option.provider === provider && option.model === model);
}
function readChain(settings, max = MAX_FALLBACKS) {
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
function validateChain(chain, primary) {
  if (chain.length > MAX_FALLBACKS) return `\u515C\u5E95\u6700\u591A ${MAX_FALLBACKS} \u9879`;
  const seen = /* @__PURE__ */ new Set();
  if (primary?.provider !== void 0 && primary?.model !== void 0) seen.add(optionKey(primary.provider, primary.model));
  for (const entry of chain) {
    if (typeof entry?.provider !== "string" || entry.provider === "" || typeof entry?.model !== "string" || entry.model === "") {
      return "\u6BCF\u4E2A\u515C\u5E95\u6761\u76EE\u90FD\u8981\u9009 provider \u4E0E model";
    }
    const key = optionKey(entry.provider, entry.model);
    if (seen.has(key)) return `\u91CD\u590D\u7684\u5019\u9009\uFF1A${entry.provider} / ${entry.model}`;
    seen.add(key);
  }
  return "";
}
function buildChainSummary(primary, chain) {
  const parts = [];
  if (primary?.provider !== void 0 && primary?.model !== void 0) parts.push(`${primary.provider} / ${primary.model}`);
  for (const entry of chain) {
    const label = `${entry.provider} / ${entry.model}`;
    if (!parts.includes(label)) parts.push(label);
  }
  return parts;
}

// src/client/DshCodexApprovalCard.tsx
var fallbackModels = [
  { provider: "cpa-wx301", model: "command/deepseek/deepseek-v4.1-flash" },
  { provider: "deepseek-official", model: "deepseek-flash" }
];
var NUL = "\0";
var TOLERANCES = [
  { value: "low", label: "low \xB7 \u5C3D\u91CF\u653E\u884C" },
  { value: "medium", label: "medium \xB7 \u5E73\u8861\uFF08\u9ED8\u8BA4\uFF09" },
  { value: "high", label: "high \xB7 \u5C3D\u91CF\u8BE2\u95EE" }
];
var FAIL_OPEN = [
  { value: "ask", label: "ask \xB7 \u4EA4\u7ED9\u4EBA\u786E\u8BA4\uFF08\u9ED8\u8BA4\uFF09" },
  { value: "deny", label: "deny \xB7 \u62D2\u7EDD" },
  { value: "allow", label: "allow \xB7 \u653E\u884C" }
];
var MODE3_ON_ASK = [
  { value: "deny", label: "deny \xB7 \u62D2\u7EDD\uFF08\u9ED8\u8BA4\uFF09" },
  { value: "allow", label: "allow \xB7 \u653E\u884C" }
];
function Field({ label, hint, children }) {
  return /* @__PURE__ */ import_react.default.createElement("div", { className: "dsh-ca-field" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "dsh-ca-fieldHead" }, /* @__PURE__ */ import_react.default.createElement("span", { className: "dsh-ca-label" }, label)), children, hint !== void 0 ? /* @__PURE__ */ import_react.default.createElement("p", { className: "dsh-ca-hint" }, hint) : null);
}
function ModelSelect({ options, provider, model, disabled, onChange }) {
  const current = findOption(options, provider, model);
  const { available, unavailable } = splitByAvailability(options);
  const value = current ? optionKey(current.provider, current.model) : optionKey(String(provider ?? ""), String(model ?? ""));
  const renderOption = (item) => /* @__PURE__ */ import_react.default.createElement("option", { key: optionKey(item.provider, item.model), value: optionKey(item.provider, item.model) }, item.available ? item.label : `\u26A0 ${item.label}`);
  return /* @__PURE__ */ import_react.default.createElement("select", { className: "dsh-ca-select", value, disabled, onChange: (event) => {
    const [nextProvider, nextModel] = event.target.value.split(NUL);
    onChange(nextProvider, nextModel);
  } }, current === void 0 ? /* @__PURE__ */ import_react.default.createElement("option", { value }, `${String(provider ?? "")} / ${String(model ?? "")}\uFF08\u4E0D\u5728\u6A21\u578B\u76EE\u5F55\u4E2D\uFF09`) : null, /* @__PURE__ */ import_react.default.createElement("optgroup", { label: "\u53EF\u7528" }, available.map(renderOption)), unavailable.length > 0 ? /* @__PURE__ */ import_react.default.createElement("optgroup", { label: "\u4E0D\u53EF\u7528\uFF08\u6E20\u9053\u5931\u8D25\u6216\u672A\u8DEF\u7531\uFF09" }, unavailable.map(renderOption)) : null);
}
function DshCodexApprovalCard({ settingsScope, loadModelCatalog }) {
  const [snapshot, setSnapshot] = (0, import_react.useState)(() => settingsScope.getSnapshot());
  const [catalog, setCatalog] = (0, import_react.useState)(null);
  const [draft, setDraft] = (0, import_react.useState)({});
  const [message, setMessage] = (0, import_react.useState)("");
  const [open, setOpen] = (0, import_react.useState)(false);
  const [saving, setSaving] = (0, import_react.useState)(false);
  (0, import_react.useEffect)(() => settingsScope.subscribe(() => setSnapshot(() => settingsScope.getSnapshot())), [settingsScope]);
  (0, import_react.useEffect)(() => {
    if (loadModelCatalog === void 0) return;
    void loadModelCatalog().then((result) => {
      if (result?.ok) setCatalog(result.value);
    }).catch(() => void 0);
  }, [loadModelCatalog]);
  const value = { ...snapshot.value ?? {}, ...draft };
  const options = (0, import_react.useMemo)(() => buildModelOptions(catalog, fallbackModels), [catalog]);
  const chain = (0, import_react.useMemo)(() => readChain(draft.fallbacks ?? value.fallbacks), [draft.fallbacks, value.fallbacks]);
  const chainError = validateChain(chain, { provider: value.provider, model: value.model });
  const dirty = Object.keys(draft).length > 0;
  const writable = snapshot.writable !== false;
  const disabled = !writable || saving;
  const primaryFailure = catalog?.failures?.find((item) => item.id === value.provider);
  const primaryRoutable = catalog?.routableProviders === void 0 ? true : catalog.routableProviders.includes(String(value.provider ?? ""));
  const judgeOrder = buildChainSummary({ provider: value.provider, model: value.model }, chain);
  const setField = (field, next) => setDraft((current) => ({ ...current, [field]: next }));
  const setChain = (next) => setField("fallbacks", next);
  const updateChainAt = (index, provider, model) => {
    setChain(chain.map((entry, i) => i === index ? { provider, model } : entry));
  };
  const moveChain = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= chain.length) return;
    const next = [...chain];
    const [entry] = next.splice(index, 1);
    next.splice(target, 0, entry);
    setChain(next);
  };
  const addChain = () => {
    const used = new Set(judgeOrder);
    const candidate = options.find((item) => item.available && !used.has(`${item.provider} / ${item.model}`));
    setChain([...chain, candidate === void 0 ? { provider: "", model: "" } : { provider: candidate.provider, model: candidate.model }]);
  };
  const save = async () => {
    if (chainError !== "") {
      setMessage(`\u65E0\u6CD5\u4FDD\u5B58\uFF1A${chainError}`);
      return;
    }
    setSaving(true);
    try {
      const ops = Object.entries(draft).map(([path, next]) => ({ op: "set", path: [path], value: next }));
      if (ops.length > 0) await settingsScope.mutate(ops, snapshot.revision);
      setDraft({});
      setMessage("\u5DF2\u4FDD\u5B58");
    } catch (error) {
      setMessage(`\u4FDD\u5B58\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    setDraft({});
    setMessage("");
  };
  if (snapshot.status === "loading") {
    return /* @__PURE__ */ import_react.default.createElement("li", { className: "dsh-ca-card" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "dsh-ca-header" }, /* @__PURE__ */ import_react.default.createElement("span", { className: "dsh-ca-headText" }, /* @__PURE__ */ import_react.default.createElement("span", { className: "dsh-ca-name" }, "\u5BA1\u6279\u6A21\u578B"), /* @__PURE__ */ import_react.default.createElement("span", { className: "dsh-ca-description" }, "\u6B63\u5728\u8BFB\u53D6\u914D\u7F6E\u2026"))));
  }
  return /* @__PURE__ */ import_react.default.createElement("li", { className: open ? "dsh-ca-card dsh-ca-cardOpen" : "dsh-ca-card" }, /* @__PURE__ */ import_react.default.createElement("button", { type: "button", className: "dsh-ca-header", "aria-expanded": open, onClick: () => setOpen(!open) }, /* @__PURE__ */ import_react.default.createElement("span", { className: "dsh-ca-headText" }, /* @__PURE__ */ import_react.default.createElement("span", { className: "dsh-ca-name" }, "\u5BA1\u6279\u6A21\u578B"), /* @__PURE__ */ import_react.default.createElement("span", { className: "dsh-ca-description" }, `AI \u5BA1\u5224\u6A21\u578B\uFF1A\u4E3B\u6A21\u578B\u5931\u8D25\u540E\u4F9D\u6B21\u5C1D\u8BD5\u515C\u5E95\u5019\u9009\uFF08${chain.length === 0 ? "\u672A\u914D\u7F6E\u515C\u5E95" : `${chain.length} \u9879`}\uFF09`)), dirty ? /* @__PURE__ */ import_react.default.createElement(import_dsh_client_ui_primitives.Tag, { tone: "neutral", className: "dsh-ca-pending" }, "\u672A\u4FDD\u5B58") : null, /* @__PURE__ */ import_react.default.createElement(import_dsh_client_ui_primitives.IconChevronDownOutline14, { className: open ? "dsh-ca-chevron dsh-ca-chevronOpen" : "dsh-ca-chevron" })), open ? /* @__PURE__ */ import_react.default.createElement("div", { className: "dsh-ca-body" }, snapshot.status === "unavailable" ? /* @__PURE__ */ import_react.default.createElement("p", { className: "dsh-ca-readOnly" }, "\u5F53\u524D Host \u672A\u66B4\u9732\u5BA1\u6279\u914D\u7F6E namespace\u3002") : null, writable ? null : /* @__PURE__ */ import_react.default.createElement("p", { className: "dsh-ca-readOnly" }, "\u672C\u90E8\u7F72\u7684\u8BBE\u7F6E\u4E3A\u53EA\u8BFB\u3002"), /* @__PURE__ */ import_react.default.createElement(Field, { label: "\u4E3B\u6A21\u578B" }, /* @__PURE__ */ import_react.default.createElement(
    ModelSelect,
    {
      options,
      provider: value.provider,
      model: value.model,
      disabled,
      onChange: (provider, model) => {
        setField("provider", provider);
        setField("model", model);
      }
    }
  ), primaryFailure !== void 0 ? /* @__PURE__ */ import_react.default.createElement("p", { className: "dsh-ca-invalid" }, "\u8BE5 provider \u5F53\u524D\u4E0D\u53EF\u7528\uFF1A", primaryFailure.message) : null, primaryFailure === void 0 && !primaryRoutable ? /* @__PURE__ */ import_react.default.createElement("p", { className: "dsh-ca-invalid" }, "\u8BE5 provider \u5F53\u524D\u4E0D\u53EF\u8DEF\u7531\uFF0C\u8C03\u7528\u4F1A\u76F4\u63A5\u5931\u8D25\u3002") : null), /* @__PURE__ */ import_react.default.createElement(Field, { label: `\u515C\u5E95\u5019\u9009\uFF08\u6309\u987A\u5E8F\u5C1D\u8BD5\uFF0C\u6700\u591A ${MAX_FALLBACKS} \u9879\uFF09` }, chain.length === 0 ? /* @__PURE__ */ import_react.default.createElement("p", { className: "dsh-ca-hint" }, "\u672A\u914D\u7F6E\u515C\u5E95\uFF1A\u4E3B\u6A21\u578B\u5931\u8D25\u65F6\u76F4\u63A5\u8D70\u201CAI \u6545\u969C\u65F6\u201D\u7684\u7B56\u7565\u3002") : null, chain.map((entry, index) => {
    const failure = catalog?.failures?.find((item) => item.id === entry.provider);
    return /* @__PURE__ */ import_react.default.createElement("div", { className: "dsh-ca-row", key: `${index}-${optionKey(entry.provider, entry.model)}` }, /* @__PURE__ */ import_react.default.createElement("span", { className: "dsh-ca-rowIndex" }, index + 1, "."), /* @__PURE__ */ import_react.default.createElement(
      ModelSelect,
      {
        options,
        provider: entry.provider,
        model: entry.model,
        disabled,
        onChange: (provider, model) => updateChainAt(index, provider, model)
      }
    ), failure !== void 0 ? /* @__PURE__ */ import_react.default.createElement("span", { className: "dsh-ca-rowUnavailable" }, "\u4E0D\u53EF\u7528") : null, /* @__PURE__ */ import_react.default.createElement(
      "button",
      {
        type: "button",
        className: "dsh-ca-iconButton",
        title: "\u4E0A\u79FB",
        "aria-label": "\u4E0A\u79FB",
        disabled: disabled || index === 0,
        onClick: () => moveChain(index, -1)
      },
      /* @__PURE__ */ import_react.default.createElement(import_dsh_client_ui_primitives.IconChevronUpOutline14, null)
    ), /* @__PURE__ */ import_react.default.createElement(
      "button",
      {
        type: "button",
        className: "dsh-ca-iconButton",
        title: "\u4E0B\u79FB",
        "aria-label": "\u4E0B\u79FB",
        disabled: disabled || index === chain.length - 1,
        onClick: () => moveChain(index, 1)
      },
      /* @__PURE__ */ import_react.default.createElement(import_dsh_client_ui_primitives.IconChevronDownOutline14, null)
    ), /* @__PURE__ */ import_react.default.createElement(
      "button",
      {
        type: "button",
        className: "dsh-ca-iconButton",
        title: "\u5220\u9664",
        "aria-label": "\u5220\u9664",
        disabled,
        onClick: () => setChain(chain.filter((_, i) => i !== index))
      },
      /* @__PURE__ */ import_react.default.createElement(import_dsh_client_ui_primitives.IconTrashOutline16, null)
    ));
  }), /* @__PURE__ */ import_react.default.createElement("div", { className: "dsh-ca-row" }, /* @__PURE__ */ import_react.default.createElement("button", { type: "button", className: "dsh-ca-ghostButton", disabled: disabled || chain.length >= MAX_FALLBACKS, onClick: addChain }, /* @__PURE__ */ import_react.default.createElement(import_dsh_client_ui_primitives.IconPlusOutline16, null), " \u6DFB\u52A0\u515C\u5E95\u5019\u9009")), chainError !== "" ? /* @__PURE__ */ import_react.default.createElement("p", { className: "dsh-ca-invalid" }, chainError) : null, /* @__PURE__ */ import_react.default.createElement("p", { className: "dsh-ca-order" }, "\u8C03\u7528\u987A\u5E8F\uFF1A", judgeOrder.length === 0 ? "\uFF08\u672A\u9009\u62E9\u6A21\u578B\uFF09" : judgeOrder.join(" \u2192 "))), /* @__PURE__ */ import_react.default.createElement("div", { className: "dsh-ca-grid" }, /* @__PURE__ */ import_react.default.createElement(Field, { label: "\u98CE\u9669\u5BB9\u5FCD\u5EA6" }, /* @__PURE__ */ import_react.default.createElement(
    "select",
    {
      className: "dsh-ca-select",
      value: String(value.riskTolerance ?? "medium"),
      disabled,
      onChange: (event) => setField("riskTolerance", event.target.value)
    },
    TOLERANCES.map((item) => /* @__PURE__ */ import_react.default.createElement("option", { key: item.value, value: item.value }, item.label))
  )), /* @__PURE__ */ import_react.default.createElement(Field, { label: "AI \u6545\u969C\u65F6" }, /* @__PURE__ */ import_react.default.createElement(
    "select",
    {
      className: "dsh-ca-select",
      value: String(value.failOpen ?? "ask"),
      disabled,
      onChange: (event) => setField("failOpen", event.target.value)
    },
    FAIL_OPEN.map((item) => /* @__PURE__ */ import_react.default.createElement("option", { key: item.value, value: item.value }, item.label))
  )), /* @__PURE__ */ import_react.default.createElement(Field, { label: "ai-auto \u6A21\u5F0F\u4E0B\u9047\u5230 ask" }, /* @__PURE__ */ import_react.default.createElement(
    "select",
    {
      className: "dsh-ca-select",
      value: String(value.mode3OnAsk ?? "deny"),
      disabled,
      onChange: (event) => setField("mode3OnAsk", event.target.value)
    },
    MODE3_ON_ASK.map((item) => /* @__PURE__ */ import_react.default.createElement("option", { key: item.value, value: item.value }, item.label))
  )), /* @__PURE__ */ import_react.default.createElement(Field, { label: "\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09", hint: "\u6BCF\u4E2A\u5019\u9009\u5404\u81EA\u8BA1\u65F6\uFF0C\u9ED8\u8BA4 15000" }, /* @__PURE__ */ import_react.default.createElement(
    "input",
    {
      className: "dsh-ca-input",
      type: "number",
      min: "1",
      value: Number(value.timeoutMs ?? 15e3),
      disabled,
      onChange: (event) => setField("timeoutMs", Number(event.target.value))
    }
  )), /* @__PURE__ */ import_react.default.createElement(Field, { label: "\u6700\u5927\u8F93\u51FA token", hint: "\u542B\u601D\u8003 token \u4F59\u91CF\uFF0C\u9ED8\u8BA4 512" }, /* @__PURE__ */ import_react.default.createElement(
    "input",
    {
      className: "dsh-ca-input",
      type: "number",
      min: "1",
      value: Number(value.maxTokens ?? 512),
      disabled,
      onChange: (event) => setField("maxTokens", Number(event.target.value))
    }
  ))), /* @__PURE__ */ import_react.default.createElement("div", { className: "dsh-ca-toggleRow" }, /* @__PURE__ */ import_react.default.createElement("span", { className: "dsh-ca-label" }, "\u62D2\u7EDD\u540E\u5411\u4E3B agent \u6CE8\u5165\u5F52\u56E0\u53CD\u9988"), /* @__PURE__ */ import_react.default.createElement(
    import_dsh_client_ui_primitives.Switch,
    {
      checked: Boolean(value.denyFeedback ?? true),
      label: "\u62D2\u7EDD\u540E\u5411\u4E3B agent \u6CE8\u5165\u5F52\u56E0\u53CD\u9988",
      disabled,
      onChange: (next) => setField("denyFeedback", next)
    }
  )), /* @__PURE__ */ import_react.default.createElement("div", { className: "dsh-ca-footer" }, message !== "" ? /* @__PURE__ */ import_react.default.createElement("p", { className: message.startsWith("\u4FDD\u5B58\u5931\u8D25") || message.startsWith("\u65E0\u6CD5\u4FDD\u5B58") ? "dsh-ca-failed" : "dsh-ca-hint", role: "status" }, message) : null, /* @__PURE__ */ import_react.default.createElement("button", { type: "button", className: "dsh-ca-discard", disabled: !dirty || saving, onClick: discard }, "\u653E\u5F03"), /* @__PURE__ */ import_react.default.createElement("button", { type: "button", className: "dsh-ca-save", disabled: !dirty || chainError !== "" || saving, onClick: () => void save() }, saving ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58"))) : null);
}

// client-remote.js
function resolveModelCatalogLoader(scope) {
  const candidates = [
    () => scope?.remote?.session,
    () => scope?.["remote.session"]
  ];
  for (const read of candidates) {
    let namespace;
    try {
      namespace = read();
    } catch {
      continue;
    }
    if (namespace !== void 0 && namespace !== null && typeof namespace.modelCatalog === "function") {
      return () => namespace.modelCatalog();
    }
  }
  return void 0;
}

// client-card-style.js
var CARD_STYLE_ID = "dsh-codex-approval/card.css";
var CARD_CSS = `
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
function ensureCardStyle(doc = typeof document === "undefined" ? void 0 : document) {
  if (doc === void 0 || doc === null) return false;
  if (doc.querySelector(`style[data-plugin-css=${JSON.stringify(CARD_STYLE_ID)}]`) !== null) return true;
  const style = doc.createElement("style");
  style.setAttribute("data-plugin-css", CARD_STYLE_ID);
  style.textContent = CARD_CSS;
  doc.head.appendChild(style);
  return true;
}

// src/client/index.ts
var inject = ["locale", "settingsScope", "slots", "remote", "remote.session"];
function apply(ctx) {
  ensureCardStyle();
  ctx.inject(["slots", "settingsScope", "locale", "remote", "remote.session"], (scope) => {
    const settingsScope = scope.settingsScope.bind({ namespace: "dsh-codex-approval-config" });
    const loadModelCatalog = resolveModelCatalogLoader(scope);
    scope.slots.inject("settings.plugin.item", () => scope.slots.register({
      name: "settings.plugin.item",
      key: "dsh-codex-approval-config",
      locale: "dsh-codex-approval",
      inject: () => ({ settingsScope, loadModelCatalog })
    }, DshCodexApprovalCard));
  });
}

return module.exports; } });
