# DOOM

id Software's DOOM Episode One, the free shareware release, running on a
Fire TV Stick: the original engine compiled to WebAssembly and drawn to a
canvas inside a Vega WebView. Engine, game data and loader all ship in the
app; nothing loads from the network after install.

## Credits

- id Software: DOOM and the Episode One shareware data (DOOM1.WAD v1.9,
  freely redistributable, md5 f0cefca49926d00903cf57551d901abe).
- [ozkl/doomgeneric](https://github.com/ozkl/doomgeneric): the portable
  engine layer (GPL-2.0-or-later, which allows this GPL-3.0-only app).
- The Emscripten project: the WebAssembly toolchain that compiles it.
- aaronYTDev: the Vega OS port.

## Controls

| Remote | In DOOM |
| --- | --- |
| D-pad up / down | walk forward and back, always running |
| D-pad left / right | turn |
| OK | fire in play, select in menus (sends Ctrl and Enter; the engine ignores whichever does not apply) |
| Back | use: open doors, press switches. The app injects it because the WebView swallows Back |
| Home | exit the app |
| Play / Pause | use: the page maps the media key and React Native forwards the playpause TV event, so whichever pipe your remote uses works |
| Rewind / Fast-forward | strafe left / right, from the media key or a MediaSession seek |
| Menu | the DOOM menu, and one level back out of submenus (Esc). Menu never reaches the WebView, so React Native forwards it from the TV event hook |

From the title screen, OK steps through New Game and the skill pick and
drops you in E1M1.

## How it works

- `wasm/` builds the engine: doomgeneric at a pinned commit, compiled by
  emscripten into one self-contained `doom.js` (SINGLE_FILE, WAD embedded).
  `npm run build:wasm` regenerates `src/doomPayload.js` from it.
- The app loads `assets/shell.html` as `file:///pkg/assets/shell.html`
  (that directory is the WebView's default file access) and carries the
  payload as base64 inside `src/doomPayload.js`.
- The Vega WebView bridge silently drops oversized `injectJavaScript`
  payloads, so the payload crosses in 16 KB order-independent chunks. The
  shell reassembles them, base64-decodes to UTF-8 text and evals the
  bundle; the inline wasm is UTF-8 text, so Latin-1 decoding would corrupt
  it.
- The shell letterboxes the 640x400 framebuffer, turns remote keys into
  the keyboard events SDL2 expects and holds Shift down so the D-pad
  always runs.
- Engine startup lines reach the device log as `[doom]` entries
  (`vega device start-log-stream`), and a boot failure shows on screen.

## Build

```bash
npm install
npm run build:release
vega device install-app --dir . -b Release
```

Rebuilding the engine itself needs emsdk on PATH and network access for
the doomgeneric clone: `npm run build:wasm`.

## Limits

- No sound: the build drops SDL2_mixer so there is no timidity config to
  carry. Episode One plays in silence.
- Config and saves live in the WebView's memory and reset on exit.
- The Play/Pause, Rewind/Fast-forward and Menu mappings only apply if the
  remote's key reaches the page at all; if not, D-pad, OK and Back still
  cover a full playthrough.
