import { useEffect, useRef, useState } from 'react'

/**
 * Samples `read()` every `intervalMs` and re-renders only when the
 * result changes (compared with `equal`). Lets a panel show per-frame
 * engine data at a calm 2 Hz without the parent re-rendering every
 * frame. Changing `resetKey` (e.g. the selected object id) samples
 * again immediately and never shows the previous key's value.
 */
export function usePolled<T>(
  read: (() => T) | undefined,
  intervalMs: number,
  resetKey: string | number | null = null,
  equal: (a: T, b: T) => boolean = Object.is,
): T | undefined {
  const [sample, setSample] = useState<{ key: string | number | null; value: T } | null>(null)
  const readRef = useRef(read)
  const equalRef = useRef(equal)

  useEffect(() => {
    readRef.current = read
    equalRef.current = equal
  })

  const enabled = read !== undefined

  useEffect(() => {
    if (!enabled) return
    const take = () => {
      const fn = readRef.current
      if (!fn) return
      const value = fn()
      setSample((prev) =>
        prev && prev.key === resetKey && equalRef.current(prev.value, value) ? prev : { key: resetKey, value },
      )
    }
    const first = window.setTimeout(take, 0)
    const id = window.setInterval(take, intervalMs)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(id)
    }
  }, [enabled, intervalMs, resetKey])

  return enabled && sample && sample.key === resetKey ? sample.value : undefined
}

/** Wall-clock milliseconds, refreshed every `intervalMs`. */
export function useWallClock(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}
