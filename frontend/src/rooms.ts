/**
 * Usernames are the rooms everything is sorted into. A person signs in to the web with one (and the
 * team's password; see web/auth.ts), and sets the same one in the app: the phone's live map, its Live
 * 3D recordings and its captures then go to that room, and the web pages signed in as that username
 * show that phone's and no other's, so several people can use https://soon2026.vercel.app at once.
 * A browser that came in with the access token names no room and sees every room (or the one its
 * URL's `?room=` asks for). The app checks usernames by the same rule (mobile/src/lib/username.ts).
 */

/** 1–32 of a–z, 0–9, dot, dash and underscore, starting with a letter or digit; always lower-case. */
export const USERNAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export const USERNAME_RULE = 'letters, digits, dots, dashes and underscores (up to 32)';

/** The username as typed (any case, spaces around), or null when it isn't one. */
export function normalizeUsername(typed: string | null | undefined): string | null {
  const name = (typed ?? '').trim().toLowerCase();
  return USERNAME.test(name) ? name : null;
}

/** Whether something in `room` (a session, a capture) shows to a viewer of `viewerRoom` (null: every room). */
export function inRoom(viewerRoom: string | null, room: string | null | undefined) {
  return viewerRoom == null || (room ?? null) === viewerRoom;
}
