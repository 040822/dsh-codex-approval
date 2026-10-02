# 开发说明

### 目录结构

三块边界：**根目录 = 宿主侧源码（无构建，Node 直接加载）**、**`src/client/` = 浏览器半边源码（有构建）**、**`lib/` = 构建产物（入库，npm 包直接发它）**。

| 路径 | 平面 | 需构建 |
|---|---|---|
| `index.js` | 宿主入口（`package.json#main` 与 `exports["."]`），注册 `approval/request` 应答器 | 否 |
| `rules.js` `enrich.js` `judge.js` `transcript.js` `modes.js` `i18n.js` `redact.js` `shell-shape.js` | 宿主侧模块，由 `index.js` 相对导入 | 否 |
| `src/client/index.ts`、`src/client/DshCodexApprovalCard.tsx` | 浏览器半边入口与设置卡片 | 是（esbuild） |
| `src/client/client-remote.js`、`client-card-style.js`、`client-model-picker.js` | 浏览器半边里免 JSX 的纯 JS 模块，`node --test` 可直接覆盖 | 否（但会被打进产物） |
| `lib/client.js` | 上两行的构建产物，`exports["./client"]` 指向它；外层包 `window.__ModuleLoader__.load({ id, factory })` | 产物 |
| `cordis.patch.yml` | `dsh.bundle.patch` 指向的注入行 | — |
| `test/` `docs/` `scripts/` | 单测、文档、构建脚本与平面校验脚本 | — |

约定：**有构建的一侧源码进 `src/`，无构建的一侧平铺在根目录**；根目录的边界由 `package.json#files`（发哪些文件）和 `exports`（外部能导入什么）划定，不靠目录位置。

发布边界：npm 包只装**运行时文件**（宿主侧源码 + `lib/client.js` + `cordis.patch.yml` + README/LICENSE，共 14 个文件）。`src/` 与 `scripts/` 不入包——客户端半边的构建只在开发仓库里做，包内用 `lib/client.js` 这一份产物；所以装包后 `npm run build:client` 会找不到入口，这是刻意的。

```bash
node --test                     # 规则、Session API、transcript、拒绝反馈、AI 裁决、兜底链、模型选择器与浏览器半边冒烟测试
npm run build:client            # 改 src/client/* 后重建 lib/client.js
node scripts/check-planes.mjs   # 在 3.18.2 / 3.18.4 两个 schemastery 平面上各跑一遍全部用例
```

沙箱内 `~/.npm` 只读时，`npx` 拉 esbuild 会以 `EROFS` 失败；把缓存指到可写目录后重跑（`npm_config_cache=<可写目录>`）。

## 兼容性声明

包中声明 DSH 版本范围为 `>=0.1.2-rc.1`；兼容记录另列有 `0.1.0-rc.6`、`0.1.2-rc.1`、`0.1.5-rc.1`、`0.2.0-rc.2`。这些是包声明，不代表每个版本均完成实测。

同时兼容旧版 `session.events` 与新版 `snapshotEvents()` / `ownEvents()` 会话 API。Node.js 要求 `>=22.19`。
