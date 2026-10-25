import { File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

/**
 * The username: the app-wide setting that says whose this phone is. Everything the phone sends to
 * the splat server (frontend) goes to that username's room: the rover brain's live map (the control
 * page's top view), Live 3D recordings and captures. The web pages signed in as the same username
 * show this phone and no other, so the whole team can use the site at once (frontend/src/rooms.ts).
 * The first launch asks for it (see components/username-prompt.ts); the camera's ⋯ options and All
 * Captures change it. Kept in the app's documents, so it lasts across launches.
 */

/** The web's rule (frontend/src/rooms.ts): 1–32 of a–z, 0–9, dot, dash and underscore, starting with a letter or digit. */
export const USERNAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export const USERNAME_RULE = 'letters, digits, dots, dashes and underscores (up to 32)';

/** The username as typed (any case, spaces around), or null when it isn't one. */
export function normalizeUsername(typed: string | null | undefined): string | null {
  const name = (typed ?? '').trim().toLowerCase();
  return USERNAME.test(name) ? name : null;
}

export type Account = {
  /** The username, or '' while none is set. */
  username: string;
  /** Whether the first launch's question has been answered (or put off), so it's asked once. */
  asked: boolean;
};

const FILE_NAME = 'ember-account.json';

function file(): File | null {
  if (Platform.OS === 'web') return null;
  try {
    return new File(Paths.document, FILE_NAME);
  } catch {
    return null;
  }
}

function load(): Account {
  try {
    const saved = file();
    if (saved?.exists) {
      const parsed = JSON.parse(saved.textSync()) as Partial<Account>;
      return { username: normalizeUsername(parsed.username) ?? '', asked: parsed.asked === true };
    }
  } catch {
    // Unreadable: start over, and ask again.
  }
  return { username: '', asked: false };
}

let account: Account | null = null;
const listeners = new Set<() => void>();

export function getAccount(): Account {
  account ??= load();
  return account;
}

function save(next: Account) {
  account = next;
  listeners.forEach((listener) => listener());
  const target = file();
  if (!target) return;
  try {
    if (!target.exists) target.create();
    void Promise.resolve(target.write(JSON.stringify(next))).catch(() => {});
  } catch {
    // Not kept: it lasts for this launch.
  }
}

/** Sets the username (`null` or anything that isn't one clears it) and counts the question as answered. */
export function setUsername(typed: string | null) {
  save({ username: normalizeUsername(typed) ?? '', asked: true });
}

/** The first launch's question was put off: don't ask again (the ⋯ options still set it). */
export function dismissUsernameQuestion() {
  save({ ...getAccount(), asked: true });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAccount(): Account {
  return useSyncExternalStore(subscribe, getAccount, getAccount);
}
