# HashPlayer v2.9.0

VersionCode **29**, versionName **2.9.0**.

## Fixes / features

1. **Favorites & playlists survive app close / reopen**
   - Library metadata is mirrored to a native atomic file (`LibraryBackup.kt`) in addition to WebView IndexedDB.
   - Startup restores the native backup before the device scan can race it.
   - Tombstones stop deleted files from being re-added by a later scan.
   - The 24-hour “Watched Online” cleanup no longer deletes favorites or playlist members.

2. **Tablet / large-screen landscape video is truly fullscreen**
   - The desktop split layout now applies to audio only.
   - Landscape video uses the immersive overlay on phones *and* tablets; controls float over the picture and auto-hide.

3. **Library toolbar**
   - Shuffle moved into the All / Audio / Video / Watched Online chip row.
   - On phones the toolbar is pushed flush under the search bar and bleeds to both screen edges.

4. **Delete device files from HashPlayer**
   - Track menu → “Delete file from device…” for local files.
   - Uses Android’s scoped-storage delete consent on Android 10+, legacy write permission on older versions.
   - Removes the item from the library, playlists and queue after Android confirms deletion.

5. **Sound**
   - Removed **Deep** and **Late night** presets; added **Lo-fi**.
   - **S+R** now adds a gentle reverb lift plus a real ~180 ms echo (Web Audio delay on the web, PCM `EchoAudioProcessor` in ExoPlayer) on top of 0.8× speed/pitch.
   - Turning S+R off, or manually changing speed/pitch, restores the previous sound.

6. **Widget**
   - Removed the mic-looking ANC button from the widget (ANC remains inside the player).
   - Search / Playlists / Prev / EQ / Play-Pause / Next keep dedicated actions.
   - Cold-start transport restores the last track + queue.
   - Resize-aware: compact control layout on short/narrow placements, full preview when larger.
   - Widget search can search the local library or open YouTube.

7. **YouTube microphone**
   - The in-app YouTube WebView now forwards microphone requests to Android’s runtime permission dialog and grants the pending WebRTC audio request after approval.

## Build

```bash
gradle assembleDebug
# app/build/outputs/apk/debug/app-debug.apk
```

CI also keeps a rolling, no-login download on the `latest-apks` prerelease.
