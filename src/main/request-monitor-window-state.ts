import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface RequestMonitorWindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

export interface RequestMonitorWindowState extends RequestMonitorWindowBounds {
  isOpen: boolean
  alwaysOnTop: boolean
  opacity: number
}

export interface RequestMonitorWindowStateStore {
  load(): RequestMonitorWindowState
  save(state: RequestMonitorWindowState): void
}

export const defaultRequestMonitorWindowState = (): RequestMonitorWindowState => ({
  isOpen: false,
  width: 220,
  height: 190,
  alwaysOnTop: true,
  opacity: 1,
})

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

export function normalizeRequestMonitorWindowState(value: unknown): RequestMonitorWindowState {
  const fallback = defaultRequestMonitorWindowState()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback
  const candidate = value as Record<string, unknown>
  const hasPosition = typeof candidate.x === 'number'
    && Number.isFinite(candidate.x)
    && typeof candidate.y === 'number'
    && Number.isFinite(candidate.y)
  return {
    isOpen: candidate.isOpen === true,
    ...(hasPosition ? {
      x: Math.round(candidate.x as number),
      y: Math.round(candidate.y as number),
    } : {}),
    width: boundedInteger(candidate.width, fallback.width, 180, 1_200),
    height: boundedInteger(candidate.height, fallback.height, 90, 1_000),
    alwaysOnTop: candidate.alwaysOnTop !== false,
    opacity: Math.min(1, Math.max(0.6, typeof candidate.opacity === 'number' && Number.isFinite(candidate.opacity)
      ? candidate.opacity
      : fallback.opacity)),
  }
}

export function constrainRequestMonitorBounds(
  state: RequestMonitorWindowState,
  workAreas: RequestMonitorWindowBounds[],
): RequestMonitorWindowBounds {
  const firstArea = workAreas[0]
  if (state.x === undefined || state.y === undefined || !firstArea) {
    return { width: state.width, height: state.height }
  }
  const centerX = state.x + state.width / 2
  const centerY = state.y + state.height / 2
  const target = workAreas.find((area) => area.x !== undefined && area.y !== undefined
    && centerX >= area.x && centerX < area.x + area.width
    && centerY >= area.y && centerY < area.y + area.height)
    ?? workAreas.reduce((closest, area) => {
      if (area.x === undefined || area.y === undefined) return closest
      const distance = Math.hypot(
        centerX - (area.x + area.width / 2),
        centerY - (area.y + area.height / 2),
      )
      return distance < closest.distance ? { area, distance } : closest
    }, { area: firstArea, distance: Number.POSITIVE_INFINITY }).area
  const areaX = target.x ?? 0
  const areaY = target.y ?? 0
  const width = Math.min(state.width, target.width)
  const height = Math.min(state.height, target.height)
  return {
    x: Math.min(areaX + target.width - width, Math.max(areaX, state.x)),
    y: Math.min(areaY + target.height - height, Math.max(areaY, state.y)),
    width,
    height,
  }
}

export class FileRequestMonitorWindowStateStore implements RequestMonitorWindowStateStore {
  constructor(private readonly statePath: string) {}

  load(): RequestMonitorWindowState {
    try {
      return normalizeRequestMonitorWindowState(JSON.parse(readFileSync(this.statePath, 'utf8')))
    } catch {
      return defaultRequestMonitorWindowState()
    }
  }

  save(state: RequestMonitorWindowState): void {
    const normalized = normalizeRequestMonitorWindowState(state)
    mkdirSync(dirname(this.statePath), { recursive: true })
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    renameSync(temporaryPath, this.statePath)
  }
}
