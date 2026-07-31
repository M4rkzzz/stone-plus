import { describe, expect, it, vi } from 'vitest'
import type { ChatGptCredentialBundle } from '../../src/main/auth'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: {},
  shell: { openExternal: vi.fn() },
}))

import {
  applyChatGptWebIdentityHeaders,
  chatGptAccountCookieValue,
  chatGptUnauthenticatedShellRecovery,
  chatGptShellDiagnostic,
  chatGptImageViewerScript,
  classifyChatGptNavigationError,
  isAllowedChatGptWebUrl,
  isAllowedChatGptMediaPermission,
  isAllowedChatGptMediaPermissionCheck,
  isChatGptUnauthenticatedApp,
  isChatGptSecurityInterstitial,
  parseChatGptLightAccount,
  parseChatGptImageActionUrl,
  patchChatGptAuthenticatedDocument,
  probeNeedsTransientRetry,
} from '../../src/main/chatgpt-web-login'

describe('ChatGPT web login bridge', () => {
  it('retries only transient web-probe failures', () => {
    expect(probeNeedsTransientRetry({ me: 'network-error', accounts: 200 })).toBe(true)
    expect(probeNeedsTransientRetry({ me: 200, accounts: 'timeout' })).toBe(true)
    expect(probeNeedsTransientRetry({ me: 503, accounts: 200 })).toBe(true)
    expect(probeNeedsTransientRetry({ me: 200, accounts: 429 })).toBe(true)
    expect(probeNeedsTransientRetry({ me: 401, accounts: 200 })).toBe(false)
    expect(probeNeedsTransientRetry({ me: 200, accounts: 403 })).toBe(false)
    expect(probeNeedsTransientRetry({ me: 200, accounts: 200 })).toBe(false)
  })

  it('separates superseded, transient, and deterministic navigation failures', () => {
    expect(classifyChatGptNavigationError(new Error('ERR_ABORTED (-3) loading URL'))).toBe('aborted')
    expect(classifyChatGptNavigationError(new Error('ERR_CONNECTION_RESET (-101) loading URL'))).toBe('transient')
    expect(classifyChatGptNavigationError(new Error('ERR_NETWORK_CHANGED (-21) loading URL'))).toBe('transient')
    expect(classifyChatGptNavigationError(new Error('ERR_PROXY_CONNECTION_FAILED (-130) loading URL'))).toBe('transient')
    expect(classifyChatGptNavigationError(new Error('ERR_CERT_AUTHORITY_INVALID (-202) loading URL'))).toBe('fatal')
  })


  it('replaces only the logged-out hydration state and preserves the surrounding document', () => {
    const credential = bundle()
    const source = '<html><script>self.__state={"authStatus":"logged_out","session":null,"user":{"id":null},"sessionId":"guest"}</script></html>'

    const result = patchChatGptAuthenticatedDocument(source, credential)

    expect(result.count).toBe(1)
    expect(result.recognizedApplicationDocument).toBe(true)
    expect(result.body).toContain('"authStatus":"logged_in"')
    expect(result.body).toContain('"sessionId":"guest"')
    expect(result.body).toContain(credential.accessToken)
    expect(result.body).not.toContain('"authStatus":"logged_out"')
    expect(result.body.startsWith('<html>')).toBe(true)
    expect(result.body.endsWith('</html>')).toBe(true)
  })

  it('escapes signed profile text before injecting it into an inline script', () => {
    const credential = bundle({ idToken: jwt({ sub: 'user-1', name: '</script><img src=x>' }) })
    const source = 'x"authStatus":"logged_out","session":null,"user":{},"sessionId":"guest"y'

    const result = patchChatGptAuthenticatedDocument(source, credential)

    expect(result.count).toBe(1)
    expect(result.body).not.toContain('</script><img')
    expect(result.body).toContain('\\u003c/script\\u003e')
  })

  it('fails closed at the caller boundary when the frontend hydration signature is absent', () => {
    const source = '<html><body>changed frontend</body></html>'
    expect(patchChatGptAuthenticatedDocument(source, bundle())).toEqual({
      body: source,
      count: 0,
      recognizedApplicationDocument: false,
    })
  })

  it('patches the current client-bootstrap JSON without depending on field order', () => {
    const credential = bundle()
    const bootstrap = {
      sessionId: 'guest-session',
      user: { id: 'anonymous' },
      locale: 'zh-CN',
      session: null,
      authStatus: 'logged_out',
      isNoAuthEnabled: true,
      flags: ['naefu', 'keep-me'],
      statsigPayload: JSON.stringify({
        user: { custom: { auth_status: 'logged_out', has_logged_in_before: false, is_paid: false } },
        evaluated_keys: {},
      }),
      nested: { authStatus: 'leave-me-alone' },
    }
    const source = `<html><head><script src="/assets/runtime.js"></script></head><body><script nonce="x" type="application/json" id="client-bootstrap">\n${JSON.stringify(bootstrap)}\n</script></body></html>`

    const result = patchChatGptAuthenticatedDocument(source, credential)
    const match = result.body.match(/<script[^>]+id="client-bootstrap">([\s\S]*?)<\/script>/)
    const parsed = JSON.parse(match?.[1]?.trim() ?? '{}')

    expect(result.count).toBe(1)
    expect(result.recognizedApplicationDocument).toBe(true)
    expect(parsed.authStatus).toBe('logged_in')
    expect(parsed.session.accessToken).toBe(credential.accessToken)
    expect(parsed.user.email).toBe(credential.email)
    expect(parsed.isNoAuthEnabled).toBe(false)
    expect(parsed.flags).toEqual(['keep-me'])
    const statsig = JSON.parse(parsed.statsigPayload)
    expect(statsig.user.userID).toBe('user-1')
    expect(statsig.user.custom.auth_status).toBe('logged_in')
    expect(statsig.user.custom.has_logged_in_before).toBe(true)
    expect(statsig.evaluated_keys.userID).toBe('user-1')
    expect(parsed.sessionId).toBe('guest-session')
    expect(parsed.nested.authStatus).toBe('leave-me-alone')
    expect(result.body).toContain('<html><head><script src="/assets/runtime.js"></script>')
    expect(result.body).toContain('</style></head><body>')
    expect(result.body).toContain('</script></body></html>')
  })

  it('patches bootstrap and loading mask as one document operation', () => {
    const bootstrap = '<script id="client-bootstrap" type="application/json">{"authStatus":"logged_out","session":null,"user":null}</script>'
    const source = `<html><head></head><body>${bootstrap}</body></html>`

    const result = patchChatGptAuthenticatedDocument(source, bundle())

    expect(result.body).toContain('stone-chatgpt-authenticated-loading')
    expect(result.body).toContain('"authStatus":"logged_in"')
  })

  it('does not remask an authenticated follow-up document', () => {
    const bootstrap = '<script id="client-bootstrap" type="application/json">{"authStatus":"logged_out","session":null,"user":null}</script>'
    const source = `<html><head></head><body>${bootstrap}</body></html>`

    const result = patchChatGptAuthenticatedDocument(source, bundle(), { includeLoadingMask: false })

    expect(result.count).toBe(1)
    expect(result.body).toContain('"authStatus":"logged_in"')
    expect(result.body).not.toContain('stone-chatgpt-authenticated-loading')
  })

  it('enables only authenticated route prefetches in the current router stream', () => {
    const bootstrap = '<script id="client-bootstrap" type="application/json">{"authStatus":"logged_out","session":null,"user":null}</script>'
    const values: unknown[] = [
      { _1: 2 },
      'loaderData',
      { _3: 4, _5: 6 },
      'root',
      { _7: 8, _9: 10, _11: 10, _12: 10 },
      'routes/_conversation',
      { _13: 10, _14: 10, _15: 10, _16: 10, _17: 10 },
      'disablePrefetch',
      true,
      'shouldPrefetchAccount',
      false,
      'shouldPrefetchUser',
      'shouldPrefetchModels',
      'shouldPrefetchInternalModels',
      'shouldPrefetchStarterPrompts',
      'shouldPrefetchHistory',
      'shouldPrefetchStarredConversations',
    ]
    const stream = `window.__reactRouterContext.streamController.enqueue(${JSON.stringify(`${JSON.stringify(values)}\n`)});`
    const source = `<html><head></head><body>${bootstrap}<script>${stream}</script></body></html>`

    const result = patchChatGptAuthenticatedDocument(source, bundle())
    const match = result.body.match(/streamController\.enqueue\(("(?:\\.|[^"\\])*")\)/)
    const chunk = JSON.parse(match?.[1] ?? '""') as string
    const patched = JSON.parse(chunk) as unknown[]
    const trueReference = patched.findIndex((value) => value === true)
    const falseReference = patched.findIndex((value) => value === false)
    const referenceFor = (key: string): unknown => {
      const keyReference = patched.findIndex((value) => value === key)
      const serializedKey = `_${keyReference}`
      return patched.find((value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, serializedKey))?.[serializedKey]
    }

    expect(referenceFor('disablePrefetch')).toBe(falseReference)
    for (const key of [
      'shouldPrefetchAccount',
      'shouldPrefetchUser',
      'shouldPrefetchModels',
      'shouldPrefetchInternalModels',
      'shouldPrefetchStarterPrompts',
      'shouldPrefetchHistory',
      'shouldPrefetchStarredConversations',
    ]) {
      expect(referenceFor(key)).toBe(trueReference)
    }
  })

  it('uses the real ChatGPT user id instead of Stone account-workspace identity', () => {
    const credential = bundle({
      accountId: 'workspace-1',
      userId: 'user-real__workspace-1',
      accessToken: jwt({
        sub: 'auth0|provider-subject',
        'https://api.openai.com/auth': {
          chatgpt_account_user_id: 'user-real__workspace-1',
          chatgpt_compute_residency: 'no_constraint',
          chatgpt_plan_type: 'plus',
          chatgpt_user_id: 'user-real',
        },
        exp: 4_102_444_800,
      }),
    })
    const source = '<script id="client-bootstrap" type="application/json">{"authStatus":"logged_out","session":null,"user":null}</script>'

    const result = patchChatGptAuthenticatedDocument(source, credential)
    const match = result.body.match(/<script[^>]+id="client-bootstrap"[^>]*>([\s\S]*?)<\/script>/)
    const parsed = JSON.parse(match?.[1] ?? '{}')

    expect(parsed.session.user.id).toBe('user-real')
    expect(parsed.user.id).toBe('user-real')
    expect(parsed.session.user.id).not.toContain('__workspace-1')
    expect(parsed.session.account).toMatchObject({
      id: 'workspace-1',
      planType: 'plus',
      structure: 'personal',
      computeResidency: 'no_constraint',
    })
    expect(parsed.session.account).not.toHaveProperty('organizationId')
    expect(parsed.session.account).not.toHaveProperty('gracePeriodId')
  })

  it('uses the verified web workspace to distinguish Plus and Team-style accounts', () => {
    const lightAccount = parseChatGptLightAccount({
      accounts: {
        'workspace-1': {
          account: {
            account_id: 'workspace-1',
            organization_id: 'org-real',
            account_residency_region: 'eu',
            account_compute_residency: 'eu',
            structure: 'workspace',
            plan_type: 'team',
            is_usage_based_seat_enabled: true,
            is_fedramp_compliant_workspace: false,
            is_conversation_classifier_enabled_for_workspace: true,
          },
          entitlement: { is_delinquent: false, grace_period_id: null },
          features: ['flora', 'model_switcher'],
        },
      },
    }, 'workspace-1')
    expect(lightAccount).toEqual({
      id: 'workspace-1',
      organizationId: 'org-real',
      residencyRegion: 'eu',
      computeResidency: 'eu',
      structure: 'workspace',
      planType: 'team',
      isUsageBasedSeatEnabled: true,
      isFedrampCompliantWorkspace: false,
      isConversationClassifierEnabledForWorkspace: true,
      hasFloraFeature: true,
      isDelinquent: false,
    })

    const source = '<script id="client-bootstrap" type="application/json">{"authStatus":"logged_out","session":null,"user":null}</script>'
    const result = patchChatGptAuthenticatedDocument(source, bundle({ accountId: 'workspace-1' }), { lightAccount })
    const match = result.body.match(/<script[^>]+id="client-bootstrap"[^>]*>([\s\S]*?)<\/script>/)
    const parsed = JSON.parse(match?.[1] ?? '{}')
    expect(parsed.session.account.planType).toBe('team')
    expect(parsed.session.account.structure).toBe('workspace')
  })

  it('keeps the working Plus cookie and exposes two account-shell recovery modes', () => {
    const credential = bundle({ accountId: 'personal-account-id' })
    const personal = { id: 'personal-account-id', structure: 'personal' as const }
    const workspace = { id: 'workspace-id', structure: 'workspace' as const }

    expect(chatGptAccountCookieValue(credential, personal, 'plus', 'preferred')).toBe('personal')
    expect(chatGptAccountCookieValue(credential, personal, 'plus', 'account-id')).toBe('personal-account-id')
    expect(chatGptAccountCookieValue(credential, personal, 'plus', 'none')).toBeUndefined()
    expect(chatGptAccountCookieValue(credential, workspace, 'team', 'preferred')).toBe('workspace-id')
    expect(chatGptUnauthenticatedShellRecovery(0)).toEqual({
      accountCookieMode: 'account-id',
      target: 'https://chatgpt.com/',
    })
    expect(chatGptUnauthenticatedShellRecovery(1)).toEqual({
      accountCookieMode: 'none',
      target: 'https://chatgpt.com/auth/login?next=%2F',
    })
    expect(chatGptUnauthenticatedShellRecovery(2)).toEqual({
      accountCookieMode: 'preferred',
      target: 'https://chatgpt.com/',
    })
    expect(chatGptUnauthenticatedShellRecovery(3)).toEqual({
      accountCookieMode: 'account-id',
      target: 'https://chatgpt.com/auth/login?next=%2F',
    })
    expect(chatGptUnauthenticatedShellRecovery(4)).toBeUndefined()
    expect(chatGptShellDiagnostic({
      attempt: 2,
      source: '<script src="/unauth-mweb/app.js"></script>',
      target: 'https://chatgpt.com/auth/login?next=%2F',
      status: 200,
      structure: 'personal',
      planType: 'Plus',
      edgeRay: 'abc123-SJC',
    })).toBe('U2:mweb:personal-plus:/auth/login:200:cf-abc123-SJC')
  })

  it('falls back to the official default web account when a legacy credential has no web account id', () => {
    const lightAccount = parseChatGptLightAccount({
      accounts: {
        default: {
          account: {
            account_id: 'personal-plus',
            structure: 'personal',
            plan_type: 'plus',
          },
          entitlement: { is_delinquent: false, grace_period_id: null },
          features: ['flora'],
        },
      },
      account_ordering: ['personal-plus'],
    }, 'legacy-api-identity')

    expect(lightAccount).toMatchObject({
      id: 'personal-plus',
      structure: 'personal',
      planType: 'plus',
      hasFloraFeature: true,
    })
    expect(lightAccount).not.toHaveProperty('gracePeriodId')
  })

  it('recognizes a changed application bootstrap but does not modify it unsafely', () => {
    const source = '<html><script id="client-bootstrap" type="application/json">{"newAuthShape":true}</script></html>'

    expect(patchChatGptAuthenticatedDocument(source, bundle())).toEqual({
      body: source,
      count: 0,
      recognizedApplicationDocument: true,
    })
  })

  it('does not mistake a Cloudflare interstitial for a changed ChatGPT application contract', () => {
    const source = '<html><body>Enable JavaScript and cookies to continue<script src="/cdn-cgi/challenge-platform/x"></script></body></html>'

    expect(patchChatGptAuthenticatedDocument(source, bundle())).toEqual({
      body: source,
      count: 0,
      recognizedApplicationDocument: false,
    })
    expect(isChatGptSecurityInterstitial(source)).toBe(true)
  })

  it('recognizes the anonymous mobile shell so the bridge can purge and retry it', () => {
    expect(isChatGptUnauthenticatedApp('<script src="/unauth-mweb/assets/client.js"></script>')).toBe(true)
    expect(isChatGptUnauthenticatedApp('<main>Sign in is required to continue.</main>')).toBe(true)
    expect(isChatGptUnauthenticatedApp('<script id="client-bootstrap">{}</script>')).toBe(false)
  })

  it('replaces stale web identity headers with the selected account identity', () => {
    const credential = bundle()

    expect(applyChatGptWebIdentityHeaders({
      authorization: 'Bearer stale-private',
      'CHATGPT-ACCOUNT-ID': 'stale-account',
      Accept: 'application/json',
    }, credential)).toEqual({
      Accept: 'application/json',
      Authorization: `Bearer ${credential.accessToken}`,
      'ChatGPT-Account-Id': credential.accountId,
    })
  })

  it('allows only HTTPS navigation on the exact ChatGPT web host', () => {
    expect(isAllowedChatGptWebUrl('https://chatgpt.com/')).toBe(true)
    expect(isAllowedChatGptWebUrl('https://chatgpt.com/c/example')).toBe(true)
    expect(isAllowedChatGptWebUrl('http://chatgpt.com/')).toBe(false)
    expect(isAllowedChatGptWebUrl('https://evil.chatgpt.com/')).toBe(false)
    expect(isAllowedChatGptWebUrl('https://chatgpt.com.evil.example/')).toBe(false)
  })

  it('allows only ChatGPT microphone audio and speaker selection', () => {
    expect(isAllowedChatGptMediaPermission('media', 'https://chatgpt.com/c/example', ['audio'])).toBe(true)
    expect(isAllowedChatGptMediaPermission('speaker-selection', 'https://chatgpt.com/', undefined)).toBe(true)
    expect(isAllowedChatGptMediaPermission('media', 'https://chatgpt.com/', ['video'])).toBe(false)
    expect(isAllowedChatGptMediaPermission('media', 'https://chatgpt.com/', ['audio', 'video'])).toBe(false)
    expect(isAllowedChatGptMediaPermission('media', 'https://evil.chatgpt.com/', ['audio'])).toBe(false)
    expect(isAllowedChatGptMediaPermission('media', 'https://chatgpt.com.evil.example/', ['audio'])).toBe(false)
    expect(isAllowedChatGptMediaPermission('notifications', 'https://chatgpt.com/', ['audio'])).toBe(false)
  })

  it('grants the Chromium media permission check only for exact-origin audio', () => {
    expect(isAllowedChatGptMediaPermissionCheck('media', 'https://chatgpt.com/', 'audio')).toBe(true)
    expect(isAllowedChatGptMediaPermissionCheck('media', 'https://chatgpt.com/', 'unknown')).toBe(false)
    expect(isAllowedChatGptMediaPermissionCheck('media', 'https://chatgpt.com/', 'video')).toBe(false)
    expect(isAllowedChatGptMediaPermissionCheck('media', 'http://chatgpt.com/', 'audio')).toBe(false)
    expect(isAllowedChatGptMediaPermissionCheck('geolocation', 'https://chatgpt.com/', 'audio')).toBe(false)
  })

  it('accepts image save actions only with the per-window token and bounded image id', () => {
    const token = 'window-secret'
    expect(parseChatGptImageActionUrl(
      `stone-chatgpt-image://save/?token=${token}&id=image-a1`,
      token,
    )).toEqual({ imageId: 'image-a1' })
    expect(parseChatGptImageActionUrl(
      'stone-chatgpt-image://save/?token=forged&id=image-a1',
      token,
    )).toBeUndefined()
    expect(parseChatGptImageActionUrl(
      `stone-chatgpt-image://open/?token=${token}&id=image-a1`,
      token,
    )).toBeUndefined()
    expect(parseChatGptImageActionUrl(
      `https://chatgpt.com/?token=${token}&id=image-a1`,
      token,
    )).toBeUndefined()
    expect(parseChatGptImageActionUrl(
      `stone-chatgpt-image://save/?token=${token}&id=../../secret`,
      token,
    )).toBeUndefined()
  })

  it('builds a self-contained image viewer with browsing, zooming and saving controls', () => {
    const script = chatGptImageViewerScript('one-window-token')
    expect(() => new Function(script)).not.toThrow()
    expect(script).toContain('stone-image-preview')
    expect(script).toContain('readDataUrl')
    expect(script).toContain('图片另存为')
    expect(script).toContain('one-window-token')
  })
})

function bundle(overrides: Partial<ChatGptCredentialBundle> = {}): ChatGptCredentialBundle {
  return {
    accessToken: jwt({ sub: 'user-1', email: 'user@example.com', exp: 4_102_444_800 }),
    refreshToken: 'refresh-private',
    idToken: jwt({ sub: 'user-1', email: 'user@example.com', name: 'Stone User' }),
    accountId: 'account-1',
    userId: 'user-1',
    email: 'user@example.com',
    expiresAt: 4_102_444_800_000,
    ...overrides,
  }
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}
