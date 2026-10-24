import { describe, expect, test } from 'bun:test'
import { phoneCameraOrigin, pickPhone } from '../src/rover/phoneCamera'

describe('phoneCameraOrigin', () => {
  test('fills in http and the rover app port', () => {
    expect(phoneCameraOrigin('192.168.1.23')).toBe('http://192.168.1.23:8787')
    expect(phoneCameraOrigin(' 192.168.1.23:9000 ')).toBe('http://192.168.1.23:9000')
    expect(phoneCameraOrigin('http://rover-iphone.local/camera.mjpg')).toBe('http://rover-iphone.local:8787')
  })

  test('rejects nothing and nonsense', () => {
    expect(phoneCameraOrigin('')).toBeNull()
    expect(phoneCameraOrigin('http://')).toBeNull()
  })
})

describe('pickPhone', () => {
  const mine = { origin: 'http://192.168.1.112:8787', device: 'iPhone18,1', id: 'my-phone' }
  const theirs = { origin: 'http://192.168.1.129:8788', device: 'Mac stand-in', id: 'mac-stand-in' }
  const none = { id: null, origin: null }

  test('the first time, links up with the only phone found', () => {
    expect(pickPhone([mine], none)).toBe(mine)
    expect(pickPhone([theirs, mine], none)).toBeNull()
  })

  test('after that, only with the one used last, never a stranger just because it is the only one', () => {
    const last = { id: 'my-phone', origin: 'http://192.168.1.112:8787' }
    expect(pickPhone([theirs, mine], last)).toBe(mine)
    expect(pickPhone([theirs], last)).toBeNull()
    expect(pickPhone([], last)).toBeNull()
  })

  test('recognises the phone by its id after the Wi-Fi gives it a new address', () => {
    const moved = { ...mine, origin: 'http://192.168.1.241:8787' }
    expect(pickPhone([theirs, moved], { id: 'my-phone', origin: 'http://192.168.1.112:8787' })).toBe(moved)
  })

  test('an older build without an id is recognised by its address', () => {
    const old = { origin: 'http://192.168.1.112:8787', device: 'iPhone18,1' }
    expect(pickPhone([theirs, old], { id: null, origin: 'http://192.168.1.112:8787' })).toBe(old)
  })
})
