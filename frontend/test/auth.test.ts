import { expect, test } from 'bun:test';

import { authorized, checkCredentials, demoLogins, safeNext, SESSION_COOKIE, sessionToken, validSession } from '../src/web/auth';

// From test/setup.ts.
const EMAIL = process.env.DEMO_EMAIL!;
const PASSWORD = process.env.DEMO_PASSWORD!;

test('the demo account answers to its email and usernames, in any case, with the one password', () => {
  expect(demoLogins()).toEqual([EMAIL, 'alice', 'bob']);
  expect(checkCredentials(EMAIL, PASSWORD)).toBe(EMAIL);
  expect(checkCredentials(`  ${EMAIL.toUpperCase()} `, PASSWORD)).toBe(EMAIL);
  expect(checkCredentials('ALICE', PASSWORD)).toBe('alice');
  expect(checkCredentials(' Bob ', PASSWORD)).toBe('bob');
  expect(checkCredentials('carol', PASSWORD)).toBeNull();
  expect(checkCredentials(EMAIL, 'wrong')).toBeNull();
  expect(checkCredentials('alice', PASSWORD.toUpperCase())).toBeNull();
  expect(checkCredentials('', '')).toBeNull();
});

test('a session names its login and carries the server’s HMAC, nothing else', () => {
  const token = sessionToken('Alice');
  expect(token).toMatch(/^alice\.[0-9a-f]{64}$/);
  expect(validSession(token)).toBe('alice');
  expect(validSession(sessionToken(EMAIL))).toBe(EMAIL);
  // Another login with Alice's HMAC, a tampered HMAC, or nothing at all.
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
  // So does removing the username.
  const names = process.env.DEMO_USERNAMES;
  process.env.DEMO_USERNAMES = 'bob';
  try {
    expect(validSession(token)).toBeNull();
  } finally {
    process.env.DEMO_USERNAMES = names;
  }
});

test('API routes take the session cookie as well as the token', () => {
  const withCookie = (cookie: string) => new Request('http://localhost/api/captures', { headers: { Cookie: cookie } });
  // Browsers send the cookie as the server set it: URL-encoded (the email's @).
  expect(authorized(withCookie(`${SESSION_COOKIE}=${encodeURIComponent(sessionToken(EMAIL))}`))).toBe(true);
  expect(authorized(withCookie(`other=1; ${SESSION_COOKIE}=${sessionToken('bob')}`))).toBe(true);
  expect(authorized(withCookie(`${SESSION_COOKIE}=bob.deadbeef`))).toBe(false);
  expect(authorized(new Request('http://localhost/api/captures'))).toBe(false);
});

test('after signing in, only a path on this site is followed', () => {
  expect(safeNext('/control')).toBe('/control');
  expect(safeNext('/view/cap-1?step=3')).toBe('/view/cap-1?step=3');
  expect(safeNext('//evil.example')).toBe('/dashboard');
  expect(safeNext('/\\evil.example')).toBe('/dashboard');
  expect(safeNext('https://evil.example')).toBe('/dashboard');
  expect(safeNext(undefined)).toBe('/dashboard');
  expect(safeNext(['/a', '/b'])).toBe('/dashboard');
});
