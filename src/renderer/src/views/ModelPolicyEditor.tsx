import { useMemo, useState } from 'react'
import { AlertTriangle, Check, CheckCircle2, LoaderCircle, Play, RefreshCw, Search, XCircle } from 'lucide-react'
import type { AccountModelTestResult, ModelPolicy } from '@shared/types'
import { localizeBackendError, localizeBackendMessage } from '../backend-message'
import { useI18n } from '../i18n'
import { Badge, InfoTip, relativeTime } from '../ui'
import { normalizeModelNames } from '../model-policy'
import { modelTestCompleted, modelTestFailed, modelTestTitle, type ModelTestState } from '../model-test-state'

export interface ModelPolicyOption {
  model: string
  supportCount?: number
  totalAccounts?: number
}

export function ModelPolicyEditor({
  title,
  description,
  policy,
  selectedModels,
  options,
  onPolicyChange,
  onSelectedModelsChange,
  onRefresh,
  onTestModel,
  testDisabledReason,
  refreshing = false,
  refreshDisabledReason,
  refreshedAt,
  catalogNotice,
  emptyMessage,
  emptySelectionMessage,
}: {
  title: string
  description: string
  policy: ModelPolicy
  selectedModels: string[]
  options: ModelPolicyOption[]
  onPolicyChange: (policy: ModelPolicy) => void
  onSelectedModelsChange: (models: string[]) => void
  onRefresh?: () => void
  onTestModel?: (model: string) => Promise<AccountModelTestResult>
  testDisabledReason?: string
  refreshing?: boolean
  refreshDisabledReason?: string
  refreshedAt?: number
  catalogNotice?: string
  emptyMessage?: string
  emptySelectionMessage?: string
}) {
  const { t, language, locale } = useI18n()
  const [query, setQuery] = useState('')
  const [manualModel, setManualModel] = useState('')
  const [testStates, setTestStates] = useState<Record<string, ModelTestState>>({})
  const selected = useMemo(() => new Set(selectedModels), [selectedModels])
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return options
    return options.filter((option) => option.model.toLocaleLowerCase().includes(normalizedQuery))
  }, [options, query])

  const toggleModel = (model: string) => {
    if (policy !== 'selected') return
    onSelectedModelsChange(selected.has(model)
      ? selectedModels.filter((candidate) => candidate !== model)
      : normalizeModelNames([...selectedModels, model]))
  }

  const testModel = async (model: string) => {
    const normalizedModel = model.trim()
    if (!onTestModel || !normalizedModel || testStates[normalizedModel]?.status === 'testing') return
    setTestStates((current) => ({ ...current, [normalizedModel]: { status: 'testing' } }))
    try {
      const result = await onTestModel(normalizedModel)
      const completed = modelTestCompleted(result, t('模型未返回有效响应', 'The model did not return a valid response.'))
      const localized = completed.status === 'failure'
        ? { ...completed, message: localizeBackendMessage(completed.message, language, t('模型未返回有效响应', 'The model did not return a valid response.')) }
        : completed
      setTestStates((current) => ({ ...current, [normalizedModel]: localized }))
    } catch (cause) {
      const fallback = t('模型测试失败', 'Model test failed.')
      setTestStates((current) => ({
        ...current,
        [normalizedModel]: modelTestFailed(new Error(localizeBackendError(cause, language, fallback)), fallback),
      }))
    }
  }

  const manualTestState = testStates[manualModel.trim()]

  return (
    <section className="model-policy">
      <div className="model-policy__heading">
        <div>
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
        {onRefresh && (
          <button
            className="button button--secondary model-policy__refresh"
            type="button"
            disabled={refreshing || Boolean(refreshDisabledReason)}
            title={refreshDisabledReason ?? t('使用此账号刷新可用模型', 'Refresh available models using this account')}
            onClick={onRefresh}
          >
            {refreshing ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
            {refreshing ? t('正在拉取', 'Refreshing') : t('刷新可用模型', 'Refresh models')}
          </button>
        )}
      </div>

      <div className="model-policy__meta">
        <Badge tone={policy === 'all' ? 'info' : 'neutral'}>{policy === 'all' ? t('全部开放', 'All models') : t(`指定开放 ${selectedModels.length}`, `${selectedModels.length} selected`)}</Badge>
        <span>{t(`${options.length} 个候选模型`, `${options.length} candidate ${options.length === 1 ? 'model' : 'models'}`)}</span>
        {refreshedAt !== undefined && <span>{t('更新于', 'Updated')} {relativeTime(refreshedAt, locale)}</span>}
        {refreshDisabledReason && <span>{refreshDisabledReason}</span>}
      </div>

      {catalogNotice && <div className="model-policy__notice"><AlertTriangle size={15} /><span>{catalogNotice}</span></div>}

      <div className="model-policy__modes" role="radiogroup" aria-label={t(`${title}策略`, `${title} policy`)}>
        <button
          type="button"
          role="radio"
          aria-checked={policy === 'all'}
          className={policy === 'all' ? 'active' : ''}
          onClick={() => onPolicyChange('all')}
        >
          <span className="radio-mark">{policy === 'all' && <Check size={13} />}</span>
          <span><strong>{t('全部开放', 'Allow all')}<InfoTip text={t('目录更新后自动包含新增模型。', 'Automatically include new models when the catalog is updated.')} focusable={false} /></strong></span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={policy === 'selected'}
          className={policy === 'selected' ? 'active' : ''}
          onClick={() => onPolicyChange('selected')}
        >
          <span className="radio-mark">{policy === 'selected' && <Check size={13} />}</span>
          <span><strong>{t('指定开放', 'Allow selected')}<InfoTip text={t('只开放下方明确勾选的模型。', 'Allow only the models explicitly selected below.')} focusable={false} /></strong></span>
        </button>
      </div>

      {options.length > 0 && (
        <div className="model-policy__toolbar">
          <label className="model-policy__search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索模型', 'Search models')} /></label>
          {policy === 'selected' && <><button className="text-button" type="button" onClick={() => onSelectedModelsChange(options.map((option) => option.model))}>{t('全选', 'Select all')}</button><button className="text-button" type="button" onClick={() => onSelectedModelsChange([])}>{t('清空', 'Clear')}</button></>}
        </div>
      )}

      {onTestModel && (
        <div className="model-policy__manual-test">
          <label>
            <span>{t('测试其他模型', 'Test another model')}</span>
            <input
              className="mono"
              value={manualModel}
              onChange={(event) => setManualModel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                void testModel(manualModel)
              }}
              placeholder={t('例如 gpt-5.6-sol', 'e.g. gpt-5.6-sol')}
            />
          </label>
          <button
            className="button button--secondary"
            type="button"
            title={testDisabledReason ?? (manualModel.trim() ? modelTestTitle(manualModel.trim(), manualTestState, language) : t('输入完整的模型标识', 'Enter a complete model identifier'))}
            disabled={!manualModel.trim() || Boolean(testDisabledReason) || manualTestState?.status === 'testing'}
            onClick={() => void testModel(manualModel)}
          >
            {manualTestState?.status === 'testing' ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
            {t('测试', 'Test')}
          </button>
          {manualTestState && manualTestState.status !== 'testing' && (
            <span
              className={`model-policy__manual-result is-${manualTestState.status}`}
              title={modelTestTitle(manualModel.trim(), manualTestState, language)}
            >
              {manualTestState.status === 'success'
                ? <><CheckCircle2 size={14} />{t('可用', 'Available')} · {manualTestState.latencyMs} ms</>
                : <><XCircle size={14} />{t('不可用', 'Unavailable')} · {localizeBackendMessage(manualTestState.message, language, t('模型测试失败', 'Model test failed.'))}</>}
            </span>
          )}
        </div>
      )}

      <div className="model-picker">
        {filtered.map((option) => {
          const checked = policy === 'all' || selected.has(option.model)
          const hasCoverage = option.supportCount !== undefined && option.totalAccounts !== undefined
          const fullCoverage = hasCoverage && option.supportCount === option.totalAccounts
          const testState = testStates[option.model]
          return (
            <div className={`${checked ? 'selected' : ''} model-picker__row`} key={option.model}>
              <button
                type="button"
                className={`model-picker__select ${policy === 'all' ? 'read-only' : ''}`}
                aria-pressed={checked}
                onClick={() => toggleModel(option.model)}
              >
                <span className="checkbox-mark">{checked && <Check size={13} />}</span>
                <code title={option.model}>{option.model}</code>
                {hasCoverage && <Badge tone={fullCoverage ? 'success' : 'warning'}>{t('支持', 'Supported by')} {option.supportCount}/{option.totalAccounts}</Badge>}
              </button>
              {onTestModel && (
                <div className={`model-picker__test-result${testState ? ` is-${testState.status}` : ''}`}>
                  {testState?.status === 'success' && <span>{testState.latencyMs} ms</span>}
                  {testState?.status === 'failure' && <span>{t('不可用', 'Unavailable')}</span>}
                  <button
                    className="icon-button model-picker__test"
                    type="button"
                    title={testDisabledReason ?? modelTestTitle(option.model, testState, language)}
                    aria-label={testDisabledReason ?? modelTestTitle(option.model, testState, language)}
                    disabled={Boolean(testDisabledReason) || testState?.status === 'testing'}
                    onClick={() => void testModel(option.model)}
                  >
                    {testState?.status === 'testing'
                      ? <LoaderCircle size={15} className="spin" />
                      : testState?.status === 'success'
                        ? <CheckCircle2 size={15} />
                        : testState?.status === 'failure'
                          ? <XCircle size={15} />
                          : <Play size={15} />}
                  </button>
                </div>
              )}
            </div>
          )
        })}
        {!filtered.length && <div className="model-picker__empty">{options.length ? t('没有匹配的模型。', 'No matching models.') : (emptyMessage ?? t('尚无可用模型。', 'No models available yet.'))}</div>}
      </div>

      {policy === 'selected' && selectedModels.length === 0 && <div className="model-policy__empty-selection">{emptySelectionMessage ?? t('当前明确不开放任何模型。', 'No models are explicitly allowed.')}</div>}
    </section>
  )
}
