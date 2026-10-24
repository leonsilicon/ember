import { describe, expect, test } from 'bun:test'
import { phoneCameraOrigin } from '../src/rover/phoneCamera'

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
