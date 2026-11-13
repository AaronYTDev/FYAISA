# TV Timer

A stopwatch and countdown timer for Vega OS Fire TV Sticks. Pure React Native
UI — no WebView, no network, nothing to sign into. Driven entirely by the
remote: D-pad moves between the two modes and the controls, OK starts and
stops, Menu resets, Back quits.

## Controls

| Remote | Stopwatch | Countdown |
| --- | --- | --- |
| D-pad left/right | switch mode | switch mode |
| D-pad up/down | — | adjust minutes |
| OK | start / stop | start / stop |
| Menu | reset | reset |
| Back | quit to launcher | quit to launcher |
| Home | exit | exit |

## Build

```bash
npm install
npm run build:release
vega device install-app --dir . -b Release
```

## Credits

#### FYAISA contributors - the timer shell and remote handling

Built as part of the FYAISA homebrew hub for Amazon Vega OS.
