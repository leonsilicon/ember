import { Alert, Platform } from 'react-native';

import { dismissUsernameQuestion, normalizeUsername, setUsername, USERNAME_RULE } from '@/lib/username';

const WHAT_FOR =
  "Ember's web pages show the phone set to the username they're signed in with: its live map on Control, its Live 3D recordings and its captures.";

/**
 * The native dialog that sets the username (see lib/username.ts): on the first launch (`first`:
 * "Not now" puts it off for good, and the ⋯ camera options still set it), and from the ⋯ options
 * and All Captures afterwards. Saving an empty name clears it. iOS only (the only phone that sends
 * anything; Alert.prompt doesn't exist on Android).
 */
export function askUsername(current: string, first = false) {
  if (Platform.OS !== 'ios') return;
  ask(current, first, first ? `${WHAT_FOR} Pick yours; it's the one you sign in with there.` : WHAT_FOR);
}

function ask(current: string, first: boolean, message: string) {
  Alert.prompt(
    first ? 'Your username' : 'Username',
    message,
    [
      { text: first ? 'Not now' : 'Cancel', style: 'cancel', onPress: () => first && dismissUsernameQuestion() },
      {
        text: 'Save',
        onPress: (typed?: string) => {
          const text = (typed ?? '').trim();
          if (!text) return setUsername(null);
          if (normalizeUsername(text)) return setUsername(text);
          ask(text, first, `"${text}" isn't a username: ${USERNAME_RULE}.`);
        },
      },
    ],
    'plain-text',
    current,
    'default',
  );
}
