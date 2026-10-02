import React from 'react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// `slots` is provided by the client UI renderer (its client half owns the
// SlotRegistry service); there is no separate `dsh-client-ui-slots` client
// module in the graph, so the renderer is the module to depend on.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { makeCodexApprovalSection } from './DshCodexApprovalCard.tsx'
import { resolveModelCatalogLoader } from './client-remote.js'
import { ensureCardStyle } from './client-card-style.js'

/** 0.1.x 的 settings 命名空间名。 */
const SETTINGS_NAMESPACE = 'dsh-codex-approval-config'
/** 0.2.0 起可编辑设置改由 entry config 承载，命名空间名即 cordis entry id。 */
const SETTINGS_ENTRY_ID = 'dsh-codex-approval'

/**
 * Services this browser half needs. `remote.session` is a **dotted service
 * name**: the cordis context proxy throws `cannot get property
 * "remote.session" without inject` unless that exact name is declared, so
 * `remote` alone is not enough (the shipped settings-plugins tab declares both).
 */
export const inject = ['locale', 'slots', 'remote', 'remote.session']

/**
 * 取本插件的配置表单，两版设置服务二选一。
 *
 * **不能**把两个服务名同时写进 inject —— 那样必有一版永远 pending（0.2.0 少了
 * `settingsScope`，0.1.x 少了 `configForms`）。探测只能用 `ctx.get(name, false)`：
 * 未声明的服务直接属性访问会抛 `cannot get property ... without inject`（本文件
 * 上方 remote.session 的注释记过同一个坑），而 strict 模式找不到服务时会抛错。
 *
 * 两条路径返回的形状一致（getSnapshot / subscribe / mutate），所以卡片代码
 * 不需要区分版本：
 *   0.1.x — `settingsScope.bind({ namespace })`，settings 命名空间
 *   0.2.0 — `configForms.get(entryId)`，SettingsForms，命名空间名即 entry id
 */
function settingsFormFor(ctx: any): any {
  try {
    const scoped = ctx.get?.('settingsScope', false)
    if (scoped !== undefined && typeof scoped.bind === 'function') {
      return scoped.bind({ namespace: SETTINGS_NAMESPACE })
    }
    const forms = ctx.get?.('configForms', false)
    if (forms !== undefined && typeof forms.get === 'function') {
      return forms.get(SETTINGS_ENTRY_ID)
    }
  } catch (error) {
    // 0.2.0 的 configForms.get 在 entry 没有 Config schema 时会抛
    // `No configurable plugin entry`。这里吞掉并返回 undefined，让落地卡片
    // 显示出来——注册本身失败的话连设置页那一栏都不会出现，更难诊断。
    ctx.logger?.warn?.('[dsh-codex-approval] settings form unavailable: %s', String(error?.message ?? error))
  }
  return undefined
}

export function apply(ctx: any): void {
  // One stylesheet for the card, injected with the shipped plugins' own
  // `data-plugin-css` convention.
  ensureCardStyle()
  // 注册字典。设置页栏目的菜单项需要一个 `t` 座位来渲染标题，核心的宠物栏目
  // 就是先 `ctx.locale.register("pet", {zh, en})` 再在注册项里声明
  // `locale: "pet"`；不注册字典而声明 locale（或不声明 locale）会让该条目的
  // 渲染塌成 0×0 的空节点——菜单里点不到，内容面板也不会渲染。
  ctx.effect?.(() => ctx.locale?.register?.('dsh-codex-approval', {
    zh: { 'settings.title': 'Codex 审批' },
    en: { 'settings.title': 'Codex approval' },
  }), 'dsh-codex-approval: dictionaries')
  ctx.inject(['slots', 'locale', 'remote', 'remote.session'], (scope: any) => {
    // 注册不能把「第一次探测失败」当成终态。
    //
    // settings 服务要等 `remote.settings` 就绪，所以它晚于本 fiber 出现是完全合法
    // 的加载顺序；而 cordis 只刷新**声明了对应依赖**的 fiber，未声明的服务晚到时
    // 这个回调不会再跑一次——原来的写法（探测一次、拿不到就 return）会让设置栏目
    // 永久不注册，且没有任何重试机会。
    //
    // 修法：为两个候选服务各挂一条 inject 分支。0.1.x 有 settingsScope、0.2.0 有
    // configForms，两版各有其一缺失；缺失的那条永远 pending，而 pending 不影响
    // 另一条激活。注册本身用 `registered` 保证只发生一次。
    // 按**服务身份**去重，而不是用一个一次性的布尔标志。
    // cordis 在依赖变化时会卸载并重跑对应的 inject 回调；0.2.0 的 ConfigForms
    // 提供者被卸载会让所有表单 dispose（disposed 表单的 `enqueue()` 从此永久返回
    // false）。若用一次性标志短路，服务替换后就永久停在注销状态、还留着旧表单；
    // 若每次都重新注册，UI 里会冒出两个栏目。以服务对象为身份做「换了才重做」。
    let currentService: any = undefined
    let disposeSlot: any = undefined
    // `ctx.get()` 每次都为 Service 新建一个代理对象，直接比较它**恒不相等**——实测会
    // 让启动时出现「注册 → 注销 → 再注册」的抖动。`Symbol.for('cordis.original')`
    // 指向的原始服务对象才是稳定身份。
    const originalOf = (value: any): any => value?.[Symbol.for('cordis.original')] ?? value
    const register = () => {
      const raw = ctx.get?.('settingsScope', false) ?? ctx.get?.('configForms', false)
      if (raw === undefined) return
      const identity = originalOf(raw)
      // 先去重、再绑定表单：0.1.x 的 `bind()` 每次都创建一个新 controller，多余的会
      // 一直留到插件卸载。
      if (identity === currentService && disposeSlot !== undefined) return
      const form = settingsFormFor(ctx)
      if (!form) return
      if (typeof disposeSlot === 'function') disposeSlot()
      disposeSlot = undefined
      currentService = identity
      // Resolve the catalog call here, on the only fiber allowed to touch the
      // guarded `remote.session` service, and hand the card a plain function:
      // slot entries render in the slot's own fiber, where that proxy would throw
      // and crash the whole card with "slot entry crashed".
      const loadModelCatalog = resolveModelCatalogLoader(scope)
      // 设置页独立一栏。`settings.section` 在 0.1.x 与 0.2.0 的契约完全相同
      // （kind: list / scope: root / owner: SettingsSectionOwnerProps），所以两版
      // 共用这一条注册、不需要分支——与 @linxin666/dsh-web-all 的皮肤、宠物栏目
      // 是同一条路线。
      //
      // 0.1.x 原本注册到 `settings.plugin.item`（插件 tab 里的一项）。该 slot 在
      // 0.2.0 已被删除，而 settings.section 两版都在，故统一迁到这里；副作用是
      // 0.1.5 上的入口也会从「插件 tab 里的一项」变成「设置页独立栏目」，这是
      // 有意为之：两版出口一致，省掉一条按版本分叉的注册。
      disposeSlot = scope.slots.inject('settings.section', () => scope.slots.register({
        name: 'settings.section',
        id: SETTINGS_ENTRY_ID,
        order: 140,
        label: () => ctx.locale.bind('dsh-codex-approval')('settings.title'),
        locale: 'dsh-codex-approval',
        inject: () => ({}),
      }, makeCodexApprovalSection(form, loadModelCatalog)))
    }
    const release = () => {
      if (typeof disposeSlot === 'function') disposeSlot()
      disposeSlot = undefined
      currentService = undefined
    }
    register()
    // 为两个候选服务各挂一条等待分支：0.1.x 有 settingsScope、0.2.0 有 configForms，
    // 两版各有其一缺失，缺失的那条永远 pending（不影响另一条激活）。
    //
    // 两条分支都**返回清理函数**：settings 服务被卸载后栏目必须一起注销，否则会残留
    // 一个死栏目——它持有的表单已 dispose，`enqueue()` 恒返回 false，用户点保存永远
    // 失败却看不出原因。
    ctx.inject(['settingsScope'], () => { register(); return release })
    ctx.inject(['configForms'], () => { register(); return release })
    ctx.effect?.(() => release, 'dsh-codex-approval: settings.section')
  })
}
