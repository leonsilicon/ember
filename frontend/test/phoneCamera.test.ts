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
  const mine = { origin: 'http://192.168.1.112:8787', device: 'iPhone18,1' }
  const theirs = { origin: 'http://192.168.1.129:8788', device: 'Mac stand-in' }

  test('the first time, links up with the only phone found', () => {
    expect(pickPhone([mine], null)).toBe(mine)
    expect(pickPhone([theirs, mine], null)).toBeNull()
  })

  test('after that, only with the one used last, never a stranger just because it is the only one', () => {
    expect(pickPhone([theirs, mine], 'http://192.168.1.112:8787')).toBe(mine)
    expect(pickPhone([theirs], 'http://192.168.1.112:8787')).toBeNull()
    expect(pickPhone([], 'http://192.168.1.112:8787')).toBeNull()
  })
})
