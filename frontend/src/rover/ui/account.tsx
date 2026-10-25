'use client'

import { createContext, useContext, type ReactNode } from 'react'

/** Who's signed in, for the top bar: the demo login, or null when the browser came in with the access token. */
const Ctx = createContext<string | null>(null)

/** Set once by the laptop pages' root layout, which reads the session cookie. */
export function AccountProvider({ who, children }: { who: string | null; children: ReactNode }) {
  return <Ctx.Provider value={who}>{children}</Ctx.Provider>
}

export function useAccount() {
  return useContext(Ctx)
}
