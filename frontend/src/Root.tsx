import { useEffect, useState } from 'react'
import App from './App.tsx'
import SimApp from './SimApp.tsx'
import WildfireApp from './wildfire/WildfireApp.tsx'

export default function Root() {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  if (hash.startsWith('#/wildfire')) return <WildfireApp />
  if (hash.startsWith('#/sim')) return <SimApp />
  return <App />
}
