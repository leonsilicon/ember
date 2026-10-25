import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * The app's identity per variant, picked by EXPO_PUBLIC_APP_VARIANT as in Haniverse
 * (https://docs.expo.dev/build-reference/variants/). Each variant has its own bundle identifier and scheme so the
 * development build and a production build install side by side, and `vpx _ios` deep-links into the one it built.
 * The slugs differ too: the dev client registers `exp+<slug>`, which Expo CLI's QR code and `i` open, and a
 * production build sharing it could take those links. Everything else is in app.json.
 */
export const APP_VARIANTS = {
  development: {
    name: 'soon2026 (Dev)',
    slug: 'soon2026-dev',
    scheme: 'soon2026-dev',
    bundleIdentifier: 'com.leonsilicon.soon2026.development',
  },
  production: {
    name: 'soon2026',
    slug: 'soon2026',
    scheme: 'soon2026',
    // The App Store Connect app (6826604814) that the TestFlight workflow submits to.
    bundleIdentifier: 'dev.improve.soon2026',
  },
} as const;

/** The EAS project (expo.dev/accounts/improvelabs/projects/soon2026) that builds and submits production. */
const EAS_PROJECT_ID = 'c6f2efee-fa10-41b0-9b86-507da1d0166b';

export type AppVariant = keyof typeof APP_VARIANTS;

export function isAppVariant(value: string): value is AppVariant {
  return Object.hasOwn(APP_VARIANTS, value);
}

/** Unset means production, as Expo prescribes; `vpx _dev` and `vpx _ios` set it. */
function appVariant(): AppVariant {
  const value = process.env.EXPO_PUBLIC_APP_VARIANT;
  if (!value) return 'production';
  if (!isAppVariant(value)) {
    throw new Error(`EXPO_PUBLIC_APP_VARIANT must be one of ${Object.keys(APP_VARIANTS).join(', ')}, not "${value}"`);
  }
  return value;
}

/**
 * Local signing with another Apple team, e.g. a teammate's free personal team, which can't sign with
 * app.json's team or its bundle identifiers: set both before `expo prebuild` / `expo run:ios`. Unset (CI,
 * TestFlight, `vpx _ios` on the team's Macs), nothing changes.
 */
function signingOverride(): { appleTeamId?: string; bundleIdentifier?: string } {
  const appleTeamId = process.env.SOON2026_APPLE_TEAM_ID || undefined;
  const bundleIdentifier = process.env.SOON2026_BUNDLE_ID || undefined;
  return { ...(appleTeamId && { appleTeamId }), ...(bundleIdentifier && { bundleIdentifier }) };
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const { bundleIdentifier, ...identity } = APP_VARIANTS[appVariant()];
  return {
    ...config,
    ...identity,
    owner: 'improvelabs',
    ios: { ...config.ios, bundleIdentifier, ...signingOverride() },
    // Android, for a second phone in mount or remote mode (no recording there: that needs ARKit).
    android: { ...config.android, package: bundleIdentifier },
    extra: { ...config.extra, eas: { projectId: EAS_PROJECT_ID } },
  };
};
