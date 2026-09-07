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
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);

// src/client/DshCodexApprovalCard.tsx
var import_react = __toESM(require("react"), 1);
var fallbackModels = [
  { provider: "opencode-go", model: "deepseek-v4-flash" },
  { provider: "cpa-wx301", model: "codex/gpt-5.6-luna" }
];
function DshCodexApprovalCard({ settingsScope, remote }) {
  const [snapshot, setSnapshot] = (0, import_react.useState)(() => settingsScope.getSnapshot());
  const [catalog, setCatalog] = (0, import_react.useState)(null);
  const [draft, setDraft] = (0, import_react.useState)({});
  const [message, setMessage] = (0, import_react.useState)("");
  (0, import_react.useEffect)(() => settingsScope.subscribe(() => setSnapshot(settingsScope.getSnapshot())), [settingsScope]);
  (0, import_react.useEffect)(() => {
    const load = remote?.session?.modelCatalog?.bind(remote.session) ?? globalThis.dsh?.remote?.session?.modelCatalog?.bind(globalThis.dsh.remote.session);
    if (load === void 0)
      return;
    void load().then((result) => {
      if (result?.ok)
        setCatalog(result.value);
    }).catch(() => void 0);
  }, []);
  const value = { ...snapshot.value ?? {}, ...draft };
  const options = (0, import_react.useMemo)(() => {
    const models = catalog?.groups?.flatMap((group) => group.models.map((model) => ({
      provider: group.id,
      model: model.id,
      label: `${group.name} / ${model.name ?? model.id}`
    }))) ?? fallbackModels.map((item) => ({ ...item, label: `${item.provider} / ${item.model}` }));
    return models;
  }, [catalog]);
  const setField = (field, next) => setDraft((current) => ({ ...current, [field]: next }));
  const save = async () => {
    try {
      const ops = Object.entries(draft).map(([path, next]) => ({ op: "set", path: [path], value: next }));
      if (ops.length > 0)
        await settingsScope.mutate(ops, snapshot.revision);
      setDraft({});
      setMessage("\u5DF2\u4FDD\u5B58");
    } catch (error) {
      setMessage(`\u4FDD\u5B58\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const selected = options.find((item) => item.provider === value.provider && item.model === value.model);
  const failure = catalog?.failures?.find((item) => item.id === value.provider);
  if (snapshot.status === "loading")
    return /* @__PURE__ */ import_react.default.createElement("div", null, "\u6B63\u5728\u8BFB\u53D6 dsh-codex-approval \u914D\u7F6E\u2026");
  if (snapshot.status === "unavailable")
    return /* @__PURE__ */ import_react.default.createElement("div", null, "\u5F53\u524D Host \u672A\u66B4\u9732\u5BA1\u6279\u914D\u7F6E namespace\u3002");
  return /* @__PURE__ */ import_react.default.createElement("div", { style: { display: "grid", gap: 10, padding: 12 } }, /* @__PURE__ */ import_react.default.createElement("strong", null, "dsh-codex-approval"), /* @__PURE__ */ import_react.default.createElement("label", null, "\u6A21\u578B", /* @__PURE__ */ import_react.default.createElement("select", { value: selected ? `${selected.provider}\0${selected.model}` : `${value.provider ?? ""}\0${value.model ?? ""}`, onChange: (event) => {
    const [provider, model] = event.target.value.split("\0");
    setField("provider", provider);
    setField("model", model);
  } }, options.map((item) => /* @__PURE__ */ import_react.default.createElement("option", { key: `${item.provider}\0${item.model}`, value: `${item.provider}\0${item.model}` }, item.label)))), failure ? /* @__PURE__ */ import_react.default.createElement("div", { role: "status", style: { color: "var(--dsw-alias-label-error)" } }, "\u5F53\u524D provider \u4E0D\u53EF\u7528\uFF1A", failure.message, "\u3002\u8BF7\u5207\u6362\u6A21\u578B\u6216\u68C0\u67E5 DSH\u3002") : null, /* @__PURE__ */ import_react.default.createElement("label", null, "\u98CE\u9669\u5BB9\u5FCD\u5EA6", /* @__PURE__ */ import_react.default.createElement("select", { value: String(value.riskTolerance ?? "medium"), onChange: (event) => setField("riskTolerance", event.target.value) }, /* @__PURE__ */ import_react.default.createElement("option", { value: "low" }, "low"), /* @__PURE__ */ import_react.default.createElement("option", { value: "medium" }, "medium"), /* @__PURE__ */ import_react.default.createElement("option", { value: "high" }, "high"))), /* @__PURE__ */ import_react.default.createElement("label", null, "AI \u6545\u969C\u65F6", /* @__PURE__ */ import_react.default.createElement("select", { value: String(value.failOpen ?? "ask"), onChange: (event) => setField("failOpen", event.target.value) }, /* @__PURE__ */ import_react.default.createElement("option", { value: "ask" }, "ask"), /* @__PURE__ */ import_react.default.createElement("option", { value: "deny" }, "deny"), /* @__PURE__ */ import_react.default.createElement("option", { value: "allow" }, "allow"))), /* @__PURE__ */ import_react.default.createElement("label", null, "ai-auto \u4E0B ask", /* @__PURE__ */ import_react.default.createElement("select", { value: String(value.mode3OnAsk ?? "deny"), onChange: (event) => setField("mode3OnAsk", event.target.value) }, /* @__PURE__ */ import_react.default.createElement("option", { value: "deny" }, "deny"), /* @__PURE__ */ import_react.default.createElement("option", { value: "allow" }, "allow"))), /* @__PURE__ */ import_react.default.createElement("label", null, "\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09", /* @__PURE__ */ import_react.default.createElement("input", { type: "number", min: "1", value: Number(value.timeoutMs ?? 15e3), onChange: (event) => setField("timeoutMs", Number(event.target.value)) })), /* @__PURE__ */ import_react.default.createElement("label", null, "\u6700\u5927\u8F93\u51FA token", /* @__PURE__ */ import_react.default.createElement("input", { type: "number", min: "1", value: Number(value.maxTokens ?? 512), onChange: (event) => setField("maxTokens", Number(event.target.value)) })), /* @__PURE__ */ import_react.default.createElement("label", null, /* @__PURE__ */ import_react.default.createElement("input", { type: "checkbox", checked: Boolean(value.denyFeedback ?? true), onChange: (event) => setField("denyFeedback", event.target.checked) }), " \u663E\u793A\u81EA\u52A8\u62D2\u7EDD\u5F52\u56E0\u53CD\u9988"), message ? /* @__PURE__ */ import_react.default.createElement("div", { role: "status" }, message) : null, /* @__PURE__ */ import_react.default.createElement("div", null, /* @__PURE__ */ import_react.default.createElement("button", { type: "button", disabled: !snapshot.writable || Object.keys(draft).length === 0, onClick: () => void save() }, "\u4FDD\u5B58"), /* @__PURE__ */ import_react.default.createElement("button", { type: "button", disabled: Object.keys(draft).length === 0, onClick: () => setDraft({}) }, "\u653E\u5F03")));
}

// src/client/index.ts
var inject = ["locale", "settingsScope", "slots", "remote"];
function apply(ctx) {
  ctx.inject(["slots", "settingsScope", "locale", "remote"], (scope) => {
    const settingsScope = scope.settingsScope.bind({ namespace: "dsh-codex-approval-config" });
    scope.slots.inject("settings.plugin.item", () => scope.slots.register({
      name: "settings.plugin.item",
      key: "dsh-codex-approval-config",
      locale: "dsh-codex-approval",
      inject: () => ({ settingsScope, remote: scope.remote })
    }, DshCodexApprovalCard));
  });
}
return module.exports; } });
