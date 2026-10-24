This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start --dev-client # start the dev server (never Expo Go)
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Dev stack

The repo is a bun workspace (`frontend`, `mobile`, `packages/*`, hoisted `node_modules` at the root); run `bun install` from the root. `vpx _dev` (anywhere in the repo, in an interactive terminal) runs everything in mprocs: pane 0 is Metro, on Stim's `metro.port` (pinned to 8082 in `.stim.json`; 8081 without Stim), so `stim ios` reuses it, and pane 1 is the splat server's Mac agent (`frontend/src/agent`, see SPLATS.md: it trains captures and runs live 3D for the splat server on Vercel, and needs `frontend/.env.local` from `vercel env pull`). `vpx _dev --force` replaces a running stack and frees Metro's port (through `stim stop` when Stim's own dev server holds it). Extra arguments go to `expo start` (`vpx _dev --clear`); `--port <n>` overrides the Metro port. The script is `packages/dev/_dev.ts`.

- The Metro pane always runs `expo start --dev-client`, and `vpx _dev` refuses `--go`. Stim's LAN check rejects a Metro it did not start (`STIM_LAN_METRO_UNREACHABLE`), so a `stim ios --device` build against `vpx _dev` needs `--no-metro-check`.
- Build onto the phone with `vpx _ios` (`packages/dev/_ios.ts`); the camera screen needs ARKit, which the simulator lacks. It takes the cabled iPhone (`--device <udid|name>` for one on Wi-Fi, e.g. `--device minisilicon` on the rover), runs `expo prebuild --platform ios --no-clean` (Expo 58 prebuild otherwise deletes and regenerates `ios/`, Pods included) and `expo run:ios --no-bundler`, then relaunches the app through devicectl with a deep link to `vpx _dev`'s Metro: over the cable's "iPhone USB" link when the phone shares its Personal Hotspot (the phone is often not on the Mac's Wi-Fi), else at this Mac's LAN address. Expo's `i` key only opens simulators (its device prompt has a TODO for physical devices), so `vpx _ios` is the phone's `i`. `--simulator` builds onto the simulator `i` opens instead; other arguments go to `expo run:ios`.
- `vpx _ios production` (combinable with `--device`/`--simulator`) builds the production app in the Release configuration instead: the JS is embedded, so it runs without Metro, and autolinking leaves out `expo-dev-launcher` and `expo-dev-menu` (both `debugOnly`), so there is no dev client. `__DEV__` is false there, so the splat-preview tools start off (turn them on under the gallery's All Captures grid). The splat server's address and access token are built in from `EXPO_PUBLIC_SPLAT_SERVER_URL` and `EXPO_PUBLIC_SPLAT_TOKEN` (`.env.local`, or EAS environment variables).
- App variants, as in Haniverse: `EXPO_PUBLIC_APP_VARIANT` (`development` | `production`) picks the name, slug, scheme and bundle identifier in `app.config.ts` (the rest of the config is `app.json`). The development build is "soon2026 (Dev)", `com.leonsilicon.soon2026.development`, scheme `soon2026-dev`; production is "soon2026", `dev.improve.soon2026` (the App Store Connect app TestFlight ships), scheme `soon2026`. They install side by side, each with its own data. Unset means production, as Expo prescribes; `vpx _dev`'s Metro, `vpx _ios` and the `start`/`ios` package scripts set it, so set `EXPO_PUBLIC_APP_VARIANT=development` yourself for any other Expo or Stim command meant for the dev build (`stim ios`, a bare `expo start`). `ios/` holds whichever variant was prebuilt last; `vpx _ios` prebuilds the one it builds.
- Read pane output from `.mprocs-logs/metro.log` and `.mprocs-logs/splat-agent.log` at the repo root instead of the TUI.
- Restart a pane through the control port: `vpx mprocs --server 127.0.0.1:8898 --ctl '{c: select-proc, index: 0}'`, then `vpx mprocs --server 127.0.0.1:8898 --ctl '{c: restart-proc}'`. Check whether it is up with `lsof -nP -iTCP:8898 -sTCP:LISTEN`, never by connecting: mprocs 0.9 crashes on an empty connection.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

### TestFlight

Every push to `main` ships the production app to TestFlight: `.github/workflows/testflight.yml` runs on a self-hosted Mac (`runs-on: [self-hosted, macOS, ARM64]`), builds with `eas build --local` (profile `production` in `eas.json`, signed with the credentials EAS manages for the `improvelabs` Expo account, build number incremented remotely by EAS) and uploads with `eas submit` (App Store Connect app 6826604814). A push during a build waits; a newer push replaces a waiting one. Testers are internal only, so no build waits for Beta App Review: the internal "SOON" group has automatic distribution, so every build reaches its members once App Store Connect has processed it. A tester has to be a user on the App Store Connect team (invite them under Users and Access with access to this app only, then add them to SOON).

- The runner Mac needs Xcode, CocoaPods and fastlane (`eas build --local` uses all three) and about 25 GB free; the job stops early with less. The build's copy of the repo lives in the runner's temp directory, which the runner empties after every job.
- The leaf detector is gitignored, so the workflow exports it (cached by `packages/owlvit`'s inputs) and points `LEAF_DETECTOR_DIST` at it, because `eas build --local` prebuilds a copy of the repo without gitignored files.
- One-time setup: register the runner (only the repo owner can create its token), run `bunx eas-cli@24.12.1 credentials -p ios` once in `mobile` (profile `production`: reuse the account's distribution certificate, create the App Store provisioning profile, and assign the App Store Connect API key for submissions; `--non-interactive` builds can't create credentials).
- Secrets: only `EXPO_TOKEN`, and it's optional: without it the runner's `eas login` is used.
- Two repos, kept in sync: the runner is registered on github.com/leonsilicon/soon2026 (Leon owns it, which a self-hosted runner needs), while github.com/ParthJairam07/soon2026 stays the team's repo. Push every branch to both: in this checkout `origin` is leonsilicon/soon2026 and `parth` is ParthJairam07/soon2026, so `git push origin main && git push parth main`, after pulling from both. The TestFlight job only runs on leonsilicon/soon2026. `.github/workflows/sync.yml` would do the syncing (on every push to leonsilicon/soon2026 and every 10 minutes it fast-forwards whichever side is behind on every branch, merges branches that moved on both when they merge cleanly, and fails, naming the branch, when they conflict), but it is disabled on GitHub; it needs the `SYNC_TOKEN` secret before it's enabled.
- leonsilicon/soon2026 is public and its runner is a personal Mac, so only collaborators may open pull requests, every outside contributor's workflow run needs approval, the workflow token is read-only and only GitHub's own actions plus `oven-sh/setup-bun` and `astral-sh/setup-uv` may run. Keep it that way; allow a new third-party action under Settings → Actions before using it.

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Never use Expo Go. The app is always a development build (`expo-dev-client` is installed, and every `expo start` passes `--dev-client`); never pass `--go` or press S in the Expo CLI to switch targets. After adding a library with native code or changing the app config, rebuild it: `vpx _ios` (or `npx expo run:ios|android`) locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
