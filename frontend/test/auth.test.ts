import { expect, test } from 'bun:test';

import { inRoom, normalizeUsername } from '../src/rooms';
import { authorized, checkCredentials, roomOf, safeNext, SESSION_COOKIE, sessionToken, validSession } from '../src/web/auth';

// From test/setup.ts.
const PASSWORD = process.env.DEMO_PASSWORD!;

test('a username is letters, digits, dots, dashes and underscores, lower-cased', () => {
  expect(normalizeUsername('leonsilicon')).toBe('leonsilicon');
  expect(normalizeUsername('  Leon.Silicon-2_ ')).toBe('leon.silicon-2_');
  expect(normalizeUsername('a')).toBe('a');
  for (const bad of ['', ' ', 'leon silicon', 'leon@example.com', '.leon', '-leon', 'x'.repeat(33), null, undefined]) {
    expect(normalizeUsername(bad)).toBeNull();
  }
});

test('any username signs in with the one password', () => {
  expect(checkCredentials('leonsilicon', PASSWORD)).toBe('leonsilicon');
  expect(checkCredentials(' ALICE ', PASSWORD)).toBe('alice');
  expect(checkCredentials('leon@example.com', PASSWORD)).toBeNull();
  expect(checkCredentials('alice', 'wrong')).toBeNull();
  expect(checkCredentials('alice', PASSWORD.toUpperCase())).toBeNull();
  expect(checkCredentials('', '')).toBeNull();
});

test('a session names its username and carries the server’s HMAC, nothing else', () => {
  const token = sessionToken('Alice');
  expect(token).toMatch(/^alice\.[0-9a-f]{64}$/);
  expect(validSession(token)).toBe('alice');
  expect(validSession(sessionToken('leon.silicon'))).toBe('leon.silicon');
  // Another username with Alice's HMAC, a tampered HMAC, or nothing at all.
  expect(validSession(`bob.${token.slice('alice.'.length)}`)).toBeNull();
  expect(validSession(token.slice(0, -1) + '0')).toBeNull();
  expect(validSession('alice')).toBeNull();
  expect(validSession('')).toBeNull();
  expect(validSession(null)).toBeNull();
  // Changing the password signs everyone out.
  const before = process.env.DEMO_PASSWORD;
  process.env.DEMO_PASSWORD = 'another';
  try {
    expect(validSession(token)).toBeNull();
  } finally {
    process.env.DEMO_PASSWORD = before;
  }
});

test('API routes take the session cookie as well as the token', () => {
  const withCookie = (cookie: string) => new Request('http://localhost/api/captures', { headers: { Cookie: cookie } });
  // Browsers send the cookie as the server set it: URL-encoded.
  expect(authorized(withCookie(`${SESSION_COOKIE}=${encodeURIComponent(sessionToken('leon.silicon'))}`))).toBe(true);
  expect(authorized(withCookie(`other=1; ${SESSION_COOKIE}=${sessionToken('bob')}`))).toBe(true);
  expect(authorized(withCookie(`${SESSION_COOKIE}=bob.deadbeef`))).toBe(false);
  expect(authorized(new Request('http://localhost/api/captures'))).toBe(false);
});

test('a request’s room is the URL’s, else the username signed in as, else every room', () => {
  const cookie = `${SESSION_COOKIE}=${sessionToken('alice')}`;
  expect(roomOf(new Request('http://localhost/live/socket', { headers: { Cookie: cookie } }))).toBe('alice');
  expect(roomOf(new Request('http://localhost/live/socket?room=Bob', { headers: { Cookie: cookie } }))).toBe('bob');
  expect(roomOf(new Request('http://localhost/live/socket?room=not%20one', { headers: { Cookie: cookie } }))).toBeNull();
  expect(roomOf(new Request('http://localhost/live/socket', { headers: { Authorization: 'Bearer test-token' } }))).toBeNull();
  // A viewer of every room sees everything; one in a room sees only that room, and not what has none.
  expect(inRoom(null, 'alice')).toBe(true);
  expect(inRoom(null, null)).toBe(true);
  expect(inRoom('alice', 'alice')).toBe(true);
  expect(inRoom('alice', 'bob')).toBe(false);
  expect(inRoom('alice', null)).toBe(false);
  expect(inRoom('alice', undefined)).toBe(false);
});

test('after signing in, only a path on this site is followed', () => {
  expect(safeNext('/control')).toBe('/control');
  expect(safeNext('/view/cap-1?step=3')).toBe('/view/cap-1?step=3');
  expect(safeNext('//evil.example')).toBe('/control');
  expect(safeNext('/\\evil.example')).toBe('/control');
  expect(safeNext('https://evil.example')).toBe('/control');
  expect(safeNext(undefined)).toBe('/control');
  expect(safeNext(['/a', '/b'])).toBe('/control');
});
