# 2048

The classic sliding-tile puzzle for Vega OS Fire TV Sticks. Pure React Native
UI — no WebView, no network, no sign-in. Tiles slide with the D-pad, OK starts a
new game, Menu undoes the last move, and Back quits. The board, scoring and
tile art are generated locally; nothing is downloaded after install.

## Controls

| Remote | Action |
| --- | --- |
| D-pad | slide tiles up, down, left or right |
| OK | start a new game (also clears the win/game-over state) |
| Menu | undo the last move (up to 20 moves) |
| Back | quit to launcher |
| Home | exit |

## Build

```bash
npm install
npm run build:release
vega device install-app --dir . -b Release
```

## Credits

#### FYAISA contributors - the TV board, scoring and remote handling

2048 is a widely reimplemented puzzle; this build contains no upstream source
or assets, only original React Native code generated for Vega OS.
