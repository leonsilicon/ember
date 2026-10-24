import { useEffect, useState } from 'react'
import type { DiscoveredPhone } from '../../phone-discovery'

const POLL_MS = 2500

/**
 * Phones the dev server has found advertising the rover app's camera on the Wi-Fi (phone-discovery.ts),
 * refreshed every few seconds. Empty where there's no such server (a static build): then the camera
 * panel's typed address is the way in.
 */
export function usePhoneDiscovery(): DiscoveredPhone[] {
  const [phones, setPhones] = useState<DiscoveredPhone[]>([])

  useEffect(() => {
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const response = await fetch('/api/phone-camera', { cache: 'no-store' })
        // No discovery here (a static deploy answers with the page or a 404): stop asking.
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return
        const { phones: found } = (await response.json()) as { phones: DiscoveredPhone[] }
        if (!stopped) setPhones((previous) => (JSON.stringify(previous) === JSON.stringify(found) ? previous : found))
      } catch {
        // The dev server restarting: try again next time.
      }
      if (!stopped) timer = window.setTimeout(poll, POLL_MS)
    }
    void poll()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [])

  return phones
}
