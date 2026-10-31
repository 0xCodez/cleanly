# Cleanly

**Your computer, lighter.** A free, beautiful and honest disk cleaner for **Windows**, **macOS** and **Linux**.

Cleanly finds caches, temp files and forgotten downloads, shows where your space went, and clears it safely — no subscription, no ads, no scare tactics.

**[Download](https://github.com/0xCodez/cleanly/releases/latest)** · **[Website](https://getcleanly.vercel.app)** · **[Feedback](mailto:contact@beyond-media.ai)**

| Platform | Download |
|---|---|
| Windows 10/11 (x64) | [Installer](https://github.com/0xCodez/cleanly/releases/latest/download/Cleanly-setup.exe) · [Portable](https://github.com/0xCodez/cleanly/releases/latest/download/Cleanly-portable.exe) |
| macOS — Apple Silicon | [Cleanly-mac-arm64.dmg](https://github.com/0xCodez/cleanly/releases/latest/download/Cleanly-mac-arm64.dmg) |
| macOS — Intel | [Cleanly-mac-x64.dmg](https://github.com/0xCodez/cleanly/releases/latest/download/Cleanly-mac-x64.dmg) |
| Linux (x64) | [AppImage](https://github.com/0xCodez/cleanly/releases/latest/download/Cleanly-linux-x86_64.AppImage) · [.deb](https://github.com/0xCodez/cleanly/releases/latest/download/Cleanly-linux-amd64.deb) · [.rpm](https://github.com/0xCodez/cleanly/releases/latest/download/Cleanly-linux-x86_64.rpm) |

## Features

- **Smart Scan** — one tap shows how much you can reclaim and cleans the safe part.
- **Cleanup** — temp files, browser caches (every profile of Chrome, Edge, Brave, Firefox, Safari…), app caches, crash reports, update leftovers, developer caches, Trash / Recycle Bin and old downloads. Every group is labelled *Safe*, *Review* or *Permanent*.
- **Space Map** — your folders as glass bubbles sized by how much space they take. Drill into any folder, switch between your home folder and every drive (C:, D:, external volumes). Grab a bubble and throw it — they bump into each other.
- **Large Files & Duplicates** — find the biggest files on all your drives and exact duplicate copies, with real file icons.
- **Speed** — see which apps start with your computer and switch them off. System-wide items ask for permission, exactly like Task Manager. On Linux, XDG autostart entries are switched off with a per-user override; desktop-session parts (panel, polkit agent, keyring) are never offered.
- **Applications** — every installed app with its real icon, size and last use; uninstall with the app's own uninstaller (Windows), move it to the Trash (macOS), or remove Flatpaks, Snaps and AppImages (Linux; distro packages are listed but left to your software center).
- **Protection** — a quick check that the security built into your system (Microsoft Defender and firewall; Gatekeeper, XProtect and SIP; or SELinux/AppArmor, firewalld/ufw and system updates) is switched on and up to date. Cleanly does not replace your antivirus.
- **Assistant** — ask Claude or ChatGPT *"what can I safely delete?"* using your own API key.

## Safety model

Cleaning tools should never cost you a file. Cleanly is built around a few hard rules:

- **Caches are deleted, your files go to the Trash.** Caches, temp files and logs rebuild themselves, so they are removed for good (moving them to the Trash would free nothing). Anything you made — large files, duplicates, old downloads, apps — always goes to the system Trash, so you can restore it.
- **Only known places.** The app decides what to clean from the category, never from a path the interface sends. Every path is resolved to its real, full form and checked again before anything is touched.
- **System folders are off limits.** Drive roots, your home folder itself, Windows, Program Files, `$RECYCLE.BIN`, System Volume Information, network paths, symlinks and junctions are refused — including tricks like Windows short names (`DOCUME~1`) and trailing dots.
- **Files in use are skipped.** Temp files touched in the last 24 hours and locked files are left alone and reported.
- **Reversible speed tweaks.** Startup items are switched off with the same setting Task Manager uses; nothing is deleted, and you can switch them back on any time.

## Privacy

- Scanning happens entirely on your computer.
- The Assistant is optional. When you use it, only file **names, paths and sizes** are sent to the provider you chose — never file contents. Your API key is encrypted with your system's keychain (Electron `safeStorage`).
- No analytics or tracking in the app.

## First launch

The builds are not signed with paid Microsoft / Apple certificates yet, so your system will warn you the first time:

- **Windows:** if SmartScreen appears, click **More info → Run anyway**.
- **macOS:** open the `.dmg`, drag Cleanly to **Applications**, then run once in Terminal:

  ```bash
  xattr -cr /Applications/Cleanly.app
  ```
- **Linux:** `chmod +x Cleanly-linux-x86_64.AppImage` and run it (needs FUSE 2, `libfuse2`), or install the `.deb` / `.rpm`. Saving an AI key needs an unlocked keyring (GNOME Keyring or KWallet).

## Build from source

Requires Node.js 22 or newer.

```bash
npm install        # dependencies and the Electron binary
npm run dev        # run the app with hot reload
npm run demo       # UI only, in the browser at http://localhost:5174, with demo data (your disk is not touched)
npm run dist:win   # Windows installer + portable exe (x64)
npm run dist:mac   # macOS .dmg + .zip for arm64 and x64 (runs on a Mac only)
npm run dist:linux # Linux AppImage + .deb + .rpm (x64)
```

For the Linux `.deb` and `.rpm` targets, electron-builder's bundled fpm needs `libcrypt.so.1` and the rpm target needs `rpmbuild` (Fedora: `sudo dnf install libxcrypt-compat rpm-build`; Debian/Ubuntu: `sudo apt install rpm`). `npx electron-builder --linux AppImage` builds the AppImage alone.

Builds land in `release/`. The app icon lives in `build/icon.svg`; run `npm run icons` after changing it.

On Windows, if the installer step fails with *"could not open file"*, the project path is longer than Windows' 260-character limit — build from a shorter folder.

### Project layout

```
electron/        main process: scanners, cleaning, Trash, startup items, apps, AI, settings
  services/      one module per feature
src/             React + TypeScript interface
  screens/       one file per screen
  components/    shared UI (bubbles, WebGL shader, icons, buttons)
shared/types.ts  the typed contract between the main process and the interface
web/             the original design concept (open it in a browser)
design/          early UI explorations
```

### Releases

Pushing a tag like `v0.2.0` runs the **Build Cleanly** workflow: Windows builds on `windows-latest`, macOS on `macos-latest`, and both are attached to a new GitHub Release. Installer file names carry no version, so the `releases/latest/download/...` links above always point to the newest build.

## Support

Cleanly is free. If it helped, you can leave a tip from the **Tip** screen in the app. Payments are handled by Stripe; Cleanly never sees your card.

Ideas, bugs or a kind word: **contact@beyond-media.ai**, or the **Feedback** screen in the app.
