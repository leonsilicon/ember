import { describe, expect, test } from 'bun:test';

import { ManualState } from '#rover/manualControl.ts';
import { directionOf, dutiesFor, encodeFrame, LEASE_MS, parseStatus, parseToken, reportedDirection, SERVO_US, WHEEL_CODE } from '#rover/protocol.ts';

describe('V7 frames', () => {
  test('encodes every field, as the firmware requires', () => {
    const body = encodeFrame({ token: 12345678, seq: 3, wheel: 1, pan: -1, lift: 0, power: 20, speed: 10 });
    expect(Object.fromEntries(body)).toEqual({ token: '12345678', seq: '3', wheel: '1', pan: '-1', lift: '0', power: '20', speed: '10' });
  });

  test('rejects out-of-range values before they reach the rover', () => {
    expect(() => encodeFrame({ token: 1, seq: 1, wheel: 1, pan: 0, lift: 0, power: 101, speed: 10 })).toThrow();
    expect(() => encodeFrame({ token: 1, seq: 1, wheel: 1, pan: 0, lift: 0, power: 20.5, speed: 10 })).toThrow();
    expect(() => encodeFrame({ token: 1, seq: 0, wheel: 1, pan: 0, lift: 0, power: 20, speed: 10 })).toThrow();
  });

  test('parses the session token and the status report', () => {
    expect(parseToken({ token: 12345678 })).toBe(12345678);
    expect(parseToken({ token: 0 })).toBeNull();
    expect(parseToken('nope')).toBeNull();
    expect(parseStatus({ ready: true, sequence: 4, pan: 1500, lift: 1320, pwm: [51, 0, 0, 51] })).toEqual({
      ready: true,
      sequence: 4,
      pan: 1500,
      lift: 1320,
      pwm: [51, 0, 0, 51],
    });
    expect(parseStatus({ ready: true, pwm: [1, 2, 3] })).toBeNull();
  });

  test('reads the wheel direction back out of the PWM duties', () => {
    for (const direction of ['forward', 'back', 'left', 'right'] as const) {
      expect(reportedDirection(dutiesFor({ wheel: WHEEL_CODE[direction], power: 40 }))).toBe(direction);
      expect(directionOf(WHEEL_CODE[direction])).toBe(direction);
    }
    expect(reportedDirection([0, 0, 0, 0])).toBeNull();
    expect(directionOf(0)).toBeNull();
    // Forward: left forward (GPIO25) and right forward (GPIO33) carry the duty.
    expect(dutiesFor({ wheel: 1, power: 100 })).toEqual([255, 0, 0, 255]);

  });
});

describe('ManualState (the firmware logic, ManualControl.h)', () => {
  const frame = (s: ManualState, seq: number, now: number, w = 1, p = 0, l = 0, wp = 20, sp = 10) => s.accept(777, seq, w, p, l, wp, sp, now);

  test('a session starts stopped and accepts increasing seq only', () => {
    const s = new ManualState();
    s.session(777, 1000);
    expect(s.targets()).toEqual([0, 0]);
    expect(frame(s, 1, 1010)).toBe(true);
    expect(frame(s, 1, 1020)).toBe(false);
    expect(s.accept(1, 2, 1, 0, 0, 20, 10, 1020)).toBe(false);
    expect(frame(s, 2, 1030, 7)).toBe(false);
    expect(frame(s, 2, 1030, 1, 0, 0, 120)).toBe(false);
    expect(s.sequence).toBe(1);
  });

  test('wheel targets and duties follow the firmware signs', () => {
    const s = new ManualState();
    s.session(777, 0);
    frame(s, 1, 10, 1, 0, 0, 50);
    expect(s.targets()).toEqual([50, -50]);
    expect(s.duties()).toEqual([127, 0, 0, 127]);
    frame(s, 2, 20, 3, 0, 0, 50);
    expect(s.targets()).toEqual([-50, -50]);
    // The firmware's right-side negative pin is GPIO 33 (pins[3]), so pivot left lights GPIO 26 and 33.
    expect(s.duties()).toEqual([0, 127, 0, 127]);
  });

  test(`the lease stops everything ${LEASE_MS} ms after the last frame`, () => {
    const s = new ManualState();
    s.session(777, 0);
    frame(s, 1, 10, 1, 1, 0);
    s.tick(10 + LEASE_MS - 1);
    expect(s.wheel).toBe(1);
    s.tick(10 + LEASE_MS);
    expect(s.wheel).toBe(0);
    expect(s.pan).toBe(0);
    expect(s.linked).toBe(false);
    expect(s.targets()).toEqual([0, 0]);
  });

  test('servos jog at the servo speed, clamp to the bounds and jump at 100 %', () => {
    const s = new ManualState();
    s.session(777, 0);
    frame(s, 1, 0, 0, 1, -1, 20, 10);
    s.tick(50); // 10 % → 200 µs/s → 10 µs in 50 ms
    expect(s.position).toEqual([1510, 1490]);
    s.tick(60); // under 20 ms since the last tick: no step
    expect(s.position).toEqual([1510, 1490]);
    for (let t = 100; t <= 60_000; t += 50) {
      frame(s, t, t, 0, 1, -1, 20, 100);
      s.tick(t);
    }
    expect(s.position).toEqual([SERVO_US.max, SERVO_US.min]);
    expect(s.status().pan).toBe(SERVO_US.max);
    expect(s.status().lift).toBe(SERVO_US.min);
  });

  test('a new session invalidates the old token and clears held motion', () => {
    const s = new ManualState();
    s.session(777, 0);
    frame(s, 1, 10);
    s.session(888, 20);
    expect(s.wheel).toBe(0);
    expect(frame(s, 2, 30)).toBe(false);
    expect(s.accept(888, 1, 2, 0, 0, 20, 10, 30)).toBe(true);
  });
});
