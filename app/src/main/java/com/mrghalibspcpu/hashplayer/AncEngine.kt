package com.mrghalibspcpu.hashplayer

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Handler
import android.util.Log
import kotlin.concurrent.thread
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min

/**
 * ANC+ — the "earbud" mode.
 *
 * An earbud's ANC works because a microphone sits millimetres from your eardrum:
 * it measures the incoming noise and the driver plays the inverted wave, so the
 * two cancel before they reach you. A phone cannot do that — its speaker is
 * across the room, and its own music arrives back at the same microphone it would
 * have to listen through.
 *
 * What a phone *can* do, and what "adaptive volume" earbuds and hearing aids also
 * do, is measure the room and hold the programme material a fixed distance above
 * it: as the noise rises, the player lifts its own level and sharpens the band
 * that carries speech, so a voice stays equally intelligible in a quiet room and
 * next to a running fan. This class is the ear — it measures. [NativePlayback]
 * is the hand — it applies the result to the audio session.
 *
 * The capture runs through [MediaRecorder.AudioSource.VOICE_COMMUNICATION] so the
 * platform puts its acoustic-echo canceller and noise suppressor in front of our
 * meter. That is what makes the reading usable while music is playing: the
 * phone's own output is subtracted and what is left is the room.
 */
class AncEngine(
    private val main: Handler,
    private val onAmbient: (Level) -> Unit
) {

    /** One measurement of the room. */
    class Level(val db: Float, val strength: Float)

    companion object {
        private const val TAG = "HashPlayer.ANC"
        private const val RATE = 16000                 // Hz — plenty for a level meter
        private const val FRAME_MS = 100               // one reading per 100 ms
        private const val REPORT_MS = 400              // tell the player 2–3× a second

        /* dB SPL the strength curve is drawn between. ~42 dB is a quiet room,
           ~82 dB is a busy street or a fan on high. */
        private const val QUIET_DB = 42f
        private const val LOUD_DB = 82f

        /* Rough mic calibration: full scale on a phone microphone is somewhere
           around 100–110 dB SPL. This only has to be right to a few dB, because
           everything downstream is a smooth curve, not a threshold. */
        private const val FS_SPL = 102f
    }

    @Volatile private var running = false
    private var worker: Thread? = null
    private var record: AudioRecord? = null
    private var echo: AcousticEchoCanceler? = null
    private var suppressor: NoiseSuppressor? = null
    private var lastReport = 0L

    /** Noise floor in dB SPL, tracked with a fast attack and a slow release. */
    private var floor = QUIET_DB

    val isRunning: Boolean get() = running

    /**
     * Start listening. Needs RECORD_AUDIO; if it is missing or the microphone is
     * busy the engine simply stays off and the player falls back to the static
     * ANC curve — playback is never affected.
     */
    @SuppressLint("MissingPermission")
    fun start() {
        if (running) return
        val frame = RATE / 1000 * FRAME_MS
        val minBuf = try {
            AudioRecord.getMinBufferSize(
                RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
            )
        } catch (e: Throwable) { -1 }
        if (minBuf <= 0) { Log.w(TAG, "no microphone available"); return }
        val buf = max(minBuf, frame * 2 * 4)

        /* VOICE_COMMUNICATION first: that source is the one the platform runs its
           echo canceller on. MIC is the fallback for devices that refuse it. */
        val rec = openRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, buf)
            ?: openRecord(MediaRecorder.AudioSource.MIC, buf)
        if (rec == null) { Log.w(TAG, "AudioRecord unavailable — ANC+ stays static"); return }

        record = rec
        val session = try { rec.audioSessionId } catch (e: Throwable) { 0 }
        if (session != 0) {
            echo = try {
                AcousticEchoCanceler.create(session)?.apply {
                    if (AcousticEchoCanceler.isAvailable()) enabled = true
                }
            } catch (e: Throwable) { null }
            suppressor = try {
                NoiseSuppressor.create(session)?.apply {
                    if (NoiseSuppressor.isAvailable()) enabled = true
                }
            } catch (e: Throwable) { null }
        }

        running = true
        floor = QUIET_DB
        lastReport = 0L
        worker = thread(name = "hashplayer-anc", isDaemon = true) { pump(rec, frame) }
    }

    fun stop() {
        running = false
        worker?.let { t -> try { t.join(400) } catch (e: InterruptedException) { } }
        worker = null
        try { echo?.release() } catch (e: Throwable) { }
        try { suppressor?.release() } catch (e: Throwable) { }
        echo = null
        suppressor = null
        try {
            record?.let { if (it.recordingState == AudioRecord.RECORDSTATE_RECORDING) it.stop() }
            record?.release()
        } catch (e: Throwable) { Log.w(TAG, "mic release", e) }
        record = null
    }

    @SuppressLint("MissingPermission")
    private fun openRecord(source: Int, buffer: Int): AudioRecord? = try {
        AudioRecord(
            source, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, buffer
        ).takeIf { it.state == AudioRecord.STATE_INITIALIZED }
            ?: run { Log.w(TAG, "AudioRecord($source) not initialised"); null }
    } catch (e: Throwable) {
        Log.w(TAG, "AudioRecord($source) refused", e)
        null
    }

    private fun pump(rec: AudioRecord, frame: Int) {
        val pcm = ShortArray(frame)
        try { rec.startRecording() } catch (e: Throwable) { Log.w(TAG, "startRecording", e); running = false; return }
        if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) { running = false; return }

        while (running) {
            val n = try { rec.read(pcm, 0, frame) } catch (e: Throwable) { -1 }
            if (n <= 0) { if (n < 0) break else continue }

            /* RMS of the frame → dB SPL, then a noise-floor tracker: the room
               level rises as fast as it appears and settles back down slowly, so
               a door slam does not send the volume chasing after it. */
            var sum = 0.0
            for (i in 0 until n) { val s = pcm[i].toDouble() / 32768.0; sum += s * s }
            val rms = Math.sqrt(sum / n)
            if (rms <= 1e-7) continue
            val dbfs = (20.0 * log10(rms)).toFloat()
            val spl = (dbfs + FS_SPL).coerceIn(20f, 110f)
            floor += if (spl > floor) (spl - floor) * 0.35f else (spl - floor) * 0.045f

            val now = System.currentTimeMillis()
            if (now - lastReport < REPORT_MS) continue
            lastReport = now
            val strength = ((floor - QUIET_DB) / (LOUD_DB - QUIET_DB)).coerceIn(0f, 1f)
            val level = Level(floor, strength)
            main.post { if (running) onAmbient(level) }
        }

        try { if (rec.recordingState == AudioRecord.RECORDSTATE_RECORDING) rec.stop() } catch (e: Throwable) { }
    }

    /**
     * How far above the noise the programme material should sit, in dB. A quiet
     * room needs no lift at all; a loud one gets up to +9 dB before the
     * compressor takes over.
     */
    fun liftDb(strength: Float): Float = min(9f, max(0f, strength * 9f))
}
