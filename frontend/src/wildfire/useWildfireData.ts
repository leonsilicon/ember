import { useEffect, useState } from 'react'
import type { Categories, Coverage } from './types'

export const DATA_BASE = `${import.meta.env.BASE_URL}wildfire/`

export function useWildfireData() {
  const [data, setData] = useState<{ coverage: Coverage; categories: Categories } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    Promise.all([
      fetch(`${DATA_BASE}coverage.json`, { signal: ctrl.signal }).then((r) => {
        if (!r.ok) throw new Error(`coverage.json ${r.status}`)
        return r.json() as Promise<Coverage>
      }),
      fetch(`${DATA_BASE}categories.json`, { signal: ctrl.signal }).then((r) => {
        if (!r.ok) throw new Error(`categories.json ${r.status}`)
        return r.json() as Promise<Categories>
      }),
    ])
      .then(([coverage, categories]) => setData({ coverage, categories }))
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message)
      })
    return () => ctrl.abort()
  }, [])

  return { data, error }
}
