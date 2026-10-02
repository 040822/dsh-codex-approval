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
  { value: 'low', label: 'low · 严格：只放行 low 风险' },
  { value: 'medium', label: 'medium · 平衡（默认）：放行 ≤medium 风险' },
  { value: 'high', label: 'high · 宽松：放行 ≤high 风险' },
]
const FAIL_OPEN = [
  { value: 'ask', label: 'ask · 交给人确认（默认）' },
  { value: 'deny', label: 'deny · 拒绝' },
  { value: 'allow', label: 'allow · 放行' },
]
const MODE3_ON_ASK = [
  { value: 'deny', label: 'deny · 拒绝（默认）' },
  { value: 'allow', label: 'allow · 放行' },
]
/** Where an enforced policy ask lands when nobody can be asked (no strong user authorization). */
const ENFORCED_ASK = [
  { value: 'deny', label: 'deny · 拒绝（默认）' },
  { value: 'ask', label: 'ask · 交给人（无人值守时会一直等）' },
]
/** Where the red lines (publishing, credentials) land when nobody can be asked. */
const HARD_ASK = [
  { value: 'deny', label: 'deny · 拒绝（默认）' },
  { value: 'ask', label: 'ask · 交给人（无人值守时会一直等）' },
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
  // 未配置主模型时的**展示兜底**。
  //
  // 服务端 `Config` 的标量字段刻意不带 `.default()`（否则默认值注入会让顶层「恒有值」，
  // 旧嵌套 `ai.*` 就永远读不到、更严格的旧策略被静默放宽），所以表单投影里
  // `provider`/`model` 可能是 undefined。展示层需要一个等价的内置默认，否则主模型会显示
  // 成空白、调用顺序里只剩兜底候选，还会误报「该 provider 当前不可路由」。
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
            {`AI 审判模型：主模型失败后依次尝试兜底候选（${chain.length === 0 ? '未配置兜底' : `${chain.length} 项`}）`}
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

          <Field label={`兜底候选（按顺序尝试，最多 ${MAX_FALLBACKS} 项）`}>
            {chain.length === 0
              ? <p className="dsh-ca-hint">未配置兜底：主模型失败时直接走“AI 故障时”的策略。</p>
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
                <IconPlus /> 添加兜底候选
              </button>
            </div>
            {chainError !== '' ? <p className="dsh-ca-invalid">{chainError}</p> : null}
            <p className="dsh-ca-order">调用顺序：{judgeOrder.length === 0 ? '（未选择模型）' : judgeOrder.join(' → ')}</p>
          </Field>

          <div className="dsh-ca-grid">
            <Field label="风险容忍度" hint="越高越宽松，但有两道与档位无关的底线：AI 自己拿不准（ask）且风险 ≥ medium、或风险 high 而用户没明确要求，都会交给人工。">
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
            <Field label="ai-auto 模式下遇到 ask">
              <select className="dsh-ca-select" value={String(value.mode3OnAsk ?? 'deny')} disabled={disabled}
                onChange={(event) => setField('mode3OnAsk', event.target.value)}>
                {MODE3_ON_ASK.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </Field>
            <Field label="高风险无授权无人值守时" hint="高风险且用户未明确要求、或 AI 放行但超出档位时，不受「ai-auto 遇到 ask」影响；默认直接拒绝">
              <select className="dsh-ca-select" value={String(value.enforcedAskOnUnattended ?? 'deny')} disabled={disabled}
                onChange={(event) => setField('enforcedAskOnUnattended', event.target.value)}>
                {ENFORCED_ASK.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </Field>
            <Field label="红条（发布/凭据）无人值守时" hint="发布与凭据目录属红条，不受上面两项开关影响；默认直接拒绝">
              <select className="dsh-ca-select" value={String(value.hardAskOnUnattended ?? 'deny')} disabled={disabled}
                onChange={(event) => setField('hardAskOnUnattended', event.target.value)}>
                {HARD_ASK.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </Field>
            <Field label="超时（毫秒）" hint="每个候选各自计时，默认 15000">
              <input className="dsh-ca-input" type="number" min="1" value={Number(value.timeoutMs ?? 15000)}
                disabled={disabled} onChange={(event) => setField('timeoutMs', Number(event.target.value))} />
            </Field>
            <Field label="最大输出 token" hint="含思考 token 余量，默认 512">
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
