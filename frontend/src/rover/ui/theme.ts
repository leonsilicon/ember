import { useCallback, useEffect, useState } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'

const KEY = 'ember.theme'
const ORDER: ThemeChoice[] = ['system', 'light', 'dark']

function read(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY)
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  } catch {
    return 'system'
  }
}

/** The light/dark choice: `system` follows the OS; the others pin it (data-theme on <html>, set before paint by the layout). */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(read)

  useEffect(() => {
    const root = document.documentElement
    if (choice === 'system') delete root.dataset.theme
    else root.dataset.theme = choice
    try {
      if (choice === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, choice)
    } catch {
      // Private mode: the choice lasts for this page only.
    }
  }, [choice])

  const cycle = useCallback(() => setChoice((c) => ORDER[(ORDER.indexOf(c) + 1) % ORDER.length]), [])
  return { choice, cycle }
}
