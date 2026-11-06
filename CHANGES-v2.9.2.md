# HashPlayer v2.9.2
- PLAYBACK FIX (pakka working): the custom EchoAudioProcessor has been removed from ExoPlayer entirely — the native engine now uses the stock Media3 audio sink exactly like the pre-2.9 builds that played fine. The 2.9.0/2.9.1 PCM processor was behind both the beep and the play/pause loop where no file would start. S+R space now comes from the PresetReverb device effect only.
- Splash: user-supplied artwork is now the background of the loading/splash screen (native startup window + in-app boot screen), with the HashPlayer logo and ring animation on top.
