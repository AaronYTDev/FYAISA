# VegaTube (formerly TizenTube Vega)

The reference app for the [FYAISA](../../) hub: it proved out the Vega OS
WebView injection technique the hub is built on. It deliberately does **not**
ship the FYAISA (ElevSH) pairing client — [ElevSH Files](../fileexplorer) is the
reference app for that. Update VegaTube from your PC with
`fyaisa update app.vegatube.main`.

Ad-free, sponsor-free YouTube for the latest Amazon Fire TV Sticks running Vega
OS (Fire TV Stick 4K Select, Fire TV Stick HD, Fire TV Stick 4K). These devices
cannot sideload the Android APK, so this is a native Vega app that runs the
official YouTube for TVs web app in a WebView and injects the upstream
TizenTube userscript.

Full documentation: [repo README](../../README.md). Install via the hub:

```bash
fyaisa install app.vegatube.main
```

or directly:

```bash
npm install && npm run install:device
```

## Controls (1.3.2)

TizenTube's speed/settings row needs `window._yttv`, which the Vega WebView does
not expose, so those buttons never appeared. Press **Menu** for a native control
strip: Play/Pause, Back 10s, Fwd 10s, Speed (cycles 0.25x–2x), Next, Settings,
Hide. It is unmounted when hidden, so it never steals D-pad focus from YouTube.

Playback is smoother now: hidden preview videos are paused, the OS media session
no longer fights the page for transport, and a dropped injection chunk is
re-sent instead of leaving the page without TizenTube.

## Credits

- [ReisXD / TizenTube](https://github.com/reisxd/TizenTube): the original
  TizenTube userscript this app injects (GPL-3.0; see `LICENSE` and
  `.tizentube.json` for the vendored version's provenance).
- aaronYTDev: TizenTube → Vega OS port, now VegaTube.
- FYAISA: the hub that installs and updates it.
