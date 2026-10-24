import { useEffect, useState } from 'react'
import { geocode, type GeocodeHit } from './geocode'

interface Props {
  bias: { lon: number; lat: number }
  onPick: (hit: GeocodeHit) => void
}

export function SearchBar({ bias, onPick }: Props) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<GeocodeHit[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'empty' | 'unavailable' | 'ok'>('idle')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  const term = q.trim()
  useEffect(() => {
    if (term.length < 3) return
    const c = new AbortController()
    const t = setTimeout(() => {
      geocode(term, bias, c.signal)
        .then((h) => {
          setHits(h)
          setStatus(h.length ? 'ok' : 'empty')
          setActive(-1)
        })
        .catch((e: unknown) => {
          if ((e as Error).name === 'AbortError') return
          setHits([])
          setStatus('unavailable')
        })
    }, 300)
    return () => {
      clearTimeout(t)
      c.abort()
    }
  }, [term, bias])

  const pick = (h: GeocodeHit) => {
    setQ(`${h.label}${h.detail ? ', ' + h.detail : ''}`)
    setOpen(false)
    onPick(h)
  }

  return (
    <div className="pointer-events-auto relative w-full max-w-md">
      <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white/95 px-3 py-2 shadow-lg shadow-slate-900/10 backdrop-blur">
        <svg className="h-4 w-4 shrink-0 text-slate-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 3.3 9.9l3.65 3.65a.75.75 0 1 0 1.06-1.06l-3.65-3.65A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z" clipRule="evenodd" />
        </svg>
        <input
          value={q}
          onChange={(e) => {
            const v = e.target.value
            setQ(v)
            setOpen(true)
            if (v.trim().length < 3) {
              setHits([])
              setStatus('idle')
            } else {
              setStatus('loading')
            }
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, hits.length - 1))
            else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0))
            else if (e.key === 'Enter' && active >= 0 && hits[active]) pick(hits[active])
            else if (e.key === 'Escape') setOpen(false)
          }}
          placeholder="Search an address or place…"
          aria-label="Search address"
          className="w-full bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
        />
        {status === 'loading' && <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />}
        {q && status !== 'loading' && (
          <button
            type="button"
            onClick={() => {
              setQ('')
              setHits([])
            }}
            aria-label="Clear search"
            className="text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        )}
      </div>
      {open && status !== 'idle' && status !== 'loading' && (
        <div className="absolute inset-x-0 top-full mt-2 max-h-[55vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10">
          {status === 'unavailable' && (
            <p className="px-4 py-3 text-sm text-slate-600">
              Address search is unavailable right now. You can still pan the map and click a building.
            </p>
          )}
          {status === 'empty' && <p className="px-4 py-3 text-sm text-slate-600">No places found for “{q.trim()}”.</p>}
          {status === 'ok' && (
            <ul role="listbox">
              {hits.map((h, i) => (
                <li key={h.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(h)}
                    className={`block w-full px-4 py-2.5 text-left hover:bg-slate-50 ${i === active ? 'bg-slate-50' : ''}`}
                  >
                    <span className="block text-sm font-medium text-slate-900">{h.label}</span>
                    <span className="block text-xs text-slate-500">{h.detail}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
