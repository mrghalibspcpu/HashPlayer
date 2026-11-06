package com.mrghalibspcpu.hashplayer

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * A small, real PCM echo for the S+R (slowed + reverb) toggle.
 *
 * Android's PresetReverb gives the room/hall tail, but it does not produce a
 * distinct repeat. This processor sits in ExoPlayer's audio pipeline and adds a
 * short feedback delay (about 180 ms) to the dry signal. It is a no-op when the
 * mix is zero, so normal playback is untouched.
 *
 * The delay line is cleared on flush/reset (seek / new track), so an old echo
 * never bleeds into a new position.
 */
@UnstableApi
class EchoAudioProcessor : BaseAudioProcessor() {
    @Volatile private var mix: Float = 0f
    private val feedback: Float = 0.28f
    private var delay: FloatArray = FloatArray(0)
    private var pos: Int = 0
    private var channels: Int = 0

    /** 0 = dry, ~0.22 = a gentle slowed+reverb repeat. Called from the main thread. */
    fun setMix(value: Float) {
        mix = if (value.isFinite()) value.coerceIn(0f, 0.45f) else 0f
    }

    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        val enc = inputAudioFormat.encoding
        if ((enc != C.ENCODING_PCM_16BIT && enc != C.ENCODING_PCM_FLOAT) ||
            inputAudioFormat.sampleRate <= 0 || inputAudioFormat.channelCount <= 0
        ) return AudioProcessor.AudioFormat.NOT_SET

        channels = inputAudioFormat.channelCount
        val frames = (inputAudioFormat.sampleRate * 0.18f).toInt().coerceAtLeast(1)
        delay = FloatArray(frames * channels)
        pos = 0
        // Stay in the pipeline even while dry so S+R can be toggled mid-track.
        return inputAudioFormat
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val size = inputBuffer.remaining()
        val out = replaceOutputBuffer(size)
        // IMPORTANT: read from inputBuffer itself, never from a duplicate.
        // BaseAudioProcessor's contract requires queueInput() to CONSUME the
        // input (advance its position to its limit). Reading a read-only
        // duplicate left the original buffer untouched, so the audio renderer
        // re-queued the same chunk forever — heard on device as a loud,
        // irritating beeping/buzzing loop on every track since v2.9.0.
        val input = inputBuffer.order(ByteOrder.nativeOrder())
        val amount = mix

        if (amount <= 0f || delay.isEmpty()) {
            out.put(input)
            out.flip()
            return
        }

        if (inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT) {
            while (input.hasRemaining()) {
                val dry = input.float
                val wet = delay[pos]
                val mixed = (dry + wet * amount).coerceIn(-1f, 1f)
                delay[pos] = dry + wet * feedback
                out.putFloat(mixed)
                pos = (pos + 1) % delay.size
            }
        } else {
            while (input.hasRemaining()) {
                val dry = input.short.toFloat() / 32768f
                val wet = delay[pos]
                val mixed = (dry + wet * amount).coerceIn(-1f, 1f)
                delay[pos] = dry + wet * feedback
                out.putShort((mixed * 32767f).toInt().toShort())
                pos = (pos + 1) % delay.size
            }
        }
        out.flip()
    }

    override fun onFlush() {
        delay.fill(0f)
        pos = 0
    }

    override fun onReset() {
        delay = FloatArray(0)
        pos = 0
        channels = 0
    }
}
