# Cinevega

Movies and TV on a Vega OS Fire TV Stick, in a native interface instead of a
website in a WebView. Browse trending and popular titles, search, read the
details, hit play.

TMDB supplies the metadata — posters, overviews, ratings, and the season and
episode lists — and VidSrc plays it back in an embedded player. No account, no
captchas, no sign-up; the stick just needs to be online.

## Credits

- [TMDB](https://www.themoviedb.org/) — the metadata API behind every poster,
  rating and episode list. This product uses the TMDB API but is not endorsed
  or certified by TMDB.
- [VidSrc](https://vidsrc.to/) — the embed player.
- aaronYTDev / FYAISA — the app, the ElevSH pairing client and the scaffolding.

## Screens

- **Home** — rows for Trending, Popular Movies and Popular TV.
- **Search** — type with the on-screen keyboard, pick from the results grid.
- **Detail** — overview and rating, plus the episode list for TV.
- **Player** — the VidSrc embed, with Back to leave.

D-pad moves focus, OK opens a title or plays, Back goes up a screen, Home
exits.

## Build

```bash
npm install
npm run build:release
vega device install-app --dir . -b Release
```

Or from the repo root:

```bash
./fyaisa install app.cinevega.main
```

## What was fixed (1.0.1)

- **`com.amazon.network.service` added to `manifest.toml`** — the app calls the TMDB API and VidSrc over HTTPS but never declared network access, so every network call failed. This was the main reason Cinevega "didn't work."
- **Invalid `[offers]` section removed** — `com.amazon.gipc.uuid.*` is not a valid service ID and broke the build.
- **Unnecessary DRM/media service wants removed** — `com.amazon.drm.*`, `com.amazon.media.server`, `com.amazon.mediametrics.service`, etc. are not needed for VidSrc playback and can cause install rejection.
- **VidSrc mirror fallbacks** — VidSrc domains change often. The player now tries `vidsrc.to`, `vidsrc.cc`, `vidsrc.xyz`, `vidsrc.pro`, and `vidsrc.net` in order; if one mirror fails (HTTP error or load error), it automatically moves to the next.
- **install script fixed** — `scripts/install-device.sh` now uses `vega device install-app --dir . -b Release` instead of a hardcoded `.vpkg` path that didn't match the build output.

## FYAISA

This is a FYAISA hub app: its menu checks the catalog for a newer build and can
rebuild and reinstall itself over ElevSH (`fyaisa connect`), or you can run
`fyaisa update app.cinevega.main` from the repo root.
