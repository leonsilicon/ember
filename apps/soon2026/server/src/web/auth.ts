import { createHash, timingSafeEqual } from 'node:crypto';

import { cookies } from 'next/headers';

/**
 * One access token (SPLAT_TOKEN, also built into the app) guards everything: the app sends it as a
 * bearer token, and browsers keep it in a cookie, set by opening any page with `?token=` (see
 * proxy.ts), which is also how the app's live view signs in.
 */
export const TOKEN_COOKIE = 'splat_token';

const digest = (value: string) => createHash('sha256').update(value).digest();

export function validToken(candidate: string | null | undefined) {
  const expected = process.env.SPLAT_TOKEN;
  if (!expected) throw new Error('SPLAT_TOKEN is not set');
  // Hashing first gives timingSafeEqual equal-length inputs.
  return Boolean(candidate) && timingSafeEqual(digest(candidate!), digest(expected));
}

function cookie(request: Request, name: string) {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

export function authorized(request: Request) {
  const bearer = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  return validToken(bearer ?? cookie(request, TOKEN_COOKIE) ?? new URL(request.url).searchParams.get('token'));
}

/** For pages: whether this browser has signed in. */
export async function signedIn() {
  return validToken((await cookies()).get(TOKEN_COOKIE)?.value);
}
