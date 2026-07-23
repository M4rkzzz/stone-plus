import path from 'node:path'

import { runtimeTargetName, verifyRuntimeTarget } from './verify-sing-box-runtime.mjs'

const electronBuilderArch = new Map([
  [0, 'ia32'],
  [1, 'x64'],
  [2, 'armv7l'],
  [3, 'arm64'],
  [4, 'universal']
])

export default async function verifySingBoxBeforePack(context) {
  const architecture = typeof context.arch === 'number'
    ? electronBuilderArch.get(context.arch)
    : String(context.arch)
  const targetName = runtimeTargetName(context.electronPlatformName, architecture)
  const result = await verifyRuntimeTarget(targetName, {
    runtimeRoot: path.join(context.packager.projectDir, 'build', 'sing-box')
  })
  console.info(`Verified sing-box ${result.version} before packaging ${targetName}.`)
}
