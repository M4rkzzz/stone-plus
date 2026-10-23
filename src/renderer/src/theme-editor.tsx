import { useEffect, useState, type CSSProperties } from 'react'
import { ChevronDown, Monitor, Moon, Palette, Plus, RotateCcw, Sun, Trash2 } from 'lucide-react'
import { useI18n } from './i18n'
import {
  CUSTOM_THEME_COLOR_KEYS,
  CUSTOM_THEME_LIMIT,
  customThemeContrastWarnings,
  customThemePreset,
  useTheme,
  type CustomThemeColorKey,
  type CustomUiTheme,
  type UiTheme,
  type UiThemeSelection,
} from './theme'

const COLOR_LABELS: Record<CustomThemeColorKey, readonly [string, string]> = {
  background: ['页面背景', 'Canvas'],
  surface: ['卡片表面', 'Surface'],
  surfaceRaised: ['浮层表面', 'Raised surface'],
  surfaceSubtle: ['柔和表面', 'Subtle surface'],
  surfaceMuted: ['次级表面', 'Muted surface'],
  surfaceHover: ['悬停表面', 'Hover surface'],
  surfaceActive: ['选中表面', 'Active surface'],
  surfaceSunken: ['下沉表面', 'Sunken surface'],
  surfaceInset: ['内嵌表面', 'Inset surface'],
  border: ['结构边界', 'Structure'],
  controlBorder: ['控件边界', 'Controls'],
  text: ['主要文字', 'Primary text'],
  textSoft: ['次级文字', 'Secondary text'],
  muted: ['弱化文字', 'Muted text'],
  navText: ['导航文字', 'Navigation'],
  accent: ['控件强调', 'Control accent'],
  accentHover: ['控件悬停', 'Control hover'],
  accentSoft: ['强调底色', 'Accent surface'],
  accentText: ['强调文字', 'Accent text'],
  accentTextStrong: ['强调高亮', 'Accent highlight'],
  available: ['可用状态', 'Available'],
  danger: ['危险状态', 'Danger'],
  warning: ['警告状态', 'Warning'],
}

const QUICK_ACCENTS = [
  { id: 'stone', name: ['Stone 绿', 'Stone green'], swatch: '#176b52', light: ['#176b52', '#105b45', '#e5f1ed', '#176b52', '#105b45'], dark: ['#65b997', '#82caaa', '#20342d', '#65cda3', '#83ddb9'] },
  { id: 'orange', name: ['橙色', 'Orange'], swatch: '#ff9000', light: ['#d96f00', '#b95d00', '#fff0dc', '#a94f00', '#873e00'], dark: ['#ff9000', '#ffa31a', '#332719', '#ff9000', '#ffa31a'] },
  { id: 'blue', name: ['蓝色', 'Blue'], swatch: '#4d9cff', light: ['#347ac8', '#285f9d', '#e8f2ff', '#2467ad', '#174f8c'], dark: ['#559fff', '#78b3ff', '#1d2c40', '#65a8ff', '#86bcff'] },
  { id: 'violet', name: ['紫色', 'Violet'], swatch: '#9b7cff', light: ['#7558c8', '#6043aa', '#f0ebff', '#6548b4', '#4f3692'], dark: ['#9677f0', '#ad95f5', '#29233d', '#a78cff', '#bca7ff'] },
  { id: 'rose', name: ['玫红', 'Rose'], swatch: '#ef668f', light: ['#c74f73', '#a83b5e', '#ffeaf0', '#b53d62', '#922c4d'], dark: ['#e4678d', '#ee85a5', '#38212a', '#f0799d', '#f495b1'] },
  { id: 'cyan', name: ['青色', 'Cyan'], swatch: '#31b8c6', light: ['#248c97', '#1c7079', '#e2f7f8', '#1e7c87', '#155f68'], dark: ['#35aeba', '#5ac3cd', '#1a3033', '#48bfca', '#70d0d8'] },
] as const

const QUICK_COLOR_KEYS: Array<{ key: 'background' | 'surface' | 'text' | 'accentText'; label: readonly [string, string] }> = [
  { key: 'background', label: ['页面', 'Canvas'] },
  { key: 'surface', label: ['卡片', 'Surface'] },
  { key: 'text', label: ['文字', 'Text'] },
  { key: 'accentText', label: ['强调', 'Accent'] },
]

function previewColors(theme: CustomUiTheme | { base: UiTheme; colors: ReturnType<typeof customThemePreset> }) {
  return [theme.colors.background, theme.colors.surface, theme.colors.accentText, theme.colors.available]
}

function ColorField({
  colorKey,
  value,
  onChange,
}: {
  colorKey: CustomThemeColorKey
  value: string
  onChange: (value: string) => void
}) {
  const { language } = useI18n()
  const label = COLOR_LABELS[colorKey][language === 'zh-CN' ? 0 : 1]
  const labelId = `theme-color-${colorKey}`
  const [draft, setDraft] = useState(value)

  useEffect(() => setDraft(value), [value])

  const updateDraft = (next: string) => {
    setDraft(next)
    if (/^#[0-9a-f]{6}$/iu.test(next)) onChange(next.toLowerCase())
  }

  return (
    <div className="theme-color-field" role="group" aria-labelledby={labelId}>
      <span id={labelId}>{label}</span>
      <div>
        <input
          className="theme-color-field__swatch"
          type="color"
          value={value}
          aria-label={label}
          onChange={(event) => updateDraft(event.target.value)}
        />
        <input
          className="theme-color-field__hex mono"
          value={draft}
          maxLength={7}
          spellCheck={false}
          aria-label={`${label} HEX`}
          onChange={(event) => updateDraft(event.target.value)}
          onBlur={() => setDraft(value)}
        />
      </div>
    </div>
  )
}

function ThemePreview({ colors }: { colors: readonly string[] }) {
  return <span className="theme-choice__preview" aria-hidden="true">{colors.map((color, index) => <i key={`${color}-${index}`} style={{ backgroundColor: color }} />)}</span>
}

export function ThemeEditor() {
  const { t } = useI18n()
  const {
    systemTheme,
    preference,
    customThemes,
    activeCustomTheme,
    setPreference,
    createCustomTheme,
    updateCustomTheme,
    deleteCustomTheme,
    resetCustomTheme,
  } = useTheme()

  const builtIns: Array<{
    id: UiThemeSelection
    title: string
    description: string
    icon: typeof Monitor
    preview: UiTheme
  }> = [
    { id: 'system', title: t('跟随系统', 'System'), description: t('自动匹配系统外观', 'Match system appearance'), icon: Monitor, preview: systemTheme },
    { id: 'light', title: t('白天模式', 'Light'), description: t('明亮、低干扰', 'Bright and restrained'), icon: Sun, preview: 'light' },
    { id: 'dark', title: t('夜间模式', 'Dark'), description: t('灰黑底与橙色强调', 'Charcoal with orange accents'), icon: Moon, preview: 'dark' },
  ]

  const confirmDelete = (profile: CustomUiTheme) => {
    if (!window.confirm(t(`删除自定义主题“${profile.name}”？`, `Delete custom theme “${profile.name}”?`))) return
    deleteCustomTheme(profile.id)
  }

  const updateColors = (profile: CustomUiTheme, colors: Partial<CustomUiTheme['colors']>) => {
    updateCustomTheme(profile.id, { colors: { ...profile.colors, ...colors } })
  }

  const applyQuickAccent = (profile: CustomUiTheme, preset: typeof QUICK_ACCENTS[number]) => {
    const [accent, accentHover, accentSoft, accentText, accentTextStrong] = preset[profile.base]
    updateColors(profile, { accent, accentHover, accentSoft, accentText, accentTextStrong })
  }

  const contrastWarnings = activeCustomTheme ? customThemeContrastWarnings(activeCustomTheme.colors) : []

  return (
    <div className="theme-editor">
      <div className="theme-editor__heading">
        <div>
          <strong>{t('主题', 'Theme')}</strong>
          <small>{t('切换立即生效；自定义主题保存在本机。', 'Changes apply instantly; custom themes are stored on this device.')}</small>
        </div>
        <button
          className="button button--secondary"
          type="button"
          disabled={customThemes.length >= CUSTOM_THEME_LIMIT}
          title={customThemes.length >= CUSTOM_THEME_LIMIT ? t(`最多保存 ${CUSTOM_THEME_LIMIT} 个自定义主题`, `Up to ${CUSTOM_THEME_LIMIT} custom themes`) : undefined}
          onClick={() => createCustomTheme()}
        >
          <Plus size={15} />{t('增加主题', 'Add theme')}
        </button>
      </div>

      <div className="theme-editor__choices">
        {builtIns.map((option) => {
          const Icon = option.icon
          const preset = { base: option.preview, colors: customThemePreset(option.preview) }
          return (
            <button
              className={`theme-choice${preference === option.id ? ' is-selected' : ''}`}
              type="button"
              aria-pressed={preference === option.id}
              key={option.id}
              onClick={() => setPreference(option.id)}
            >
              <Icon size={17} />
              <span><strong>{option.title}</strong><small>{option.description}</small></span>
              <ThemePreview colors={previewColors(preset)} />
            </button>
          )
        })}

        {customThemes.map((profile) => {
          const selected = preference === `custom:${profile.id}`
          return (
            <div className={`theme-choice theme-choice--custom${selected ? ' is-selected' : ''}`} key={profile.id}>
              <button type="button" className="theme-choice__select" aria-pressed={selected} onClick={() => setPreference(`custom:${profile.id}`)}>
                <Palette size={17} />
                <span><strong>{profile.name}</strong><small>{profile.base === 'dark' ? t('夜间基底', 'Dark base') : t('白天基底', 'Light base')}</small></span>
                <ThemePreview colors={previewColors(profile)} />
              </button>
              <button className="theme-choice__delete" type="button" aria-label={t(`删除主题 ${profile.name}`, `Delete theme ${profile.name}`)} title={t('删除主题', 'Delete theme')} onClick={() => confirmDelete(profile)}><Trash2 size={14} /></button>
            </div>
          )
        })}
      </div>

      {activeCustomTheme && (
        <section className="theme-custom-editor">
          <header>
            <label>
              <span>{t('主题名称', 'Theme name')}</span>
              <input
                value={activeCustomTheme.name}
                maxLength={40}
                onChange={(event) => updateCustomTheme(activeCustomTheme.id, { name: event.target.value })}
              />
            </label>
            <label>
              <span>{t('基底', 'Base')}</span>
              <select
                value={activeCustomTheme.base}
                onChange={(event) => resetCustomTheme(activeCustomTheme.id, event.target.value as UiTheme)}
              >
                <option value="light">{t('白天模式', 'Light')}</option>
                <option value="dark">{t('夜间模式', 'Dark')}</option>
              </select>
            </label>
            <button className="button button--secondary" type="button" onClick={() => resetCustomTheme(activeCustomTheme.id)}><RotateCcw size={14} />{t('恢复基底配色', 'Reset colors')}</button>
            <button className="button button--danger" type="button" onClick={() => confirmDelete(activeCustomTheme)}><Trash2 size={14} />{t('删除', 'Delete')}</button>
          </header>
          <small className="theme-custom-editor__hint">{t('更换基底会重置当前配色。颜色修改会即时预览并自动保存。', 'Changing the base resets the palette. Color edits preview instantly and save automatically.')}</small>
          {contrastWarnings.length > 0 && <div className="theme-contrast-warning" role="status"><strong>{t('部分颜色对比度过低', 'Some colors have low contrast')}</strong><span>{t('Stone+ 暂时使用基底安全色显示这些文字；调整背景或文字色后会自动恢复自定义值。', 'Stone+ temporarily renders those items with safe base colors. Your custom values resume when contrast is sufficient.')}</span></div>}

          <div className="theme-quick-editor">
            <div className="theme-quick-editor__core">
              {QUICK_COLOR_KEYS.map(({ key, label }) => (
                <label key={key}>
                  <input type="color" value={activeCustomTheme.colors[key]} aria-label={t(label[0], label[1])} onChange={(event) => updateColors(activeCustomTheme, { [key]: event.target.value })} />
                  <span>{t(label[0], label[1])}</span>
                </label>
              ))}
            </div>
            <div className="theme-quick-editor__accents" role="group" aria-label={t('强调色预设', 'Accent presets')}>
              <span>{t('一键强调色', 'Accent presets')}</span>
              <div>{QUICK_ACCENTS.map((preset) => <button key={preset.id} type="button" aria-label={t(preset.name[0], preset.name[1])} aria-pressed={activeCustomTheme.colors.accentText === preset[activeCustomTheme.base][3]} title={t(preset.name[0], preset.name[1])} style={{ '--theme-accent-swatch': preset.swatch } as CSSProperties} onClick={() => applyQuickAccent(activeCustomTheme, preset)} />)}</div>
            </div>
          </div>

          <details className="theme-custom-editor__advanced">
            <summary>{t('高级颜色', 'Advanced colors')}<span>{CUSTOM_THEME_COLOR_KEYS.length}<ChevronDown size={12} /></span></summary>
            <div className="theme-custom-editor__colors">
              {CUSTOM_THEME_COLOR_KEYS.map((colorKey) => (
                <ColorField
                  key={colorKey}
                  colorKey={colorKey}
                  value={activeCustomTheme.colors[colorKey]}
                  onChange={(value) => updateColors(activeCustomTheme, { [colorKey]: value })}
                />
              ))}
            </div>
          </details>
        </section>
      )}
    </div>
  )
}
