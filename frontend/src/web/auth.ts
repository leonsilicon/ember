import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Two ways in, both kept in cookies:
 *
 * - The access token (SPLAT_TOKEN, also built into the app). The app sends it as a bearer token,
 *   and a browser keeps it in a cookie, set by opening any page with `?token=` (see proxy.ts),
 *   which is how the app's live view and a sign-in link sign a browser in.
 * - The demo account (DEMO_EMAIL or one of DEMO_USERNAMES, with DEMO_PASSWORD; there's no
 *   sign-up): the landing page's form sets a session cookie (see app/(splat)/actions.ts).
 *
 * Pages and API routes take either; the API also takes the bearer token.
 */
export const TOKEN_COOKIE = 'splat_token';
export const SESSION_COOKIE = 'splat_session';

const digest = (value: string) => createHash('sha256').update(value).digest();
// Hashing first gives timingSafeEqual equal-length inputs.
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
const normal = (login: string) => login.trim().toLowerCase();

export function validToken(candidate: string | null | undefined) {
  const expected = process.env.SPLAT_TOKEN;
  if (!expected) throw new Error('SPLAT_TOKEN is not set');
  return Boolean(candidate) && same(candidate!, expected);
}

/** The demo account's logins, lower-case: DEMO_EMAIL and the comma-separated DEMO_USERNAMES. */
export function demoLogins() {
  const { DEMO_EMAIL = '', DEMO_USERNAMES = '' } = process.env;
  return [DEMO_EMAIL, ...DEMO_USERNAMES.split(/[,\s]+/)].map(normal).filter(Boolean);
}

/** Whether the demo account exists on this server. */
export function loginConfigured() {
  return demoLogins().length > 0 && Boolean(process.env.DEMO_PASSWORD);
}

/** The demo login that `login` names (in any case) when `password` is right, else null. */
export function checkCredentials(login: string, password: string): string | null {
  const { DEMO_PASSWORD } = process.env;
  if (!DEMO_PASSWORD) return null;
  const wanted = normal(login);
  // Every login and the password are always compared, so a wrong login takes as long as a wrong password.
  let found: string | null = null;
  for (const known of demoLogins()) if (same(wanted, known)) found = known;
  const passwordOk = same(password, DEMO_PASSWORD);
  return passwordOk ? found : null;
}

/**
 * What a browser holds after signing in: the login and an HMAC over it, keyed by the server's
 * secrets. Nothing is stored, and changing the password signs everyone out.
 */
export function sessionToken(login: string) {
  const { DEMO_PASSWORD, SPLAT_TOKEN } = process.env;
  if (!DEMO_PASSWORD || !SPLAT_TOKEN) throw new Error('DEMO_PASSWORD and SPLAT_TOKEN must be set');
  const who = normal(login);
  const mac = createHmac('sha256', `${SPLAT_TOKEN}\n${DEMO_PASSWORD}`).update(`session:${who}`).digest('hex');
  return `${who}.${mac}`;
}

/** The login a session cookie was issued for, or null when it's missing, forged or for a login that's gone. */
export function validSession(candidate: string | null | undefined): string | null {
  if (!candidate || !loginConfigured() || !process.env.SPLAT_TOKEN) return null;
  // The HMAC is hex, so the last dot ends the login (an email has dots of its own).
  const who = candidate.slice(0, candidate.lastIndexOf('.'));
  if (!who || !demoLogins().includes(who)) return null;
  return same(candidate, sessionToken(who)) ? who : null;
}

function cookie(request: Request, name: string) {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

/** For API routes and sockets: a bearer token, or either cookie. */
export function authorized(request: Request) {
  const bearer = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (validToken(bearer ?? cookie(request, TOKEN_COOKIE) ?? new URL(request.url).searchParams.get('token'))) return true;
  return validSession(cookie(request, SESSION_COOKIE)) !== null;
}

/** For pages: whether this browser has signed in, either way. */
export async function signedIn() {
  const store = await cookies();
  return validToken(store.get(TOKEN_COOKIE)?.value) || validSession(store.get(SESSION_COOKIE)?.value) !== null;
}

/** The demo login this browser signed in with; null when it came in with the access token, or isn't signed in. */
export async function currentLogin() {
  return validSession((await cookies()).get(SESSION_COOKIE)?.value);
}

/** Where to go after signing in: a path on this site (never another origin), or the dashboard. */
export function safeNext(value: unknown) {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : '/dashboard';
}

/** For gated pages: a browser that hasn't signed in goes to the landing page, and back to `path` after. */
export async function requireSignIn(path: string) {
  if (!(await signedIn())) redirect(`/?next=${encodeURIComponent(path)}`);
}
