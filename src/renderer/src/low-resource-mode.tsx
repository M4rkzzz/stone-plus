import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export const LOW_RESOURCE_MODE_STORAGE_KEY = 'stone.low-resource-mode.v1'

interface LowResourceModeValue {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

const LowResourceModeContext = createContext<LowResourceModeValue>({
  enabled: false,
  setEnabled: () => undefined,
})

function readLowResourceMode(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(LOW_RESOURCE_MODE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function applyStoredLowResourceModeEarly(): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('low-resource-mode', readLowResourceMode())
}

export function LowResourceModeProvider({ children }: { children: ReactNode }) {
  const [enabled, setStoredEnabled] = useState(readLowResourceMode)

  useEffect(() => {
    document.documentElement.classList.toggle('low-resource-mode', enabled)
  }, [enabled])

  const setEnabled = useCallback((next: boolean) => {
    setStoredEnabled(next)
    try {
      window.localStorage.setItem(LOW_RESOURCE_MODE_STORAGE_KEY, String(next))
    } catch {
      // Keep the in-memory preference when renderer storage is unavailable.
    }
  }, [])
  const value = useMemo(() => ({ enabled, setEnabled }), [enabled, setEnabled])
  return <LowResourceModeContext.Provider value={value}>{children}</LowResourceModeContext.Provider>
}

export function useLowResourceMode(): LowResourceModeValue {
  return useContext(LowResourceModeContext)
}

