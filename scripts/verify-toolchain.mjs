import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const packageJsonUrl = new URL('../package.json', import.meta.url)
const nvmrcUrl = new URL('../.nvmrc', import.meta.url)
const packageJson = JSON.parse(readFileSync(packageJsonUrl, 'utf8'))
const expectedNode = readFileSync(nvmrcUrl, 'utf8').trim().replace(/^v/, '')
const packageManagerMatch = /^npm@(.+)$/.exec(packageJson.packageManager ?? '')
const expectedNpm = packageManagerMatch?.[1]

function detectNpmVersion() {
  const userAgentMatch = /^npm\/([^\s]+)/.exec(process.env.npm_config_user_agent ?? '')
  if (userAgentMatch) return userAgentMatch[1]

  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, '--version'], {
      encoding: 'utf8'
    }).trim()
  }

  if (process.platform === 'win32') {
    return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'npm --version'], {
      encoding: 'utf8'
    }).trim()
  }

  return execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()
}

const actualNode = process.versions.node
const actualNpm = detectNpmVersion()
const errors = []

if (!expectedNpm) {
  errors.push('package.json packageManager must use the exact npm@<version> format')
}
if (packageJson.engines?.node !== expectedNode) {
  errors.push(`package.json engines.node must match .nvmrc (${expectedNode})`)
}
if (packageJson.engines?.npm !== expectedNpm) {
  errors.push(`package.json engines.npm must match packageManager (${expectedNpm ?? 'missing'})`)
}
if (actualNode !== expectedNode) {
  errors.push(`Node.js ${expectedNode} is required; current version is ${actualNode}`)
}
if (expectedNpm && actualNpm !== expectedNpm) {
  errors.push(`npm ${expectedNpm} is required; current version is ${actualNpm}`)
}

if (errors.length > 0) {
  console.error('Stone+ toolchain verification failed:')
  for (const error of errors) console.error(`- ${error}`)
  console.error('Run `nvm use` (or install the version from .nvmrc) before continuing.')
  process.exit(1)
}

console.log(`Stone+ toolchain verified: Node.js ${actualNode}, npm ${actualNpm}`)
