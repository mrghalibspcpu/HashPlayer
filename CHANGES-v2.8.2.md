# HashPlayer v2.8.2 — BGM (background music) that actually works in the app

## What was wrong
The BGM sheet existed, but inside the APK it was effectively silent or harmful:

* Library tracks on Android are `content://` files. The old BGM used a WebView
  `<audio>` tag, which cannot open those — so a picked track never played.
* When it *could* play (http link), the WebView grabbed Android audio focus for
  itself, which made the main ExoPlayer **pause** the moment the BGM started —
  the opposite of "play under my media".
* YouTube as BGM used a hidden iframe embed, which the app's native YouTube
  path never fed.
* Volume was an absolute 20 %, not relative to what the media is playing at.

## What's new
* **Native BGM engine** (`BgmPlayback.kt`): a second ExoPlayer that loops the
  chosen track, opens `content://` / http(s) / YouTube-audio sources, and
  **never requests audio focus** — it cannot interrupt the main media.
* **Follows the main transport** for every engine (local audio, video, YouTube,
  web URL): media plays → BGM plays, media pauses → BGM pauses, resume → resume,
  close → BGM stops. A 180 ms grace keeps it from chopping on track changes.
* **Relative volume**: the slider is "% of the media level". Default is **10 %**;
  it tracks the main volume slider / hardware keys and mute.
* **On/Off** toggle keeps the chosen track loaded; **Stop & remove** clears it.
* **Device file** in the app now uses a native picker (real uri → native engine);
  in the browser it still uses the file input.
* Chosen BGM (library / URL / YouTube / device) is remembered across restarts.

## Files
* `app/src/main/java/com/mrghalibspcpu/hashplayer/BgmPlayback.kt` (new)
* `MainActivity.kt` — `bgmEngine / nBgmLoad / nBgmPlay / nBgmPause / nBgmVolume / nBgmStop / pickBgm`,
  `HashBridge.onBgm` / `onBgmPick`
* `web/js/player.js` — BGM block rewritten (native / element / embed engines, relative volume)
* `web/js/app.js`, `web/js/util.js`, `web/index.html`, `web/sw.js`
* `app/build.gradle` — versionCode 25, versionName 2.8.2
