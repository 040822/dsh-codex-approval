# Web 配置卡片

本插件在 DSH Web UI 里注册一张插件配置卡片，用于选择判定模型与调整策略。

## 卡片在哪

Web UI → **设置 → 插件 → 插件配置**（英文 `Settings → Plugins → Plugin configuration`）。

该标签页按 settings namespace 列出可配置插件，本插件的卡片由自身浏览器半边注册在 `settings.plugin.item` slot 上，key 为 `dsh-codex-approval-config`。

看不到卡片时：先确认 Host 已加载新代码并**刷新页面**（见 [Web 卡片排查](#web-卡片排查)）。

## 卡片能配置什么

| 项 | 说明 |
|---|---|
| **主模型** | 下拉，按 provider 分组，可用项在前、不可用项标 `⚠` 并置底 |
| **兜底候选** | 最多 4 项，可增删、可上下移动调序 |
| **风险容忍度** | `low` / `medium` / `high` |
| **`failOpen`** | AI 全部候选失败时的兜底动作 |
| **`mode3OnAsk`** | `ai-auto` 下 `ask` 的归宿 |
| **超时** | 每个候选各自的超时 |
| **最大输出 token** | 判定输出上限 |
| **拒绝反馈开关** | `denyFeedback` |

改动后 header 出现「未保存」Tag 并启用「保存 / 放弃」；保存经 settings revision fence 写入并在 Host 侧 live 生效。

## 外观约定

与内置插件卡片一致——`<ul>` 里的 `<li>` 卡片（`.5px` 边框、16px 圆角、`bg-layer-3`／展开后 `bg-layer-2`），可折叠 header（名称 + 描述 + 未保存 Tag + 箭头）、body 表单、footer 的「放弃 / 保存」。

样式取值逐条抄自内置的 `PluginCard.module.css` 与 `fields.module.css`（边框、圆角、14/16px 内边距、15px/600 标题、13px 描述、34px 控件高、focus 用 `--dsw-alias-brand-primary` 描边），并作用域在 `dsh-ca-` 前缀下，通过 `data-plugin-css` 约定的 `<style>` 注入（`src/client/client-card-style.js`，测试见 `test/client-card-style.test.mjs`）。

图标、`Tag`、`Switch` 来自 shell 静态表模块 `@deepseek-ai/dsh-client-ui-primitives`。卡片默认折叠，与其它插件卡片行为一致。

## 模型可用性怎么来的

可用性来自 `session.modelCatalog()`：

- `failures` 里的 provider 显示具体失败原因（如 401 额度）
- 不在 `routableProviders` 里的 provider 标注"不可路由"
- 两种都**仍可选**，只是标红置底，避免冷却中的路由被藏起来
- 当前配置的 provider 若不在目录中，下拉会保留一个"（不在模型目录中）"项，防止静默改值

配置变更通过 settings revision fence 保存，并在 Host 侧 live 更新运行时配置；**正在进行的 judge 调用不会被中途替换**。真实 provider failure 仍以审批日志中的脱敏 `failure.code` / `message` 为准；API key **不存入**该 namespace。

## Web 卡片排查

三处与 DSH 0.1.2 不同的接口，都会表现为"设置卡片不见了 / 改了不生效 / 卡片崩了"：

**1. `settings.register()` 返回 owner scope。**
0.1.5 里它是 `register(ns, schema, options) → { get, watch, update, replace }`，**服务级没有 `watch`**。旧写法 `settings.watch(...)` 会抛 `TypeError`，又因为包在 try/catch 里，表现为"配置改了要重启才生效"甚至静默失效。现在走返回的 scope，并兼容旧的服务级形状（见 `installConfigSettings` 与 `test/config-settings.test.mjs`）。

**2. 客户端 `dsh.client.inject` 要写模块提供者，不是服务名。**
`slots` 服务由 `@deepseek-ai/dsh-client-ui-renderer` 的客户端半边提供，模块图里并不存在 `@deepseek-ai/dsh-client-ui-slots` 这一行；写错会导致卡片永不注册，于是"插件配置"标签页里看不到本卡片（该标签页只列出**既注册了卡片、又被 Host 认领**的 namespace）。

**3. `remote.session` 是点号服务名，必须在 cordis `inject` 里显式声明。**
DSH 自带的设置面板声明的是 `["slots","locale","remote","remote.credentials","remote.session","settingsScope"]`。只声明 `remote` 会抛 `cannot get property "remote.session" without inject`；而且 slot 卡片是在**标签页的 fiber** 里渲染的，在那里碰这个代理会直接 `slot entry crashed in 'settings.plugin.item'`，整张卡片消失。

所以本插件在自己的 fiber 里把 `modelCatalog()` 解析成普通函数再交给卡片（`src/client/client-remote.js`，测试见 `test/client-remote.test.mjs`）。

### 自查

重启后在浏览器控制台执行：

```js
JSON.stringify(window.__DSH_BOOT__).includes('dsh-codex-approval')   // true = 客户端半边已在模块图里
```

插件自身也会把启动证据写进审批日志 `~/.dsh/logs/approval.jsonl`：

```json
{"event":"config-settings","ok":true,"scope":"owner-scope","namespace":"dsh-codex-approval-config"}
```

`ok:false` 会带 `error` 说明原因。

## 构建

浏览器半边是 esbuild 的 CJS bundle，外面包一层 DSH 的 `window.__ModuleLoader__.load({ id, factory })` 加载壳（`scripts/build-client.mjs` 生成）。React 与 `@deepseek-ai/*` 均为 external，由 Host 的模块加载器提供。

```bash
npm run build:client     # 改 src/client/* 后必须重建 lib/client.js
```

`test/client-bundle.test.mjs` 用假加载器 + 极简 React stub 真实渲染卡片，因此改完前端后 `node --test` 能发现产物损坏或渲染异常。
