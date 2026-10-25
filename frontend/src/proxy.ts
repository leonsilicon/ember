import { NextResponse, type NextRequest } from 'next/server';

import { TOKEN_COOKIE } from './web/auth';

/**
 * Signs a browser in with the access token: a page opened with `?token=` (a sign-in link, or the
 * app's live view) keeps the token in a cookie and loads again without it in the URL. The pages and
 * routes check it (web/auth.ts); the email-and-password sign-in is the landing page's form instead.
 */
export function proxy(request: NextRequest) {
  const url = request.nextUrl.clone();
  const token = url.searchParams.get('token') ?? '';
  url.searchParams.delete('token');
  const response = NextResponse.redirect(url);
  response.cookies.set(TOKEN_COOKIE, token, {
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax',
    path: '/',
    maxAge: 365 * 24 * 60 * 60,
  });
  return response;
}

export const config = {
  // Pages only: API clients send the token as a header, and a WebSocket can't follow a redirect.
  matcher: [{ source: '/((?!_next/|api/|live/socket|live/ingest|live/map|health).*)', has: [{ type: 'query', key: 'token' }] }],
};
