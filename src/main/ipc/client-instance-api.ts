import { BrowserWindow, ipcMain } from 'electron'
import type { ManagedClientInstanceInput, ManagedClientLaunchMode, RouteClient } from '@shared/types'
import type { ClientInstanceManager } from '../client-instances'
import type { AppStore } from '../store/app-store'
import { assertTrustedSender } from './trusted-sender'

const clientInstanceChannels = [
  'stone:list-managed-client-instances',
  'stone:save-managed-client-instance',
  'stone:delete-managed-client-instance',
  'stone:start-managed-client-instance',
  'stone:stop-managed-client-instance',
] as const

export function registerClientInstanceApi(manager: ClientInstanceManager, store: AppStore): () => Promise<void> {
  let disposed = false
  let disposeFlight: Promise<void> | undefined
  const acceptedMutations = new Set<Promise<unknown>>()
  const unsubscribe = manager.onChange((instances) => {
    if (disposed) return
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('stone:managed-client-instances', instances)
    }
  })
  ipcMain.handle('stone:list-managed-client-instances', (event) => {
    assertTrustedSender(event)
    return manager.list()
  })
  ipcMain.handle('stone:save-managed-client-instance', (event, value: unknown) => {
    assertTrustedSender(event)
    const input = parseManagedClientInstanceInput(value)
    validateBindings(input, store)
    return trackMutation(() => manager.save(input))
  })
  ipcMain.handle('stone:delete-managed-client-instance', (event, value: unknown) => {
    assertTrustedSender(event)
    return trackMutation(() => manager.delete(parseIdentifier(value)))
  })
  ipcMain.handle('stone:start-managed-client-instance', (event, value: unknown) => {
    assertTrustedSender(event)
    return trackMutation(() => manager.start(parseIdentifier(value)))
  })
  ipcMain.handle('stone:stop-managed-client-instance', (event, value: unknown) => {
    assertTrustedSender(event)
    return trackMutation(() => manager.stop(parseIdentifier(value)))
  })

  return () => {
    if (disposeFlight) return disposeFlight
    disposed = true
    unsubscribe()
    for (const channel of clientInstanceChannels) ipcMain.removeHandler(channel)
    disposeFlight = Promise.allSettled([...acceptedMutations]).then(() => undefined)
    return disposeFlight
  }

  function trackMutation<T>(operation: () => T | Promise<T>): Promise<T> {
    const flight = Promise.resolve().then(operation)
    acceptedMutations.add(flight)
    void flight.then(
      () => acceptedMutations.delete(flight),
      () => acceptedMutations.delete(flight),
    )
    return flight
  }
}

function parseManagedClientInstanceInput(value: unknown): ManagedClientInstanceInput {
  if (!isPlainObject(value)) throw new Error('Invalid managed client instance input.')
  const allowed = new Set([
    'id', 'name', 'client', 'configDirectory', 'workingDirectory', 'executablePath',
    'launchArgs', 'launchMode', 'routeId', 'profileId',
  ])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Invalid managed client instance input.')
  }
  if (typeof value.name !== 'string') throw new Error('Invalid managed client instance name.')
  if (!isRouteClient(value.client)) throw new Error('Unsupported managed client type.')
  if (typeof value.configDirectory !== 'string') throw new Error('Invalid managed client configuration directory.')
  if (value.launchArgs !== undefined && (!Array.isArray(value.launchArgs) || value.launchArgs.some((arg) => typeof arg !== 'string'))) {
    throw new Error('Invalid managed client launch arguments.')
  }
  if (value.launchMode !== undefined && !isLaunchMode(value.launchMode)) {
    throw new Error('Invalid managed client launch mode.')
  }
  return {
    ...(value.id === undefined ? {} : { id: parseIdentifier(value.id) }),
    name: value.name,
    client: value.client,
    configDirectory: value.configDirectory,
    ...optionalStringProperty(value, 'workingDirectory', 'Invalid managed client working directory.'),
    ...optionalStringProperty(value, 'executablePath', 'Invalid managed client executable path.'),
    ...(value.launchArgs === undefined ? {} : { launchArgs: [...value.launchArgs] as string[] }),
    ...(value.launchMode === undefined ? {} : { launchMode: value.launchMode }),
    ...optionalIdentifierProperty(value, 'routeId'),
    ...optionalIdentifierProperty(value, 'profileId'),
  }
}

function optionalStringProperty(
  value: Record<string, unknown>,
  key: 'workingDirectory' | 'executablePath',
  errorMessage: string,
): Partial<Pick<ManagedClientInstanceInput, typeof key>> {
  if (value[key] === undefined) return {}
  if (typeof value[key] !== 'string') throw new Error(errorMessage)
  return { [key]: value[key] }
}

function optionalIdentifierProperty(
  value: Record<string, unknown>,
  key: 'routeId' | 'profileId',
): Partial<Pick<ManagedClientInstanceInput, typeof key>> {
  if (value[key] === undefined) return {}
  return { [key]: parseIdentifier(value[key]) }
}

function parseIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Invalid managed client instance identifier.')
  }
  return value.trim()
}

function isRouteClient(value: unknown): value is RouteClient {
  return typeof value === 'string' && ['claude', 'codex', 'gemini', 'grokbuild', 'deepseek-harness'].includes(value)
}

function isLaunchMode(value: unknown): value is ManagedClientLaunchMode {
  return value === 'terminal' || value === 'background'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validateBindings(input: ManagedClientInstanceInput, store: AppStore): void {
  const snapshot = store.getSnapshot()
  if (input.routeId) {
    const route = snapshot.routes.find((candidate) => candidate.id === input.routeId)
    if (!route) throw new Error('Bound client route not found.')
    if (route.client !== input.client) throw new Error('Bound route does not match the client instance type.')
  }
  if (input.profileId) {
    const profile = snapshot.clientProfiles.find((candidate) => candidate.id === input.profileId)
    if (!profile) throw new Error('Bound client profile not found.')
    if (profile.client !== input.client) throw new Error('Bound profile does not match the client instance type.')
  }
}
