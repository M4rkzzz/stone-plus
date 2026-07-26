import { DatabaseZap, FileLock2, Route, ShieldCheck } from 'lucide-react'
import { summarizeBuiltInProxyNetworkPolicy } from '@shared/built-in-proxy-policy'
import type { BuiltInProxyProfileSummary, BuiltInProxyRuntimeState } from '@shared/types'
import './network-policy-panel.css'

type Translator = (zh: string, en: string) => string

export function NetworkPolicyPanel({
  runtime,
  profile,
  pending = false,
  t,
}: {
  runtime: BuiltInProxyRuntimeState
  profile?: BuiltInProxyProfileSummary
  pending?: boolean
  t: Translator
}) {
  const summary = summarizeBuiltInProxyNetworkPolicy({
    ruleMode: runtime.settings.ruleMode,
    customRules: runtime.settings.customRules,
    ...(profile ? { profile: { format: profile.format, ruleStatus: profile.ruleStatus } } : {}),
  })
  const ruleText = rulePolicyText(summary.rules.policy, t)
  const ruleSource = summary.rules.importedRules === 'safe-converted'
    ? t('配置规则已转换为安全子集', 'Profile rules converted to the safe subset')
    : summary.rules.importedRules === 'downgraded'
      ? t('配置规则无法安全转换，正在使用 Stone+ 规则', 'Profile rules were downgraded to the Stone+ policy')
      : t('当前模式不读取配置规则', 'The current mode does not read profile rules')

  return <section className="panel built-in-policy" aria-labelledby="built-in-policy-title">
    <div className="built-in-policy__heading">
      <div>
        <ShieldCheck size={18} />
        <span>
          <strong id="built-in-policy-title">{pending ? t('待应用网络策略', 'Pending network policy') : t('实际网络策略', 'Effective network policy')}</strong>
          <small>{pending
            ? t('当前代次继续运行；下列内容在候选代次通过校验后才生效', 'The current generation remains active; this target applies only after the candidate passes verification')
            : t('只展示 Stone+ 真正生成并交给核心的安全配置', 'Shows only the safe configuration Stone+ actually gives the core')}</small>
        </span>
      </div>
      <span className="built-in-policy__managed">{t('Stone+ 托管', 'Stone+ managed')}</span>
    </div>

    <div className="built-in-policy__grid">
      <article>
        <span><Route size={16} /></span>
        <div><small>{pending ? t('目标路由来源', 'Target route source') : t('路由来源', 'Route source')}</small><strong>{ruleText}</strong><p>{ruleSource}</p></div>
      </article>
      <article>
        <span><DatabaseZap size={16} /></span>
        <div><small>DNS</small><strong>{t('非回环上游 · IPv4 优先', 'Non-loopback upstreams · IPv4 preferred')}</strong><p>{t('由主进程校验，UDP/53 直连解析', 'Validated by the main process; direct UDP/53 resolution')}</p></div>
      </article>
      <article>
        <span><FileLock2 size={16} /></span>
        <div><small>{t('导入边界', 'Import boundary')}</small><strong>{t('节点与安全规则子集', 'Nodes and safe rule subset')}</strong><p>{t('不执行 provider、脚本、本地文件或外部控制器', 'Providers, scripts, local files, and external controllers never run')}</p></div>
      </article>
    </div>

    {pending && <p className="built-in-policy__pending" role="status">
      {t('当前已发布代次的规则模式未包含在运行时快照中，因此不会用待应用设置冒充当前策略。', 'The published generation does not expose its rule mode in the runtime snapshot, so pending settings are not presented as the current policy.')}
    </p>}

    {summary.rules.chinaRuleSets !== 'not-used' && <p className="built-in-policy__footnote">
      {t('中国大陆规则集由 Stone+ 固定管理，并通过当前选中节点按需更新。', 'Mainland China rule sets are fixed by Stone+ and updated through the selected node only when needed.')}
    </p>}
  </section>
}

function rulePolicyText(
  policy: ReturnType<typeof summarizeBuiltInProxyNetworkPolicy>['rules']['policy'],
  t: Translator,
): string {
  switch (policy) {
    case 'safe-imported': return t('配置规则', 'Profile rules')
    case 'stone-custom': return t('自定义有序规则', 'Custom ordered rules')
    case 'stone-fallback': return t('Stone+ 安全规则', 'Stone+ safe rules')
    case 'global': return t('全局代理', 'Global proxy')
    case 'direct': return t('全部直连', 'Direct only')
  }
}
