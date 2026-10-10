# Google Snake

Google's own snake game (the arcade doodle Google serves when you search
for snake) as a TV app. The app is only a frame: a Vega WebView pointed at
`https://www.google.com/fbx?fbx=snake_arcade`, with the game streaming
from google.com. No account, no sign-in; the stick needs internet.

The offline D-pad snake this replaced is still in git history at this
path.

## Controls

| Remote | In Google Snake |
| --- | --- |
| D-pad | steer |
| OK | start and select |
| Back | quit to the launcher |
| Home | exit the app |

Arrow keys reach the page on the same content-key path DOOM uses. A script
injected at load reports every key the page sees as `[snake] key ...` in
logcat, which is how you tell a key the game ignored from a key that never
arrived.

## Build

```bash
npm install
npm run build:release
vega device install-app --dir . -b Release
```

## Credits

#### aaronYTDev - the WebView shell and the remote plumbing

The snake game itself is Google's, loaded live from google.com.
