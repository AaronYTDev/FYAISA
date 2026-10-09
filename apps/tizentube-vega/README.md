# TizenTube Vega

The reference app for the [FYAISA](../) hub — also the app that proved out the
Vega OS WebView injection technique.

Ad-free, sponsor-free YouTube for the latest Amazon Fire TV Sticks running Vega
OS (Fire TV Stick 4K Select, Fire TV Stick HD, Fire TV Stick 4K). These devices
cannot sideload the Android APK, so this is a native Vega app that runs the
official YouTube for TVs web app in a WebView and injects the TizenTube
userscript.

Full documentation: `README.md`. Install via the hub:

```bash
fyaisa install app.tizentube.vega
```

or directly:

```bash
npm install && npm run install:device
```
