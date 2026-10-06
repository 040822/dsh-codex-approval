import React, { useEffect, useMemo, useState } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * 图标/基础件的可用性解析。
 *
 * UI 基础件的命名在两版之间改过：0.1.x 的图标带尺寸数字后缀
 * (`IconChevronDown`)，0.2.0 起去掉数字后缀、改用 Medium/Regular
 * 变体名 (`IconChevronDownOutline` / `...OutlineMedium`)。静态命名导入在另一版
 * 上拿到的是 undefined，而 JSX 里出现 undefined 组件会直接把整个 slot 条目
 * 打崩 (React error #130)，连设置页那一栏都点不开——所以这里按可用性取。
 */
/**
 * 所有候选都缺失时的安全替身。
 *
 * 渲染 `undefined` 组件会把整个 slot 条目打崩（React error #130），连设置页那一栏
 * 都点不开——比少一个箭头严重得多。因此 pickPrimitive 永不返回 undefined：
 * 拿不到就退化成什么都不渲染的组件，布局与交互都不受影响。
 */
const Blank = (_props: any): any => null
const pickPrimitive = (...names: string[]): any =>
  names.map((n) => (Primitives as any)[n]).find((v) => v !== undefined) ?? Blank
// 候选必须覆盖两版**实际导出**的名字，缺一个就会在那一版上落到 undefined：
//   0.1.x：IconChevronDownOutline14 / IconChevronUpOutline14 /
//          IconPlusOutline16 / IconTrashOutline16（带尺寸数字后缀）
//   0.2.0：IconChevronDownOutline / ...OutlineRegular（无数字、带变体名）
const IconChevronDown = pickPrimitive(
  'IconChevronDown', 'IconChevronDownOutline', 'IconChevronDownOutline14', 'IconChevronDownOutlineRegular')
const IconChevronUp = pickPrimitive(
  'IconChevronUp', 'IconChevronUpOutline', 'IconChevronUpOutline14', 'IconChevronUpOutlineRegular')
const IconPlus = pickPrimitive(
  'IconPlus', 'IconPlusOutline', 'IconPlusOutline16', 'IconPlusOutlineRegular')
const IconTrash = pickPrimitive(
  'IconTrash', 'IconTrashOutline', 'IconTrashOutline16', 'IconTrashOutlineRegular')
// 这两个同样不能是 undefined（它们直接进 JSX）。缺失时退化成等价的语义替身：
// Tag → 普通 span；Switch → 原生 checkbox（保持可交互，不要变成不可点的死开关）。
const Switch = (Primitives as any).Switch ?? ((props: any): any => (
  <input type="checkbox" className={props.className} checked={Boolean(props.checked)} disabled={props.disabled}
    aria-label={props.label} onChange={(event: any) => props.onChange?.(event.target.checked)} />
))
const Tag = (Primitives as any).Tag ?? ((props: any): any => <span className={props.className}>{props.children}</span>)

import {
  MAX_FALLBACKS,
  buildChainSummary,
  buildModelOptions,
  findOption,
  optionKey,
  readChain,
  splitByAvailability,
  validateChain,
} from './client-model-picker.js'

/**
 * Settings card for the approval judge models.
 *
 * Rendered into the Plugins → Plugin configuration tab's `settings.plugin.item`
 * slot, so it must look like the built-in cards: an `<li>` with the same chrome
 * (collapsible header, name + description, unsaved tag, body, footer with
 * discard/save). Styles live in src/client/client-card-style.js and mirror the shipped
 * PluginCard/fields stylesheets value for value.
 */

type Props = {
  settingsScope: SettingsScope<Record<string, unknown>>
  /**
   * Bound `remote.session.modelCatalog()` resolved by the plugin's own fiber
   * (see src/client/client-remote.js). The card must not touch the `remote` service proxy
   * itself: slot entries render in the tab's fiber, where cordis refuses
   * undeclared services and the whole card would crash.
   */
  loadModelCatalog?: () => Promise<unknown>
}

type CatalogModel = { id: string; name?: string }
type CatalogGroup = { id: string; name: string; models: CatalogModel[] }
type CatalogFailure = { id: string; name?: string; message: string }
type Catalog = { groups?: CatalogGroup[]; failures?: CatalogFailure[]; routableProviders?: string[] }
type ChainEntry = { provider: string; model: string }
type ModelOptions = ReturnType<typeof buildModelOptions>

const fallbackModels = [
  { provider: 'cpa-wx301', model: 'command/deepseek/deepseek-v4.1-flash' },
  { provider: 'deepseek-official', model: 'deepseek-flash' },
]

const NUL = '\u0000'
/**
 * Risk tolerance is the landing zone for the AI's *ask* verdict, not a ceiling
 * on what may be auto-approved: `decidePolicy` maps `risk <= tolerance` to
 * allow when the AI asked for a human, while an `allow` above the tolerance
 * additionally needs the user to have asked for this exact action, and a high
 * risk without that authorization always reaches a human. A HIGHER tolerance
 * is therefore MORE permissive for asks, and the copy has to say so — the
 * previous labels ("low · 尽量放行" / "high · 尽量询问") were inverted, so a
 * user picking the stricter-sounding option silently widened auto-approval.
 */
const TOLERANCES = [
  { value: 'low', label: 'low · 严格' },
  { value: 'medium', label: 'medium · 平衡（默认）' },
  { value: 'high', label: 'high · 宽松' },
]
const FAIL_OPEN = [
  { value: 'ask', label: 'ask · 交给人确认（默认）' },
  { value: 'deny', label: 'deny · 拒绝' },
  { value: 'allow', label: 'allow · 放行' },
]
/**
 * 判定上下文。`off` 是关闭（判定模型只看本次请求）；`short` 会带上**有界**的两级窗口
 * （最近的用户消息 + 工具链骨架 + 本会话的拒绝历史，总量受 `transcriptMaxChars` 限制）。
 * 它只决定判定模型**能看到什么**，不改变任何权限判定。默认 `short`：实测 24 案例
 * repeat=3 下交人工 13/72，而 `off` 是 17/72，两者的非争议危险放行都是 0/66。
 */
const TRANSCRIPT = [
  { value: 'off', label: 'off · 关闭' },
  { value: 'short', label: 'short · 开启（默认）' },
]

/**
 * 默认审批模式（配置层的 `mode`，与会话内的 `/approval-mode` 覆盖同一维度）。
 *
 * 它是**默认值**：只对没有会话覆盖的会话生效，`/approval-mode default` 就是回到它。
 * 三种取值与 `modes.js` 的语义一一对应。标签只留名字——2026-10-06 用户要求删掉三项
 * 后面的括号（字段名已经是「默认审批模式」，再写「（默认）」是重复）。完整后果写在
 * `docs/configuration.md` 与 `docs/client-card.md`：`manual` 是插件完全旁路（不判定、
 * 不审计），`ai-auto` 是 ask 永不交人类（写死的 `mode3OnAsk: deny` 直接拒绝）。
 */
const MODES = [
  { value: 'manual', label: 'manual · 仅人工' },
  { value: 'ai', label: 'ai · AI 判定 + 人工兜底' },
  { value: 'ai-auto', label: 'ai-auto · AI 全自动' },
]

/** One labelled form row, mirroring the shipped fields.module.css layout. */
function Field({ label, hint, children }: { label: string; hint?: string; children?: unknown }) {
  return (
    <div className="dsh-ca-field">
      <div className="dsh-ca-fieldHead"><span className="dsh-ca-label">{label}</span></div>
      {children}
      {hint !== undefined ? <p className="dsh-ca-hint">{hint}</p> : null}
    </div>
  )
}

/** A `<select>` of judge models; unavailable providers are marked and sorted last. */
function ModelSelect({ options, provider, model, disabled, onChange }: {
  options: ModelOptions
  provider: unknown
  model: unknown
  disabled: boolean
  onChange: (provider: string, model: string) => void
}) {
  const current = findOption(options, provider as string, model as string)
  const { available, unavailable } = splitByAvailability(options)
  const value = current ? optionKey(current.provider, current.model) : optionKey(String(provider ?? ''), String(model ?? ''))
  const renderOption = (item: ModelOptions[number]) => (
    <option key={optionKey(item.provider, item.model)} value={optionKey(item.provider, item.model)}>
      {item.available ? item.label : `⚠ ${item.label}`}
    </option>
  )
  return (
    <select className="dsh-ca-select" value={value} disabled={disabled} onChange={(event) => {
      const [nextProvider, nextModel] = event.target.value.split(NUL)
      onChange(nextProvider, nextModel)
    }}>
      {current === undefined ? <option value={value}>{`${String(provider ?? '')} / ${String(model ?? '')}（不在模型目录中）`}</option> : null}
      <optgroup label="可用">{available.map(renderOption)}</optgroup>
      {unavailable.length > 0 ? <optgroup label="不可用（渠道失败或未路由）">{unavailable.map(renderOption)}</optgroup> : null}
    </select>
  )
}

export function DshCodexApprovalCard({ settingsScope, loadModelCatalog }: Props) {
  const [snapshot, setSnapshot] = useState(() => settingsScope.getSnapshot())
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [message, setMessage] = useState('')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => settingsScope.subscribe(() => setSnapshot(() => settingsScope.getSnapshot())), [settingsScope])
  useEffect(() => {
    if (loadModelCatalog === undefined) return
    void loadModelCatalog().then((result: any) => {
      if (result?.ok) setCatalog(result.value)
    }).catch(() => undefined)
  }, [loadModelCatalog])

  const value = { ...(snapshot.value ?? {}), ...draft } as Record<string, any>
  // 未配置主模型时的**展示回退**。
  //
  // 服务端 `Config` 的标量字段刻意不带 `.default()`（否则默认值注入会让顶层「恒有值」，
  // 旧嵌套 `ai.*` 就永远读不到、更严格的旧策略被静默放宽），所以表单投影里
  // `provider`/`model` 可能是 undefined。展示层需要一个等价的内置默认，否则主模型会显示
  // 成空白、还会误报「该 provider 当前不可路由」。
  // 只用于展示，**不要写进草稿**。服务端 `DEFAULT_CONFIG.ai` 的这两个值改动时这里要同步。
  const primaryProvider = value.provider ?? 'cpa-wx301'
  const primaryModel = value.model ?? 'command/deepseek/deepseek-v4.1-flash'
  const options = useMemo(() => buildModelOptions(catalog, fallbackModels), [catalog])
  const chain = useMemo(() => readChain(draft.fallbacks ?? value.fallbacks), [draft.fallbacks, value.fallbacks])
  const chainError = validateChain(chain, { provider: primaryProvider, model: primaryModel })
  const dirty = Object.keys(draft).length > 0
  const writable = snapshot.writable !== false
  const disabled = !writable || saving
  const primaryFailure = catalog?.failures?.find((item) => item.id === primaryProvider)
  const primaryRoutable = catalog?.routableProviders === undefined
    ? true
    : catalog.routableProviders.includes(String(primaryProvider))
  const judgeOrder = buildChainSummary({ provider: primaryProvider, model: primaryModel }, chain)

  const setField = (field: string, next: unknown) => setDraft((current) => ({ ...current, [field]: next }))
  const setChain = (next: ChainEntry[]) => setField('fallbacks', next)
  const updateChainAt = (index: number, provider: string, model: string) => {
    setChain(chain.map((entry, i) => (i === index ? { provider, model } : entry)))
  }
  const moveChain = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= chain.length) return
    const next = [...chain]
    const [entry] = next.splice(index, 1)
    next.splice(target, 0, entry)
    setChain(next)
  }
  const addChain = () => {
    const used = new Set(judgeOrder)
    const candidate = options.find((item) => item.available && !used.has(`${item.provider} / ${item.model}`))
    setChain([...chain, candidate === undefined ? { provider: '', model: '' } : { provider: candidate.provider, model: candidate.model }])
  }

  const save = async () => {
    if (chainError !== '') {
      setMessage(`无法保存：${chainError}`)
      return
    }
    setSaving(true)
    try {
      const ops = Object.entries(draft).map(([path, next]) => ({ op: 'set', path: [path], value: next }))
      if (ops.length > 0) {
        // 0.2.0 的 ConfigForm.mutate 返回 boolean：revision 冲突、schema 拒绝等
        // 情况下它恢复读取并返回 false，而不是抛异常——原来的代码忽略返回值，
        // 于是照样清空草稿、显示「已保存」，用户在不知情下丢掉编辑。
        // 只认显式 false，这样旧版（返回 void）的契约也仍然正确。
        const written = await settingsScope.mutate(ops as any, snapshot.revision)
        if (written === false) {
          setMessage('保存被拒绝：配置可能已被其他地方的修改覆盖，请收起后重新打开本栏再试')
          return
        }
      }
      setDraft({})
      setMessage('已保存')
    } catch (error) {
      setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }
  const discard = () => {
    setDraft({})
    setMessage('')
  }

  if (snapshot.status === 'loading') {
    return <li className="dsh-ca-card"><div className="dsh-ca-header"><span className="dsh-ca-headText">
      <span className="dsh-ca-name">审批模型</span>
      <span className="dsh-ca-description">正在读取配置…</span>
    </span></div></li>
  }

  return (
    <li className={open ? 'dsh-ca-card dsh-ca-cardOpen' : 'dsh-ca-card'}>
      <button type="button" className="dsh-ca-header" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="dsh-ca-headText">
          <span className="dsh-ca-name">审批模型</span>
          <span className="dsh-ca-description">
            {`AI 审判模型：主模型失败后依次尝试回退模型（${chain.length === 0 ? '未配置回退' : `${chain.length} 项`}）`}
          </span>
        </span>
        {dirty ? <Tag tone="neutral" className="dsh-ca-pending">未保存</Tag> : null}
        <IconChevronDown className={open ? 'dsh-ca-chevron dsh-ca-chevronOpen' : 'dsh-ca-chevron'} />
      </button>
      {open ? (
        <div className="dsh-ca-body">
          {snapshot.status === 'unavailable' ? <p className="dsh-ca-readOnly">当前 Host 未暴露审批配置 namespace。</p> : null}
          {writable ? null : <p className="dsh-ca-readOnly">本部署的设置为只读。</p>}

          <Field label="主模型">
            <ModelSelect
              options={options}
              provider={primaryProvider}
              model={primaryModel}
              disabled={disabled}
              onChange={(provider, model) => {
                setField('provider', provider)
                setField('model', model)
              }}
            />
            {primaryFailure !== undefined
              ? <p className="dsh-ca-invalid">该 provider 当前不可用：{primaryFailure.message}</p>
              : null}
            {primaryFailure === undefined && !primaryRoutable
              ? <p className="dsh-ca-invalid">该 provider 当前不可路由，调用会直接失败。</p>
              : null}
          </Field>

          <Field label={`回退模型（按顺序尝试，最多 ${MAX_FALLBACKS} 项）`}>
            {chain.length === 0
              ? <p className="dsh-ca-hint">未配置回退：主模型失败时直接走“AI 故障时”的策略。</p>
              : null}
            {chain.map((entry, index) => {
              const failure = catalog?.failures?.find((item) => item.id === entry.provider)
              return (
                <div className="dsh-ca-row" key={`${index}-${optionKey(entry.provider, entry.model)}`}>
                  <span className="dsh-ca-rowIndex">{index + 1}.</span>
                  <ModelSelect
                    options={options}
                    provider={entry.provider}
                    model={entry.model}
                    disabled={disabled}
                    onChange={(provider, model) => updateChainAt(index, provider, model)}
                  />
                  {failure !== undefined ? <span className="dsh-ca-rowUnavailable">不可用</span> : null}
                  <button type="button" className="dsh-ca-iconButton" title="上移" aria-label="上移"
                    disabled={disabled || index === 0} onClick={() => moveChain(index, -1)}>
                    <IconChevronUp />
                  </button>
                  <button type="button" className="dsh-ca-iconButton" title="下移" aria-label="下移"
                    disabled={disabled || index === chain.length - 1} onClick={() => moveChain(index, 1)}>
                    <IconChevronDown />
                  </button>
                  <button type="button" className="dsh-ca-iconButton" title="删除" aria-label="删除"
                    disabled={disabled} onClick={() => setChain(chain.filter((_, i) => i !== index))}>
                    <IconTrash />
                  </button>
                </div>
              )
            })}
            <div className="dsh-ca-row">
              <button type="button" className="dsh-ca-ghostButton" disabled={disabled || chain.length >= MAX_FALLBACKS} onClick={addChain}>
                <IconPlus /> 添加回退模型
              </button>
            </div>
            {chainError !== '' ? <p className="dsh-ca-invalid">{chainError}</p> : null}
          </Field>

          <div className="dsh-ca-grid">
            <Field label="默认审批模式" hint="会话内用 /approval-mode 覆盖">
              <select className="dsh-ca-select" value={String(value.mode ?? 'ai')} disabled={disabled}
                onChange={(event) => setField('mode', event.target.value)}>
                {MODES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </Field>
            <Field label="风险容忍度">
              <select className="dsh-ca-select" value={String(value.riskTolerance ?? 'medium')} disabled={disabled}
                onChange={(event) => setField('riskTolerance', event.target.value)}>
                {TOLERANCES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </Field>
            <Field label="AI 故障时">
              <select className="dsh-ca-select" value={String(value.failOpen ?? 'ask')} disabled={disabled}
                onChange={(event) => setField('failOpen', event.target.value)}>
                {FAIL_OPEN.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </Field>
            <Field label="上下文" hint="关闭时判定模型只看本次请求。">
              <select className="dsh-ca-select" value={String(value.transcript ?? 'short')} disabled={disabled}
                onChange={(event) => setField('transcript', event.target.value)}>
                {TRANSCRIPT.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </Field>
            <Field label="上下文字符上限" hint="超出时先丢拒绝历史。">
              <input className="dsh-ca-input" type="number" min="100" max="16000" value={Number(value.transcriptMaxChars ?? 4000)}
                disabled={disabled} onChange={(event) => setField('transcriptMaxChars', Number(event.target.value))} />
            </Field>
            <Field label="超时（毫秒）">
              <input className="dsh-ca-input" type="number" min="1" value={Number(value.timeoutMs ?? 15000)}
                disabled={disabled} onChange={(event) => setField('timeoutMs', Number(event.target.value))} />
            </Field>
            <Field label="最大输出 token" hint="含推理 token">
              <input className="dsh-ca-input" type="number" min="1" value={Number(value.maxTokens ?? 512)}
                disabled={disabled} onChange={(event) => setField('maxTokens', Number(event.target.value))} />
            </Field>
          </div>

          <div className="dsh-ca-toggleRow">
            <span className="dsh-ca-label">拒绝后向主 agent 注入归因反馈</span>
            <Switch checked={Boolean(value.denyFeedback ?? true)} label="拒绝后向主 agent 注入归因反馈"
              disabled={disabled} onChange={(next: boolean) => setField('denyFeedback', next)} />
          </div>

          <div className="dsh-ca-footer">
            {message !== ''
              ? <p className={message.startsWith('保存失败') || message.startsWith('无法保存') ? 'dsh-ca-failed' : 'dsh-ca-hint'} role="status">{message}</p>
              : null}
            <button type="button" className="dsh-ca-discard" disabled={!dirty || saving} onClick={discard}>放弃</button>
            <button type="button" className="dsh-ca-save" disabled={!dirty || chainError !== '' || saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

/**
 * 设置页独立一栏（`settings.section`）的容器。
 *
 * 卡片的根元素是 `<li>`（原设计挂在插件卡片的 `<ul>` 列表里）。`settings.section`
 * 的面板本身不是列表容器，所以要自己包一层 `<ul>`——核心的宠物栏目是同样的形状：
 * section 组件渲染 `<ul>`，卡片作为 `<li>` 落在其中。
 *
 * 表单由 index.ts 的 `inject` 以 `settingsScope` 这个 prop 名传入（两版设置服务
 * 返回的形状一致），卡片本身不区分版本。
 */
export function makeCodexApprovalSection(form: any, loadModelCatalog: any) {
  return function CodexApprovalSection() {
    return (
      <ul className="dsh-ca-sectionList">
        {form === undefined ? (
          <li className="dsh-ca-card">
            <div className="dsh-ca-header">
              <span className="dsh-ca-headText">
                <span className="dsh-ca-name">Codex 审批</span>
                <span className="dsh-ca-description">配置表单不可用：未解析到设置服务。</span>
              </span>
            </div>
          </li>
        ) : (
          <DshCodexApprovalCard settingsScope={form} loadModelCatalog={loadModelCatalog} />
        )}
      </ul>
    )
  }
}
