import { useEffect, useState } from 'react'
import App from './App.tsx'
import WildfireApp from './wildfire/WildfireApp.tsx'

export default function Root() {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return hash.startsWith('#/wildfire') ? <WildfireApp /> : <App />
}
