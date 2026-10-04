<div align="center">

<img src="web/icons/icon-192.png" width="110" alt="HashPlayer" />

# HashPlayer 2.0

**A private, offline-first audio & video player.**
Install it as an app on your phone or desktop, or build a real Android APK — same code, one repository.

`10-band EQ` · `visualizer` · `lyrics` · `subtitles` · `gestures` · `playlists` · `no account, no server, no tracking`

### [⬇️ Android APK download karein](https://github.com/mrghalibspcpu/HashPlayer/releases/latest)

`YouTube links` · `auto device scan` · `picture-in-picture` · `open with / share to` · `online lyrics` · `landscape video`

</div>

---

## 🆕 Naya kya hai — 2.2

| Masla / feature | Ab kya hota hai |
|---|---|
| **Thori der baad playback ruk jati thi** | Player ab bilkul native app ki tarah chalta rehta hai: foreground service ab playback ke doran **wake lock** rakhta hai (screen off hone par CPU so kar audio band kar deta tha), WebView background me bhi "visible" rehta hai, aur Settings me ek tap **Battery settings** button aggressive battery savers (MIUI/EMUI…) se bachne ke liye whitelist banata hai. |
| **"File dobara kholen" error (2.2.1)** | Player ab **khud repair** hota hai: stream tootne par gaana wahin se dobara connect ho jata hai jahan ruka tha (4 koshish tak, beech beech me "Reconnecting…" ka ishara). Aur asal wajah bhi khatam — cover art/thumbnails ab background me alag se warm hote hain aur playback wale threads par kabhi bhaari kaam nahi karte, to gaane ki streaming rukti hi nahi. Buffer 14 second se zyada atake to stream khud reload ho jati hai. |
| **Background play — video + YouTube** | Screen band karein ya app chhod dein: local video **aur YouTube embed** dono ka audio chalta rehta hai, notification controls ke saath. Video par home dabayein to pehle jaisa system PiP window bhi milta hai. YouTube video beech me mar jaye to agla track khud chal jata hai. |
| **Audio ke album covers** | Device scan ab har gaane ka **album art aur har video ki thumbnail** MediaStore se uthata hai — list, queue, now-playing aur notification sab par cover dikhta hai. Purani library bhi agle scan par khud covers le leti hai. |
| **Portrait me buttons bahar jaate the** | Filter chips (…Most played) ab screen ke andar **side-swipe** hote hain, aur Play all / Shuffle choti screen par icon ban jaate hain — portrait me kuch bhi cut nahi hota. |
| **Notification me album art** | Media notification ab track ka cover dikhata hai (lock screen par bhi). |

---

## Naya kya tha — 2.1

| Masla / feature | Ab kya hota hai |
|---|---|
| **YouTube link** | URL sheet me YouTube link paste karein, ya YouTube app me **Share → HashPlayer** — video HashPlayer ke apne controls, gestures, sleep timer aur queue ke saath chalti hai. (YouTube apni audio khud deta hai, is liye us par EQ/visualizer kaam nahi karte — app aapko saaf bata deti hai.) |
| **Device scan khud nahi hota tha** | App khulte hi ek baar permission maang kar poori device ki audio+video khud scan kar leti hai. Settings me band bhi kar sakte hain. |
| **Atak atak ke chalna** | **Smooth mode** — phone par by default on. Bhaari blur/glow layers hat jaati hain, visualiser 30fps par cap, seek-bar updates throttle, aur Android side par file seeking ab direct byte offset se hoti hai (pehle poori file padhni padti thi). |
| **Landscape me view kharab** | Phone landscape me video poori screen leti hai aur controls uske upar float karte hain; tap karne par chhup/dikh jaate hain. Rotate karte hi apne aap full-screen. |
| **PiP nahi chalta tha** | Ab asli Android picture-in-picture. Home dabayein to video khud floating window me chali jaati hai. |
| **File manager me "Open with"** | Har audio/video file par HashPlayer option aata hai — multi-file share bhi chalta hai. |
| **Lyrics** | Lyrics sheet me **Find online** — ek tap me synced `.lrc` aa jaate hain (LRCLIB, bina account ke). |

---

## 🚀 Jaldi se shuru karein (quick start)

| Aap kya chahte hain | Kya karein |
|---|---|
| **Android phone pe install** | [Latest release](https://github.com/mrghalibspcpu/HashPlayer/releases/latest) se `-release.apk` download karein → tap karein → **Install** |
| **Phone/PC pe app ki tarah install** | `web/` folder ko kisi bhi hosting (GitHub Pages) pe daalein → browser me kholein → **Install app** button dabayein |
| **Android APK (.apk file)** | GitHub → **Actions** → **Build HashPlayer APK** → **Run workflow** → run khatam hone par **Artifacts** se APK download karein |
| **Sirf test karna hai** | `cd web && python3 -m http.server 8080` → `http://localhost:8080` |

> Aapki files kabhi upload nahi hoti. Sab kuch aapke device par hi rehta hai.

---

## ✨ What's inside

### Library
- Add **files, whole folders, drag & drop, or a direct URL** — audio *and* video
- **Reads tags locally**: ID3v1, ID3v2.2/2.3/2.4, MP4/M4A, FLAC, OGG/Opus, WAV → title, artist, album, genre, year, track no.
- **Album art** extracted from the file and used as cover, blurred backdrop and UI accent colour
- Saved in **IndexedDB**, so your library is still there the next time you open the app
- Search, sort (added / title / artist / album / length / plays / size), grid or list, favourites, recently played, most played
- Playlists, queue with **drag-to-reorder**, play-next, smart (weighted) shuffle, repeat one/all
- Import & export your library as JSON

### Sound
- **10-band equaliser** (31 Hz → 16 kHz) with 14 presets + live response curve
- Pre-amp, bass boost, treble, **reverb**, **stereo width**, balance, mono downmix
- **Night mode** compressor, **volume boost to 300 %**, fade on play/pause, **crossfade up to 12 s**
- Playback speed 0.25× – 3× with pitch preservation, A–B loop, bookmarks
- Five visualizers: bars, mirror, wave, radial, nebula

### Video
- Swipe gestures: **left/right = seek, left half = brightness, right half = volume**, double-tap = ±10 s, long-press = fast-forward, pinch = zoom
- Picture-in-picture, fullscreen, rotate, mirror, fit/cover/fill, **frame screenshots**
- **Subtitles**: `.srt`, `.vtt` and `.ass` (converted on the fly), toggle with one tap

### Words
- **Lyrics**: embedded (USLT/SYLT) or `.lrc` files — synced, karaoke-style, tap a line to jump, offset adjust
- Sidecar files are matched automatically: `song.mp3` + `song.lrc` + `song.srt`

### The app itself
- Installable **PWA** with an offline service worker — works with no internet at all
- 5 colour themes × dark / AMOLED / light, album-art tinting, **Simple mode** (clean) vs **Pro mode** (everything)
- **English + اردو** (full RTL layout)
- Media-session integration: lock-screen controls, headset buttons, Android notification
- Sleep timer with fade-out, resume where you left off, keyboard shortcuts for everything
- An "energy timeline" painted into the seek bar as you listen — a fingerprint of the track

---

## 📱 Build the Android APK

The Android app is a thin native shell around the exact same web app, so there is only one copy of the player code.
It adds what a browser cannot do on Android:

- **MediaStore scan** — finds every song and video on the phone
- Streams those `content://` files to the player **with HTTP Range support** (so seeking works)
- **Album art & video thumbnails** served straight from MediaStore (`/art/…`)
- A real system **file picker** for `<input type="file">`
- **Background playback** that actually keeps playing: foreground service + `MediaSession` + **wake lock**, and the WebView stays "visible" so even the YouTube embed doesn't pause
- Hardware **back button** handling and "Open with HashPlayer" from any file manager

### Build it in the cloud (no tools needed)
1. Open the repository on GitHub → **Actions**
2. Pick **Build HashPlayer APK** → **Run workflow**
3. Wait ~4 minutes → open the finished run → **Artifacts** → `HashPlayer-apk`
4. Unzip, copy the `.apk` to your phone, tap it, allow "install from unknown sources"

### Build it locally
```bash
# needs JDK 17 and the Android SDK (Android Studio installs both)
gradle assembleDebug          # or: ./gradlew assembleDebug if you generate a wrapper
# → app/build/outputs/apk/debug/app-debug.apk
```
Opening the folder in **Android Studio** also works — press ▶.

---

## 🌍 Publish the web player

Push to `main` with GitHub Pages enabled (Settings → Pages → *GitHub Actions*) and the
`Deploy web player to GitHub Pages` workflow publishes the `web/` folder.
Then open the URL on your phone → browser menu → **Add to Home screen**.

---

## 🗂 Repository layout

```
web/                     the player (this is the product)
 ├─ index.html           shell + inline SVG icon sprite
 ├─ css/                 base.css (tokens/themes) · app.css (shell) · player.css (now playing)
 ├─ js/
 │   ├─ util.js          helpers, settings store, i18n, colour extraction
 │   ├─ db.js            IndexedDB wrapper (tracks / playlists / key-value)
 │   ├─ meta.js          tag reader, LRC parser, SRT→VTT converter
 │   ├─ engine.js        Web Audio graph (EQ, effects, analyser)
 │   ├─ visual.js        visualizers + energy timeline
 │   ├─ library.js       import pipeline, storage, grid rendering
 │   ├─ player.js        playback, queue, gestures, lyrics, media session
 │   └─ app.js           shell wiring, settings, shortcuts, PWA, Android bridge
 ├─ manifest.webmanifest · sw.js · icons/
app/                     Android shell (Kotlin) — WebView + MediaStore + media notification
.github/workflows/       APK build + Pages deploy
legacy/                  the original single-file v1 player, kept for reference
```

No build step, no bundler, no npm, no CDN — every byte is served from your own origin,
which is also why it works completely offline and inside the APK.

---

## ⌨️ Shortcuts (desktop)

`Space`/`K` play · `←/→` seek · `Shift+←/→` 1 min · `↑/↓` volume · `M` mute · `N/B` next/prev
`F` fullscreen · `P` picture-in-picture · `S` shuffle · `R` repeat · `E` Sound Lab · `Q` queue
`Y` lyrics · `C` subtitles · `V` visualizer · `A` A–B loop · `D` bookmark · `[ ]` speed · `/` search

---

## 🔒 Privacy

There is no server. No analytics, no accounts, no network calls except the ones you make
yourself by adding a URL. Tags, album art, playlists and settings live in your browser's
IndexedDB / localStorage on your own device and are deleted when you clear the app's data.

---

<div align="center">Built by <b>HASH TECH</b> · MIT-friendly, do what you like with it.</div>
