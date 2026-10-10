# Snake

The classic snake game for a Fire TV remote: the D-pad steers, walls kill,
every snack grows the snake and speeds things up. Runs entirely on the
device — no account, no bridge, no network access at all.

## Controls

- **OK** — start, pause, resume, play again
- **Arrows** — steer. Pressing one on the start screen starts you moving in
  that direction (except the one way you can't go, which just starts you
  straight ahead).
- **Back** — quit to the launcher

## Build

```bash
npm install
npm run build:release
vega device install-app --dir . -b Release
```

## Credits

#### aaronYTDev - Snake, the D-pad steering UX
