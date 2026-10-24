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
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Dev stack

The repo is a bun workspace (`apps/*`, `packages/*`, hoisted `node_modules` at the root); run `bun install` from the root. `vpx _dev` (anywhere in the repo, in an interactive terminal) runs everything in mprocs: pane 0 is Metro, on Stim's `metro.port` (pinned to 8082 in `.stim.json`; 8081 without Stim), so `stim ios` reuses it, and pane 1 is the splat server on 8899. `vpx _dev --force` replaces a running stack and frees both ports (through `stim stop` when Stim's own dev server holds Metro's). Extra arguments go to `expo start` (`vpx _dev --clear`); `--port <n>` overrides the Metro port. The script is `packages/dev/_dev.ts`.

- Read pane output from `.mprocs-logs/metro.log` and `.mprocs-logs/splat-server.log` at the repo root instead of the TUI.
- Restart a pane through the control port: `vpx mprocs --server 127.0.0.1:8898 --ctl '{c: select-proc, index: 0}'`, then `vpx mprocs --server 127.0.0.1:8898 --ctl '{c: restart-proc}'`. Check whether it is up with `lsof -nP -iTCP:8898 -sTCP:LISTEN`, never by connecting: mprocs 0.9 crashes on an empty connection.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
