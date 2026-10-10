Super Mario Bros NES emulator for Vega OS Fire TV Sticks (FYAISA hub app).

- jsnes (MIT) runs the game inside a Vega WebView. The shell page and the
  emulator ship as app assets, so the app works offline after the ROM is cached.
- The ROM is not bundled. On first launch the app downloads the US Super Mario
  Bros ROM from archive.org, caches it under /data, and starts it. Later launches
  read the cache.
- TV remote: D-Pad = NES D-Pad, OK/Enter = A (hold to run), Menu = Start,
  Back = Select, Fast-forward = A, Play/Pause = B.
- Targets armv7/aarch64/x86_64 and min Vega OS 1.2.

Layout:

- assets/smb/index.html is the shell page. jsnes is inlined into it; the separate
  assets/smb/jsnes.min.js is the unmodified jsnes 1.2.1 build the inline copy is
  spliced from. Keep the two in step if you regenerate the page.
- src/App.tsx downloads and caches the ROM, then hands it to the page in 16 KB
  chunks. The page reassembles the chunks, decodes base64, and boots jsnes.
