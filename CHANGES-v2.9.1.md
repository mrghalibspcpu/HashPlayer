# HashPlayer v2.9.1
- Fix irritating beep/buzz on every native playback: EchoAudioProcessor now consumes its input buffer (Media3 BaseAudioProcessor contract); previously the same PCM chunk was re-queued forever.
- Library header: title/stats panel first at top; on scroll it slides away and the filter toolbar docks flush under the search bar with zero gap. Shuffle remains a chip in the same single row.
- Bottom control panel order: Skip silence, ANC, S+R, Visualizer first, then the rest.
