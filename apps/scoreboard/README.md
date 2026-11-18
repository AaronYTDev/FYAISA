# Couch Scoreboard

A two-team scorekeeper for Vega OS Fire TV Sticks. Pure React Native UI — no
WebView, no network, no sign-in. D-pad up/down picks the active team, left/right
adds or removes a point, OK adds a point, Menu resets the match, and
Play/Pause cycles an optional winning target from 5 to 50.

## Controls

| Remote | Action |
| --- | --- |
| D-pad up/down | select Home or Away |
| D-pad left / right | -1 / +1 point for the selected team |
| OK | +1 point for the selected team |
| Play/Pause | cycle the winning target (off, 5, 10 … 50) |
| Menu | reset the match |
| Back | quit to launcher |
| Home | exit |

## Build

```bash
npm install
npm run build:release
vega device install-app --dir . -b Release
```

## Credits

#### FYAISA contributors - the scoreboard UI and remote handling

Built as part of the FYAISA homebrew hub for Amazon Vega OS.
