/** Helpers the API's route handlers share. */

export const CAPTURE_ID = /^[A-Za-z0-9_-]{1,80}$/;

// Any origin may use the API with the token, so a teammate's own web app can list and load splats.
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Capture-Id, X-Room',
};

export function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

export const unauthorized = () => json({ error: 'missing or wrong access token' }, 401);

/** The CORS preflight, exported as `OPTIONS` by every API route. */
export function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}
