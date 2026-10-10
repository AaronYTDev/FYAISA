# Aether

Open-source streaming for Movies / TV / Anime on Vega OS Fire TV Sticks.

Aether (aether.ist) is an open-source P-Stream fork with no popup ads, no captchas, and no sign-up required. This app wraps the Aether web interface in a Vega WebView so you can browse and stream with your Fire TV remote.

## Features

- Movies, TV shows, and Anime
- 1080p / 4K streaming
- Auto-next episodes
- Watch lists and continue watching
- No popup ads, no captchas, no sign-up
- Open source (GPL-3.0)

## Build

```bash
npm install
npm run build:release
```

## Install

```bash
vega device install-app -p build/armv7-release/aether_armv7.vpkg
```

Or from the repo root:

```bash
./fyaisa install app.aether.main
```

## FYAISA

This is a FYAISA hub app. Pair with ElevSH for in-app updates, or use `fyaisa update app.aether.main` from the repo root.
