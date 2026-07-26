import path from 'node:path'

import { verifyFrpcRuntime } from './verify-frpc-runtime.mjs'
import { runtimeTargetName, verifyRuntimeTarget } from './verify-sing-box-runtime.mjs'

const electronBuilderArch = new Map([
  [0, 'ia32'],
  [1, 'x64'],
  [2, 'armv7l'],
  [3, 'arm64'],
  [4, 'universal']
])

export default async function verifyRuntimeInputsBeforePack(context) {
  const architecture = typeof context.arch === 'number'
    ? electronBuilderArch.get(context.arch)
    : String(context.arch)
  const targetName = runtimeTargetName(context.electronPlatformName, architecture)
  const result = await verifyRuntimeTarget(targetName, {
    runtimeRoot: path.join(context.packager.projectDir, 'build', 'sing-box')
  })
  console.info(`Verified sing-box ${result.version} before packaging ${targetName}.`)
  if (context.electronPlatformName === 'win32') {
    const frpc = await verifyFrpcRuntime({
      runtimeRoot: path.join(context.packager.projectDir, 'build', 'frp')
    })
    console.info(`Verified frpc ${frpc.version} before packaging ${frpc.target}.`)
  }
}
