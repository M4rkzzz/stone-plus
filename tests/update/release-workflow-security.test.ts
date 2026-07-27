import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const releaseWorkflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
const releaseGuide = readFileSync(resolve('docs/release-guide.zh-CN.md'), 'utf8')
const packageMetadata = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  packageManager: string
  engines: { node: string; npm: string }
  build: {
    asar: boolean
    beforePack: string
    electronFuses?: Record<string, boolean>
    extraResources: Array<{ from: string; to: string }>
    win: { extraResources: Array<{ from: string; to: string }> }
  }
}
const pinnedNodeVersion = readFileSync(resolve('.nvmrc'), 'utf8').trim().replace(/^v/, '')
const electronBuilderSchema = JSON.parse(readFileSync(resolve('node_modules/app-builder-lib/scheme.json'), 'utf8')) as {
  definitions: { FuseOptionsV1: { properties: Record<string, unknown> } }
}
const beforePackHook = readFileSync(resolve('scripts/electron-builder-before-pack.mjs'), 'utf8')
const electronSmoke = readFileSync(resolve('scripts/electron-smoke.mjs'), 'utf8')
const thirdPartyNotices = readFileSync(resolve('THIRD_PARTY_NOTICES.md'), 'utf8')
const lazyValLicense = readFileSync(resolve('LICENSES/npm/lazy-val-1.0.5-MIT.txt'), 'utf8')

describe('release workflow supply-chain policy', () => {
  it('pins every external GitHub Action to a full commit SHA', () => {
    const uses = [...releaseWorkflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1])

    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) {
      expect(action, `${action} must be immutable`).toMatch(/^[^/\s]+\/[^@\s]+@[0-9a-f]{40}$/)
    }
  })

  it('keeps the documented ad-hoc macOS baseline until notarization credentials are provisioned', () => {
    expect(releaseWorkflow).toContain('--config.mac.identity=-')
    expect(releaseWorkflow).toContain('--config.mac.hardenedRuntime=false')
    expect(releaseWorkflow).not.toContain('--config.mac.notarize=true')
    expect(releaseWorkflow).not.toContain('secrets.MAC_CSC_LINK')
    expect(releaseWorkflow).not.toContain('secrets.APPLE_APP_SPECIFIC_PASSWORD')
  })

  it('does not expose the release write token to dependency lifecycle scripts', () => {
    const releaseJob = releaseWorkflow.slice(releaseWorkflow.indexOf('\n  release:'))
    const installStep = releaseJob.slice(
      releaseJob.indexOf('- name: Install metadata validation dependencies'),
      releaseJob.indexOf('- name: Download platform packages'),
    )
    const publishStep = releaseJob.slice(
      releaseJob.indexOf('- name: Create draft, upload assets, and publish GitHub Release'),
    )

    expect(releaseJob.slice(0, releaseJob.indexOf('    steps:'))).not.toContain('GH_TOKEN')
    expect(installStep).not.toContain('GH_TOKEN')
    expect(releaseJob).toContain('persist-credentials: false')
    expect(publishStep).toContain('GH_TOKEN: ${{ github.token }}')
  })

  it('binds Authenticode verification to project identity and requires a timestamp', () => {
    expect(releaseWorkflow).toContain('PROJECT_IDENTITY.json')
    expect(releaseWorkflow).toContain('identity.signing.windowsAuthenticode.sha1Thumbprint')
    expect(releaseWorkflow).not.toContain('vars.WIN_SIGNING_CERT_SHA1')
    expect(releaseWorkflow).toContain('signature.TimeStamperCertificate')
  })

  it('keeps the documented release toolchain aligned with machine-enforced pins', () => {
    expect(packageMetadata.engines.node).toBe(pinnedNodeVersion)
    expect(packageMetadata.packageManager).toBe(`npm@${packageMetadata.engines.npm}`)
    expect(releaseGuide).toContain(`| Node.js | ${pinnedNodeVersion}`)
    expect(releaseGuide).toContain(`| npm | ${packageMetadata.engines.npm}`)
  })

  it('locks packaged Electron to the integrity-protected ASAR and disables Node injection fuses', () => {
    expect(packageMetadata.build.asar).toBe(true)
    expect(packageMetadata.build.electronFuses).toMatchObject({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    })
    for (const fuse of Object.keys(packageMetadata.build.electronFuses ?? {})) {
      expect(electronBuilderSchema.definitions.FuseOptionsV1.properties).toHaveProperty(fuse)
    }
    expect(releaseWorkflow).toContain('Verify packaged Electron fuse policy')
    expect(releaseWorkflow).toContain('EnableEmbeddedAsarIntegrityValidation is Enabled')
  })

  it('runs packaged smoke against an isolated debug copy without weakening the signed executable', () => {
    const smokeStep = releaseWorkflow.slice(
      releaseWorkflow.indexOf('- name: Smoke packaged Windows application'),
      releaseWorkflow.indexOf('- name: Upload build artifacts'),
    )

    expect(smokeStep).toContain('$smokeRoot = Join-Path $env:RUNNER_TEMP')
    expect(smokeStep).toContain('Copy-Item -LiteralPath (Split-Path $originalExe -Parent)')
    expect(smokeStep).toContain('write --app $smokeExe EnableNodeCliInspectArguments=on')
    expect(smokeStep).not.toContain('write --app $originalExe')
    expect(smokeStep).toContain('$afterHash -ne $originalHash')
    expect(smokeStep).toContain("$originalFuses.Contains('EnableNodeCliInspectArguments is Disabled')")
    expect(electronSmoke).toContain("args: packagedExecutablePath ? [] : ['.']")
  })

  it('packages and verifies the pinned frpc manifest before and after Windows packaging', () => {
    expect(packageMetadata.build.beforePack).toBe('./scripts/electron-builder-before-pack.mjs')
    expect(beforePackHook).toContain("import { verifyFrpcRuntime } from './verify-frpc-runtime.mjs'")
    expect(beforePackHook).toContain("context.electronPlatformName === 'win32'")
    expect(packageMetadata.build.win.extraResources).toContainEqual({
      from: 'build/frp/runtime-manifest.json',
      to: 'frp/runtime-manifest.json',
    })
    expect(releaseWorkflow).toContain('npm run frp:verify')
    expect(releaseWorkflow).toContain('release/win-unpacked/resources/frp')
  })

  it('supplies and packages the MIT notice omitted from the lazy-val npm artifact', () => {
    expect(packageMetadata.build.extraResources).toContainEqual({
      from: 'LICENSES/npm/lazy-val-1.0.5-MIT.txt',
      to: 'licenses/npm/lazy-val-1.0.5-MIT.txt',
    })
    expect(thirdPartyNotices).toContain('lazy-val@1.0.5')
    expect(thirdPartyNotices).toContain('licenses/npm/lazy-val-1.0.5-MIT.txt')
    expect(lazyValLicense).toContain('Copyright (c) Vladimir Krivosheev')
    expect(lazyValLicense).toContain('Permission is hereby granted, free of charge')
  })
})
