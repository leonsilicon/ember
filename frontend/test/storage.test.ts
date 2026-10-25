import { expect, test } from 'bun:test';

import { transient, withRetries } from '../src/agent/storage';

/** What Bun's fetch throws when the Mac's network flips interfaces mid-call. */
const reset = () => Object.assign(new TypeError('ECONNRESET: The socket connection was closed unexpectedly.'), { code: 'ECONNRESET' });

test('a call the network dropped is tried again', async () => {
  let calls = 0;
  const result = await withRetries('test', async () => (++calls < 3 ? Promise.reject(reset()) : 'ok'), { firstWaitMs: 1 });
  expect(result).toBe('ok');
  expect(calls).toBe(3);
});

test('an error that will not go away is not tried again', async () => {
  let calls = 0;
  const call = withRetries('test', async () => { calls++; throw new Error('captures/x/capture.zip is not in the Blob store'); }, { firstWaitMs: 1 });
  await expect(call).rejects.toThrow('not in the Blob store');
  expect(calls).toBe(1);
});

test('gives up after the last try', async () => {
  let calls = 0;
  const call = withRetries('test', async () => { calls++; throw reset(); }, { tries: 3, firstWaitMs: 1 });
  await expect(call).rejects.toThrow('ECONNRESET');
  expect(calls).toBe(3);
});

test('tells a network error from a wrong path or token', () => {
  expect(transient(reset())).toBe(true);
  expect(transient(new TypeError('fetch failed'))).toBe(true);
  expect(transient(Object.assign(new Error('connect'), { code: 'ETIMEDOUT' }))).toBe(true);
  expect(transient(new Error('x is not in the Blob store'))).toBe(false);
  expect(transient(new Error('Access denied, please provide a valid token for this resource.'))).toBe(false);
  expect(transient('nope')).toBe(false);
});
