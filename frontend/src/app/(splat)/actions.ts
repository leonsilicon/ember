'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { checkCredentials, loginConfigured, safeNext, SESSION_COOKIE, sessionToken, TOKEN_COOKIE } from '#web/auth.ts';

/** After a failed attempt: what went wrong, and the login as typed so it stays in the form. */
export type LoginState = { error: string; login: string } | undefined;

const SESSION_DAYS = 30;

/** The landing page's form: the demo account (email or username) signs the browser in with a session cookie. */
export async function login(_previous: LoginState, form: FormData): Promise<LoginState> {
  const typed = String(form.get('login') ?? '');
  const password = String(form.get('password') ?? '');
  if (!loginConfigured()) {
    return { error: 'Sign-in is not set up on this server: DEMO_EMAIL / DEMO_USERNAMES and DEMO_PASSWORD are missing.', login: typed };
  }
  const who = checkCredentials(typed, password);
  if (!who) return { error: 'Wrong email, username or password.', login: typed };
  // Vercel says https here; the dev server on the laptop is plain http, where a Secure cookie wouldn't stick.
  const secure = (await headers()).get('x-forwarded-proto') === 'https';
  (await cookies()).set(SESSION_COOKIE, sessionToken(who), {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
  redirect(safeNext(form.get('next')));
}

/** Signs the browser out, whichever way it signed in. */
export async function logout() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  store.delete(TOKEN_COOKIE);
  redirect('/');
}
