import { afterAll, describe, expect, test } from 'bun:test'
import { Bonjour } from 'bonjour-service'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PhoneDiscovery, SERVICE_TYPE } from '../src/phone-discovery'

/** A fake phone: answers /status like the rover app's camera server. */
function fakePhone(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ device: 'Test iPhone', viewers: 0, frames: 0, width: 0, height: 0 }))
    }).listen(0, () => resolve({ server, port: (server.address() as AddressInfo).port }))
  })
}

const until = async <T>(fn: () => Promise<T | undefined>, ms: number): Promise<T | undefined> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await fn()
    if (value !== undefined) return value
    await new Promise((r) => setTimeout(r, 300))
  }
  return undefined
}

describe('PhoneDiscovery', () => {
  const advertiser = new Bonjour()
  const discovery = new PhoneDiscovery()
  let phone: Server

  afterAll(() => {
    discovery.stop()
    advertiser.unpublishAll()
    advertiser.destroy()
    phone?.close()
  })

  test('finds a phone advertising the camera, and leaves out one that does not answer', async () => {
    const live = await fakePhone()
    phone = live.server
    const name = `Rover camera (test ${process.pid})`
    advertiser.publish({ name, type: SERVICE_TYPE, port: live.port, txt: { device: 'Test iPhone', path: '/camera.mjpg' } })
    // Advertised, but nothing listens on its port.
    advertiser.publish({ name: `${name} gone`, type: SERVICE_TYPE, port: 1, txt: { device: 'Gone iPhone' } })

    const found = await until(async () => (await discovery.list()).find((p) => p.name === name), 8000)
    expect(found).toBeDefined()
    expect(found!.device).toBe('Test iPhone')
    expect(found!.origin).toMatch(new RegExp(`^http://.+:${live.port}$`))
    const all = await discovery.list()
    expect(all.some((p) => p.device === 'Gone iPhone')).toBe(false)
  }, 15_000)
})
