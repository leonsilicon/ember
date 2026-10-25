import { expect, test } from 'bun:test';

import { ago, progress, uploadExpired } from '../src/app/(splat)/live/capture-progress';
import { newJob, UPLOAD_WINDOW_MS } from '../src/jobs';

const now = Date.parse('2026-10-25T05:00:00Z');
const startedAgo = (ms: number) => ({ ...newJob('cap-1'), createdAt: new Date(now - ms).toISOString() });

test('an upload is called out once the phone can no longer finish it', () => {
  expect(progress(startedAgo(20_000), now)).toBe('uploading from the phone · started just now');
  expect(progress(startedAgo(4 * 60_000), now)).toBe('uploading from the phone · started 4 min ago');
  expect(uploadExpired(startedAgo(UPLOAD_WINDOW_MS - 1), now)).toBe(false);
  expect(uploadExpired(startedAgo(UPLOAD_WINDOW_MS + 1), now)).toBe(true);
  expect(progress(startedAgo(UPLOAD_WINDOW_MS + 60_000), now)).toBe('upload never finished · started 2 h ago');
  // Only an upload expires; a queued capture waits for the Mac however long that takes.
  expect(uploadExpired({ ...startedAgo(UPLOAD_WINDOW_MS * 2), state: 'queued' }, now)).toBe(false);
});

test('the other states, as far as they have got', () => {
  const job = { ...newJob('cap-1'), steps: 5000, step: 1500 };
  const steps = `${(1500).toLocaleString()} / ${(5000).toLocaleString()} steps`;
  expect(progress({ ...job, state: 'queued' })).toBe('uploaded · waiting for the Mac');
  expect(progress({ ...job, state: 'training' })).toBe(`training ${steps}`);
  expect(progress({ ...job, state: 'paused' })).toBe(`paused at ${steps}`);
  expect(progress({ ...job, state: 'failed' })).toBe('failed');
  expect(progress({ ...job, state: 'cancelled' })).toBe('cancelled');
});

test('how long ago', () => {
  expect(ago(0)).toBe('just now');
  expect(ago(90_000)).toBe('2 min ago');
  expect(ago(3 * 3_600_000)).toBe('3 h ago');
  expect(ago(49 * 3_600_000)).toBe('2 d ago');
});
