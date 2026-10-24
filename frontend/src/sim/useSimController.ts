import { useEffect, useState, useSyncExternalStore } from 'react'
import { SimController } from './controller'

/** One SimController per mount; its loop runs while mounted (StrictMode-safe: the controller survives). */
export function useSimController() {
  const [controller] = useState(() => new SimController())
  useEffect(() => {
    controller.startLoop()
    return () => controller.stopLoop()
  }, [controller])
  return controller
}

/** Re-renders whenever the controller reports a change (at most once per animation frame). */
export function useSimVersion(controller: SimController) {
  return useSyncExternalStore(controller.subscribe, controller.getVersion)
}
