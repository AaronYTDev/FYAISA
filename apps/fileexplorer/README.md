# Credits

#### aaronYTDev — ElevSH Files, the D-pad browsing UX
#### FYAISA — pairing API, ElevSH bridge and the vendored `fyaisaClient.ts`

---

# ElevSH Files

A file explorer for Vega OS Fire TV devices, driven with the remote over
**ElevSH** — the same `fyaisa connect` pairing the FYAISA app uses.

The app runs sandboxed like every other Vega app: `KeplerFileSystem` only
exposes `/data`, `/tmp`, `/pkg` and `/proc` of *this* app, which would make a
useless "explorer". So the real device filesystem is read over ElevSH: the app
asks the bridge to run allowlisted `vega device run-cmd` commands on your PC
(`ls -la` for listings, `head -c` for previews), and the output comes back to
the TV.

```
ElevSH Files (TV)  ──HTTP──▶  ElevSH bridge (PC)  ──▶  vega device run-cmd  ──▶  Fire TV
```

## Using it

1. On your PC: `fyaisa connect --lan` (leave it running).
2. On the TV: open **ElevSH Files**, type the PC address with the D-pad
   keypad, press **Connect**.
3. Pairing auto-approves if **FYAISA → ElevSH** has already allowed
   `app.fyaisa.files.main`. Otherwise the app shows a 6-digit code — allow it
   in **FYAISA → ElevSH** (it appears as a pending request there), or run
   `fyaisa approve <code>` on the PC.

The pairing is remembered (across restarts and reboots). D-pad navigation:
**Enter** opens a directory or previews a file, **Back** goes up a directory
(or closes the preview), and a `Refresh` row re-lists the current path.

## Notes and limits

- **Previews are the first 64 KB** of a file, rendered up to ~20 000
  characters; bigger files say so in the header. Binary files (any control
  character other than tab/LF/CR in the first 4 KB) show a "no text preview"
  notice instead of garbage.
- **Shell safety comes from the bridge**: every `/vega` argument must match
  `^[A-Za-z0-9 ._/:=,@+-]+$`, which doubles as our sanitizer — directory
  names are pasted into `ls -la <path>` / `head -c 65536 <path>` and no
  metacharacter can ever reach the device shell. A side effect: filenames
  containing spaces or other exotic characters can be *listed* but not
  previewed (the command is rejected as unsafe — you'll see the error).
- Listings are capped at **400 rendered rows** (huge pseudo-filesystems like
  `/proc` would otherwise crawl) and at 256 KB of output bridge-side.
- System-owned directories (`d?????????` — not stat-able as this app's user)
  still list, just without sizes.
- This is a **read-only** explorer: browsing and previewing, no editing,
  moving or deleting.

## Building

```bash
npm install
npm run build:release
vega device install-app --dir . -b Release
```
