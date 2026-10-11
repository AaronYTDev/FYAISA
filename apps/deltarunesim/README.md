# DELTARUNE Fight Sim

The **DELTARUNE Fight Simulator** — over 300 DELTARUNE and UNDERTALE boss
fights, a boss rush, autoplay, replays, and bonus games — as a Fire TV app.
A Vega WebView pointed at `https://deltarunesim.com`, with the remote bound
to the simulator's keyboard controls.

## Credits

- **puskevi** — [DELTARUNE Fight Simulator](https://deltarunesim.com): the
  game itself. A free, fan-made battle simulator running in the browser;
  not affiliated with or endorsed by Toby Fox. DELTARUNE and UNDERTALE are
  (c) Toby Fox. Buy the real games: <https://deltarune.com>.
- **Madrinth** — the Vega OS WebView shell and the TV remote mapping.
- **aaronYTDev** — the hub, and the Snake app whose key plumbing this is
  built on.

## Controls

The simulator is keyboard-native (arrow keys move your SOUL, Z confirms,
X backs out, Tab opens the toolbox). The remote speaks those:

| Remote | In the simulator |
| --- | --- |
| D-pad | move the SOUL; navigate menus and fight lists |
| OK | Z: confirm / select / spare |
| Play/Pause | Z (a second confirm on the couch) |
| Back | X: cancel, back to the previous screen |
| Menu | Tab: open the toolbox (practice, rewind, slow-mo) |
| Fast-forward | Tab (the toolbox, reachable from the bumps) |
| Rewind | X |
| Home | exit the app |

Every key is logged as `[deltarunesim] ...`; unmapped buttons show up in
logcat as `tv <type> a<action>`, the same convention as the SMB app.

## Performance notes

This one is honest to say out loud: the sim is a WebGL + WASM engine, and
the Fire TV's WebView is usually the weakest browser in the room.

- **What the wrapper does:** the WebView serves the full bundle from its
  disk cache after the first visit (`LOAD_CACHE_ELSE_NETWORK`), so every
  boot after the first doesn't re-download megabytes of WASM and textures.
  All confirm presses are single-flighted so OK can't double-press.
- **What it can't do:** the app can't make the sim's own engine lighter.
  There is no settings or quality hook we can reach from outside, and
  capping the page's frame loop would break the battle timing.
- **What to expect:** a Fire TV Stick 4K or newer is the realistic floor.
  If the screen stays black after a cold start, terminate and relaunch once
  (Vega OS first-launch-after-install quirk, see HOMEBREW.md #9). On very
  weak sticks it may not boot at all — the same sim also has a Windows
  desktop app at deltarunesim.com/download.

## Build

```bash
npm install
npm run build:release
vega device install-app --dir . -b Release
```

See `apps/README.md` in the hub root for the full app contract.

## Notes

- Streams from deltarunesim.com: the stick needs internet. No account, no
  ads; the site itself is free.
- The sim's own FAQ: <https://deltarunesim.com/> — "Buy the real games."