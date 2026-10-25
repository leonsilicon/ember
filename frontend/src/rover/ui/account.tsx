'use client'

import { createContext, useContext, type ReactNode } from 'react'

/**
 * Who's signed in: the username, which is also the room the pages show (the phone set to the same
 * name; see rooms.ts), or null when the browser came in with the access token and sees every room.
 */
const Ctx = createContext<string | null>(null)

/** Set once by the laptop pages' root layout, which reads the session cookie. */
export function AccountProvider({ who, children }: { who: string | null; children: ReactNode }) {
  return <Ctx.Provider value={who}>{children}</Ctx.Provider>
}

export function useAccount() {
  return useContext(Ctx)
}
