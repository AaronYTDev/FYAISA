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
| D-pad | steer; moves the pointer in cursor mode |
| OK | click: play button or screen center in game mode, under the pointer in cursor mode |
| Menu | toggle mouse cursor mode |
| Back | quit to the launcher |
| Home | exit the app |

Arrow keys reach the page on the same content-key path DOOM uses. OK does
not become a mouse click on a TV, so Enter in the page and the TV hook's
`select` both run one single-flighted click. Menu is a system key the page
never sees, the same as DOOM's: the TV hook forwards it as a cursor-mode
toggle, and the document-start key handler is registered ahead of Google's
own listeners, so in cursor mode it takes the arrows outright, slides a
drawn pointer across the screen, and lets OK click where the pointer
stands. The injected scripts also scale Google's fixed-size game panel up
to the TV, re-checking after every key and click, and report keys, clicks,
fit changes, and mode flips as `[snake] ...` lines in logcat, which is how
you tell a key the game ignored from a key that never arrived.

## Build

```bash
npm install
npm run build:release
vega device install-app --dir . -b Release
```

## Credits

#### aaronYTDev - the WebView shell and the remote plumbing

The snake game itself is Google's, loaded live from google.com.
