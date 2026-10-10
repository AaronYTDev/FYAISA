# FYAISA app (on-device)

The catalog browser that runs **on the Fire TV**. Part of the
[FYAISA](../) hub.

## What it does

- Fetches `catalog.json` from the hub repo on GitHub
- Lists every registered app with name, id, summary, and a status dot
- Opens a detail view per app: description, license, tags, architectures,
  minimum OS version, notes, and the exact install command
- Falls back to a small built-in list if GitHub is unreachable

## What it cannot do

**It cannot install apps.** Vega OS exposes no package-install API to
third-party apps; package management is a host-side operation
(`vega device install-app`). So the detail screen tells you what to run on your
computer instead:

```bash
fyaisa install <app-id>
```

## Build & run

```bash
npm install
npm run build:release
vega device install-app --dir . -b Release
vega device launch-app --appName app.fyaisa.hub.main
```

## Connect (pairing with your PC)

Because this app can't install packages, it pairs with `fyaisa connect` on your
computer to do it for you:

```bash
fyaisa connect --lan
```

In the app: **ElevSH** → type the PC's address with the on-screen keypad
→ **Get pairing code** → type the 6-digit code shown in your terminal → paired.
App detail screens then offer **Install via ElevSH**, and the build log streams back
to the TV.

See `../bridge/README.md` for the API and security model.

## Notes for developers

- This is a **native React Native for Vega** app, not a WebView app. There is
  no `document` or `window` — using them throws
  `ReferenceError: Property 'document' doesn't exist`. (That bug shipped in v1.0.0
  and force-killed the app on first launch.)
- Remote navigation is native: `Pressable` rows take D-pad focus, the first row
  is seeded with `hasTVPreferredFocus`, and Back is handled with `BackHandler`.
  No manual key listeners.
- Import `Pressable` from `@amazon-devices/react-native-kepler`, **not**
  `react-native` — the Vega version types its style callback as
  `{focused}`, and only the Kepler build carries the `hasTVPreferredFocus` prop.
  Importing RN's version silently drops TV focus behaviour.
- `BackHandler.addEventListener` takes `'hardwareBackPress'` on Vega (not RN's
  `'hardwareBack'`).
- The splash screen is held until the catalog request settles, so the app never
  flashes an empty list.
- If the catalog can't be fetched, a small built-in list is shown and a warning
  is displayed, so the app is usable offline.
