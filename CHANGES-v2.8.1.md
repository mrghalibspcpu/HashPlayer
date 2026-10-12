# HashPlayer v2.8.1 — 5-feature patch

All five requested features are implemented with zero regression risk
(every new block is additive / gated behind new button IDs or new filters).

## 1. Widget fix — dedicated per-button intents
* `HashPlayerWidget.kt` rewritten. Three buttons (search / playlists / EQ / last-track preview) launch `MainActivity` with deeplink actions. Four buttons (Play/Pause, Prev, Next, ANC) fire `PendingIntent.getService(...)` straight at `PlaybackService` so they act on playback **without opening the launcher**.
* `PlaybackService` gained `ACTION_TOGGLE_ANC = "hashplayer.anc"` and a volatile `ancOn` flag persisted in widget prefs.
* The play/pause glyph flips live; the ANC button shows an alpha tint when ANC is on.
* Five new vector drawables (`widget_pause_icon`, `widget_eq_icon`, `widget_anc_icon`, `widget_next_icon`, `widget_prev_icon`).
* Widget transport row is a 5-button bar: Prev · EQ · Play/Pause (accented, larger) · ANC · Next.

## 2. S+R 0.8× quick-toggle (portrait only)
* New **S+R** button in the now-playing tools (portrait only).
* One tap → speed 0.8× AND pitch 0.8× together ("slow / relaxed").
* Tap again → restore your previous speed/pitch.
* Any manual speed or pitch change exits the preset automatically.

## 3. Sticky Library header — zero gap
* `.toolbar` in `web/css/app.css` is `position:sticky; top:0;` with a solid `var(--bg)` slab (plus an optional backdrop-filter glass). The search bar + category chips pin flush to the top edge with no negative margin, no gradient hack — the Library title/stats scroll away cleanly with zero gap.

## 4. "Watched Online" chip + 24h auto-purge
* New `Watched Online` chip (🌐 icon) in the filter row.
* All streamed items — YouTube (`source: 'yt'`) and direct URL streams (`source: 'url'`) — are automatically marked `online: true` and routed here.
* The Video tab **excludes** them (local videos only). The Audio tab excludes them (local audio only). "All" still shows everything.
* Entries are auto-purged 24 h after their last play, both on load and via a 20-min interval sweeper. Re-watching refreshes the TTL.

## 5. Minimal Mode (car / driving UI)
* New **Minimal** button in portrait now-playing tools.
* Matt-black `#080808` background with cyan → purple 3D radial gradients.
* Central glossy vinyl disc:
  * Spins while playing (12 s/rev), paused when stopped.
  * Neon conic-gradient ring that pulses.
  * 64-bar circular canvas visualizer synced directly to `HP.Vis` (Web Audio or native ExoPlayer FFT feed), glowing cyan → purple with blend mode.
* Large high-contrast controls: Prev · Play (gradient) · Next on the first row; Shuffle / Repeat / Mute / Exit on the second row.
* **Lock screen** button directly under the dial — hides every control so the phone can sit in a car dock without accidental taps; shows "Tap to unlock" prompt.
* Portrait + phones only (landscape/tablet hidden automatically).

## Build
```bash
./gradlew assembleDebug
# output: app/build/outputs/apk/debug/app-debug.apk
```

The Gradle `syncWebAssets` task automatically copies `web/` into `assets/www/` at build time — no manual asset sync needed.
