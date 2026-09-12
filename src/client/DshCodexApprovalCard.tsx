import React, { useEffect, useMemo, useState } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconPlusOutline16,
  IconTrashOutline16,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  MAX_FALLBACKS,
  buildChainSummary,
  buildModelOptions,
  findOption,
  optionKey,
  readChain,
  splitByAvailability,
  validateChain,
} from '../../client-model-picker.js'

/**
 * Settings card for the approval judge models.
 *
 * Rendered into the Plugins → Plugin configuration tab's `settings.plugin.item`
 * slot, so it must look like the built-in cards: an `<li>` with the same chrome
 * (collapsible header, name + description, unsaved tag, body, footer with
 * discard/save). Styles live in client-card-style.js and mirror the shipped
 * PluginCard/fields stylesheets value for value.
 */

type Props = {
  settingsScope: SettingsScope<Record<string, unknown>>
  /**
   * Bound `remote.session.modelCatalog()` resolved by the plugin's own fiber
   * (see client-remote.js). The card must not touch the `remote` service proxy
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
const TOLERANCES = [
  { value: 'low', label: 'low · 尽量放行' },
  { value: 'medium', label: 'medium · 平衡（默认）' },
  { value: 'high', label: 'high · 尽量询问' },
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
  const options = useMemo(() => buildModelOptions(catalog, fallbackModels), [catalog])
  const chain = useMemo(() => readChain(draft.fallbacks ?? value.fallbacks), [draft.fallbacks, value.fallbacks])
  const chainError = validateChain(chain, { provider: value.provider, model: value.model })
  const dirty = Object.keys(draft).length > 0
  const writable = snapshot.writable !== false
  const disabled = !writable || saving
  const primaryFailure = catalog?.failures?.find((item) => item.id === value.provider)
  const primaryRoutable = catalog?.routableProviders === undefined
    ? true
    : catalog.routableProviders.includes(String(value.provider ?? ''))
  const judgeOrder = buildChainSummary({ provider: value.provider, model: value.model }, chain)

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
      if (ops.length > 0) await settingsScope.mutate(ops as any, snapshot.revision)
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
        <IconChevronDownOutline14 className={open ? 'dsh-ca-chevron dsh-ca-chevronOpen' : 'dsh-ca-chevron'} />
      </button>
      {open ? (
        <div className="dsh-ca-body">
          {snapshot.status === 'unavailable' ? <p className="dsh-ca-readOnly">当前 Host 未暴露审批配置 namespace。</p> : null}
          {writable ? null : <p className="dsh-ca-readOnly">本部署的设置为只读。</p>}

          <Field label="主模型">
            <ModelSelect
              options={options}
              provider={value.provider}
              model={value.model}
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
                    <IconChevronUpOutline14 />
                  </button>
                  <button type="button" className="dsh-ca-iconButton" title="下移" aria-label="下移"
                    disabled={disabled || index === chain.length - 1} onClick={() => moveChain(index, 1)}>
                    <IconChevronDownOutline14 />
                  </button>
                  <button type="button" className="dsh-ca-iconButton" title="删除" aria-label="删除"
                    disabled={disabled} onClick={() => setChain(chain.filter((_, i) => i !== index))}>
                    <IconTrashOutline16 />
                  </button>
                </div>
              )
            })}
            <div className="dsh-ca-row">
              <button type="button" className="dsh-ca-ghostButton" disabled={disabled || chain.length >= MAX_FALLBACKS} onClick={addChain}>
                <IconPlusOutline16 /> 添加兜底候选
              </button>
            </div>
            {chainError !== '' ? <p className="dsh-ca-invalid">{chainError}</p> : null}
            <p className="dsh-ca-order">调用顺序：{judgeOrder.length === 0 ? '（未选择模型）' : judgeOrder.join(' → ')}</p>
          </Field>

          <div className="dsh-ca-grid">
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
            <Field label="ai-auto 模式下遇到 ask">
              <select className="dsh-ca-select" value={String(value.mode3OnAsk ?? 'deny')} disabled={disabled}
                onChange={(event) => setField('mode3OnAsk', event.target.value)}>
                {MODE3_ON_ASK.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
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
