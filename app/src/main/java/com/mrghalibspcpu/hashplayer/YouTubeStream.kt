package com.mrghalibspcpu.hashplayer

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * YouTube, without the iframe.
 *
 * A YouTube page is not a media file, but the page itself is only a thin client
 * over YouTube's own private "InnerTube" JSON API. Asking that API with a client
 * identity that is allowed to play without a browser (Vision Pro / iOS / Android
 * app) hands back the *direct* CDN urls of the video and audio streams — exactly
 * what the YouTube app itself plays.
 *
 * Those urls are plain progressive HTTP, so ExoPlayer can play them like any
 * other file: HashPlayer's own controls, gestures, equaliser, speed, sleep timer
 * and the lock-screen notification all work, which is impossible with the
 * sandboxed IFrame embed.
 *
 * Nothing is downloaded or stored: we only ask for the url and hand it to the
 * player. If YouTube refuses (geo-block, age gate, bot check, a client that has
 * been retired) every client is tried in turn and the caller falls back to the
 * old IFrame embed, so a video always plays one way or the other.
 *
 * The one knob that may need maintenance over time is CLIENTS below — client
 * versions are taken from yt-dlp's INNERTUBE_CLIENTS table.
 */
object YouTubeStream {

    private const val TAG = "HashPlayerYT"
    private const val PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false"
    private const val SEARCH_URL = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false"
    private const val WEB_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/127.0.0.0 Safari/537.36"

    /** A single playable stream (one of: muxed, video-only, audio-only). */
    data class Stream(
        val url: String,
        val mime: String,
        val bitrate: Int,
        val height: Int,
        val contentLength: Long
    )

    /** A YouTube-provided caption feed. `url` asks timedtext for WebVTT. */
    data class CaptionTrack(
        val url: String,
        val language: String,
        val label: String,
        val generated: Boolean
    )

    /** Everything the player needs to start a YouTube video natively. */
    data class Result(
        val videoId: String,
        val title: String,
        val author: String,
        val durationMs: Long,
        val muxed: Stream?,
        val video: Stream?,
        val audio: Stream?,
        val hls: String?,
        val isLive: Boolean,
        val captions: List<CaptionTrack>,
        val userAgent: String,
        val client: String
    ) {
        val playable: Boolean get() = hls != null || muxed != null || (video != null && audio != null) || audio != null
    }

    /* ------------------------------------------------------------ clients */

    private class Client(
        val name: String,
        val version: String,
        val numericId: Int,
        val ua: String,
        val fields: Map<String, Any> = emptyMap(),
        val embedded: Boolean = false
    )

    /**
     * Ordered by how reliably they hand out token-free urls today.
     * (Versions mirror yt-dlp's table; bump them if YouTube retires one.)
     */
    private val CLIENTS = listOf(
        Client(
            "VISIONOS", "1.02", 101,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 " +
                "(KHTML, like Gecko) Version/26.0 Safari/605.1.15",
            mapOf(
                "deviceMake" to "Apple",
                "deviceModel" to "RealityDevice17,1",
                "osName" to "visionOS",
                "osVersion" to "26.5.23O471"
            )
        ),
        Client(
            "IOS", "21.26.4", 5,
            "com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
            mapOf(
                "deviceMake" to "Apple",
                "deviceModel" to "iPhone16,2",
                "osName" to "iPhone",
                "osVersion" to "18.3.2.22D82"
            )
        ),
        Client(
            "ANDROID", "21.26.364", 3,
            "com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip",
            mapOf(
                "androidSdkVersion" to 30,
                "osName" to "Android",
                "osVersion" to "11"
            )
        ),
        Client(
            "TVHTML5_SIMPLY_EMBEDDED_PLAYER", "2.0", 85,
            "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 " +
                "(KHTML, like Gecko) Version/13.0 Safari/605.1.15",
            mapOf("clientScreen" to "EMBED"),
            embedded = true
        )
    )

    /* ------------------------------------------------------------ cache */

    private class Entry(val result: Result, val at: Long)

    private val cache = HashMap<String, Entry>()
    /** CDN urls stay valid for hours; re-ask well before they expire. */
    private const val CACHE_MS = 90L * 60L * 1000L

    @Synchronized
    private fun cached(id: String): Result? {
        val e = cache[id] ?: return null
        if (System.currentTimeMillis() - e.at > CACHE_MS) { cache.remove(id); return null }
        return e.result
    }

    @Synchronized
    private fun remember(id: String, r: Result) {
        if (cache.size > 24) cache.clear()
        cache[id] = Entry(r, System.currentTimeMillis())
    }

    @Synchronized
    fun forget(id: String) { cache.remove(id) }

    /* ------------------------------------------------------------ resolve */

    /** Nobody should watch a spinner longer than this while we try clients. */
    private const val DEADLINE_MS = 25_000L

    /** Blocking — always call from a background thread. */
    fun resolve(videoId: String, maxHeight: Int = 1080): Result? {
        if (videoId.isBlank()) return null
        cached(videoId)?.let { return it }

        val until = System.currentTimeMillis() + DEADLINE_MS
        var lastReason = ""
        for (client in CLIENTS) {
            if (System.currentTimeMillis() > until) { Log.w(TAG, "resolve deadline hit"); break }
            val json = try { post(PLAYER_URL, playerBody(client, videoId), client) } catch (e: Exception) {
                Log.w(TAG, "player call failed (${client.name})", e); null
            } ?: continue

            val status = json.optJSONObject("playabilityStatus")
            val state = status?.optString("status") ?: ""
            if (state.isNotEmpty() && state != "OK" && state != "LIVE_STREAM_OFFLINE") {
                lastReason = status?.optString("reason").orEmpty().ifBlank { state }
                Log.w(TAG, "${client.name}: $state ${lastReason.take(90)}")
                continue
            }

            val sd = json.optJSONObject("streamingData") ?: continue
            val details = json.optJSONObject("videoDetails")
            val live = details?.optBoolean("isLive", false) == true ||
                details?.optBoolean("isLiveContent", false) == true && sd.has("hlsManifestUrl")

            val muxed = pickMuxed(sd.optJSONArray("formats"), maxHeight)
            val adaptive = sd.optJSONArray("adaptiveFormats")
            val video = pickVideo(adaptive, maxHeight)
            val audio = pickAudio(adaptive)
            val hls = sd.optString("hlsManifestUrl", "").ifBlank { null }

            val result = Result(
                videoId = videoId,
                title = details?.optString("title").orEmpty(),
                author = details?.optString("author").orEmpty(),
                durationMs = (details?.optString("lengthSeconds")?.toLongOrNull() ?: 0L) * 1000L,
                muxed = muxed, video = video, audio = audio,
                hls = if (live) hls else null,
                isLive = live,
                captions = captionTracks(json),
                userAgent = client.ua,
                client = client.name
            )
            if (!result.playable) { Log.w(TAG, "${client.name}: no token-free streams"); continue }

            /* A url that exists is not necessarily a url this network is allowed to
               read — check one byte before handing it to the player, otherwise the
               user would watch a spinner instead of the next client's stream. */
            val probeUrl = result.hls ?: result.muxed?.url ?: result.video?.url ?: result.audio?.url
            if (probeUrl != null && !result.isLive && !probe(probeUrl, client.ua)) {
                Log.w(TAG, "${client.name}: stream url refused")
                continue
            }

            Log.i(TAG, "resolved $videoId via ${client.name}")
            remember(videoId, result)
            return result
        }
        Log.w(TAG, "could not resolve $videoId${if (lastReason.isBlank()) "" else " — $lastReason"}")
        return null
    }

    /**
     * The player response lists YouTube's first-party timed-text feeds. They
     * are streams, not downloaded files; adding fmt=vtt lets Media3 decode the
     * feed directly when the user turns on the in-player CC control.
     */
    private fun captionTracks(player: JSONObject): List<CaptionTrack> {
        val rows = player.optJSONObject("captions")
            ?.optJSONObject("playerCaptionsTracklistRenderer")
            ?.optJSONArray("captionTracks") ?: return emptyList()
        val out = ArrayList<CaptionTrack>()
        for (i in 0 until rows.length()) {
            val row = rows.optJSONObject(i) ?: continue
            val base = row.optString("baseUrl", "")
            if (base.isBlank()) continue
            val url = if (base.contains(Regex("[?&]fmt="))) base else
                base + if (base.contains('?')) "&fmt=vtt" else "?fmt=vtt"
            val language = row.optString("languageCode", "und").ifBlank { "und" }
            val label = text(row.opt("name")).ifBlank { language }
            out.add(CaptionTrack(url, language, label, row.optString("kind") == "asr"))
        }
        return out
    }

    /* ------------------------------------------------------------ format picking */

    private fun streamOf(f: JSONObject): Stream? {
        val url = f.optString("url", "")
        // signatureCipher urls need YouTube's JavaScript player to be de-scrambled —
        // those clients are skipped rather than half-supported.
        if (url.isBlank() || f.has("signatureCipher") || f.has("cipher")) return null
        val mime = f.optString("mimeType", "")
        return Stream(
            url = url,
            mime = mime,
            bitrate = f.optInt("bitrate", f.optInt("averageBitrate", 0)),
            height = f.optInt("height", 0),
            contentLength = f.optString("contentLength", "").toLongOrNull() ?: -1L
        )
    }

    /** Progressive video+audio in one file — the most compatible option. */
    private fun pickMuxed(arr: JSONArray?, maxHeight: Int): Stream? {
        arr ?: return null
        var best: Stream? = null
        for (i in 0 until arr.length()) {
            val f = arr.optJSONObject(i) ?: continue
            val s = streamOf(f) ?: continue
            if (!s.mime.startsWith("video/")) continue
            if (s.height > maxHeight) continue
            if (best == null || s.height > best!!.height) best = s
        }
        return best
    }

    private fun pickVideo(arr: JSONArray?, maxHeight: Int): Stream? {
        arr ?: return null
        var best: Stream? = null
        for (i in 0 until arr.length()) {
            val f = arr.optJSONObject(i) ?: continue
            if (f.optString("mimeType").startsWith("video/").not()) continue
            val s = streamOf(f) ?: continue
            if (s.height <= 0 || s.height > maxHeight) continue
            /* h264 in mp4 is the one combination every Android decoder handles,
               so it wins ties against vp9/av1 at the same height. */
            val avc = s.mime.contains("avc1")
            val bestAvc = best?.mime?.contains("avc1") == true
            val better = when {
                best == null -> true
                s.height != best!!.height -> s.height > best!!.height
                avc != bestAvc -> avc
                else -> s.bitrate > best!!.bitrate
            }
            if (better) best = s
        }
        return best
    }

    private fun pickAudio(arr: JSONArray?): Stream? {
        arr ?: return null
        var best: Stream? = null
        for (i in 0 until arr.length()) {
            val f = arr.optJSONObject(i) ?: continue
            if (f.optString("mimeType").startsWith("audio/").not()) continue
            val s = streamOf(f) ?: continue
            val m4a = s.mime.contains("mp4a")
            val bestM4a = best?.mime?.contains("mp4a") == true
            val better = when {
                best == null -> true
                m4a != bestM4a -> m4a
                else -> s.bitrate > best!!.bitrate
            }
            if (better) best = s
        }
        return best
    }

    /* ------------------------------------------------------------ search */

    /**
     * Online search, used by the library search bar. Returns a JSON array of
     * `{id,title,author,duration,views,published,thumb,live}` — blocking.
     */
    fun search(query: String, limit: Int = 24): JSONArray {
        val out = JSONArray()
        val q = query.trim()
        if (q.isEmpty()) return out
        val client = Client("WEB", "2.20260708.00.00", 1, WEB_UA)
        val body = JSONObject().apply {
            put("context", context(client))
            put("query", q)
            put("params", "EgIQAQ==")          // filter: videos only
        }
        val json = try { post(SEARCH_URL, body, client) } catch (e: Exception) {
            Log.w(TAG, "search failed", e); null
        } ?: return out

        val found = ArrayList<JSONObject>()
        // Keep YouTube's own ranking: walk the primary result list in order
        // first, and only fall back to a generic tree walk if the layout
        // changed (a tree walk cannot preserve order — JSON object keys are
        // unordered on Android).
        collectOrdered(json, found, limit)
        if (found.isEmpty()) collectRenderers(json, found, limit)
        for (v in found) {
            val id = v.optString("videoId", "")
            if (id.isBlank()) continue
            val o = JSONObject()
            o.put("id", id)
            o.put("title", text(v.opt("title")))
            o.put("author", text(v.opt("ownerText")).ifBlank { text(v.opt("longBylineText")) }
                .ifBlank { text(v.opt("shortBylineText")) })
            val length = text(v.opt("lengthText"))
            // Live cards carry a LIVE badge/overlay and never a duration.
            val live = length.isBlank() &&
                (v.optJSONArray("badges")?.toString()?.contains("LIVE", true) == true ||
                    v.optJSONArray("thumbnailOverlays")?.toString()?.contains("LIVE", true) == true)
            o.put("duration", length)
            o.put("views", text(v.opt("shortViewCountText")).ifBlank { text(v.opt("viewCountText")) })
            o.put("published", text(v.opt("publishedTimeText")))
            o.put("thumb", thumbOf(v, id))
            o.put("live", live)
            out.put(o)
            if (out.length() >= limit) break
        }
        return out
    }

    /**
     * The real search page order: `contents → twoColumnSearchResultsRenderer →
     * primaryContents → sectionListRenderer → contents[] → itemSectionRenderer →
     * contents[]`. Every step here is a JSON *array*, so the rows come back in
     * exactly the sequence youtube.com would show them. Shelves ("People also
     * watched", Shorts, ads, channels) are skipped rather than mixed in.
     */
    private fun collectOrdered(json: JSONObject, out: MutableList<JSONObject>, limit: Int) {
        val sections = json
            .optJSONObject("contents")
            ?.optJSONObject("twoColumnSearchResultsRenderer")
            ?.optJSONObject("primaryContents")
            ?.optJSONObject("sectionListRenderer")
            ?.optJSONArray("contents") ?: return

        for (i in 0 until sections.length()) {
            val items = sections.optJSONObject(i)
                ?.optJSONObject("itemSectionRenderer")
                ?.optJSONArray("contents") ?: continue
            for (j in 0 until items.length()) {
                val item = items.optJSONObject(j) ?: continue
                if (item.has("adSlotRenderer") || item.has("promotedVideoRenderer") ||
                    item.has("searchPyvRenderer")
                ) continue
                val v = item.optJSONObject("videoRenderer")
                    ?: item.optJSONObject("videoWithContextRenderer")
                    ?: continue
                if (v.optString("videoId", "").isBlank()) continue
                out.add(v)
                if (out.size >= limit) return
            }
        }
    }

    /** YouTube ships several result layouts; just walk the tree for video cards. */
    private fun collectRenderers(node: Any?, out: MutableList<JSONObject>, limit: Int) {
        if (out.size >= limit) return
        when (node) {
            is JSONObject -> {
                val keys = node.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    val child = node.opt(k)
                    if ((k == "videoRenderer" || k == "compactVideoRenderer" ||
                            k == "videoWithContextRenderer") && child is JSONObject
                    ) {
                        if (child.optString("videoId", "").isNotBlank()) out.add(child)
                        if (out.size >= limit) return
                    } else collectRenderers(child, out, limit)
                }
            }
            is JSONArray -> {
                for (i in 0 until node.length()) {
                    collectRenderers(node.opt(i), out, limit)
                    if (out.size >= limit) return
                }
            }
        }
    }

    /** InnerTube text nodes are either `{simpleText}` or `{runs:[{text}]}`. */
    private fun text(node: Any?): String = when (node) {
        is String -> node
        is JSONObject -> {
            val simple = node.optString("simpleText", "")
            if (simple.isNotBlank()) simple
            else {
                val runs = node.optJSONArray("runs")
                val sb = StringBuilder()
                if (runs != null) for (i in 0 until runs.length())
                    sb.append(runs.optJSONObject(i)?.optString("text").orEmpty())
                sb.toString()
            }
        }
        is JSONArray -> {
            val sb = StringBuilder()
            for (i in 0 until node.length()) sb.append(text(node.opt(i)))
            sb.toString()
        }
        else -> ""
    }

    private fun thumbOf(v: JSONObject, id: String): String {
        val list = v.optJSONObject("thumbnail")?.optJSONArray("thumbnails")
        if (list != null && list.length() > 0) {
            val last = list.optJSONObject(list.length() - 1)?.optString("url").orEmpty()
            if (last.isNotBlank()) return last
        }
        return "https://i.ytimg.com/vi/$id/hqdefault.jpg"
    }

    /* ------------------------------------------------------------ http */

    private fun context(c: Client): JSONObject {
        val client = JSONObject()
        client.put("clientName", c.name)
        client.put("clientVersion", c.version)
        client.put("hl", "en")
        client.put("gl", "US")
        client.put("userAgent", c.ua)
        for ((k, v) in c.fields) client.put(k, v)
        val ctx = JSONObject().put("client", client)
        if (c.embedded) ctx.put("thirdParty", JSONObject().put("embedUrl", "https://www.youtube.com/"))
        return ctx
    }

    private fun playerBody(c: Client, videoId: String): JSONObject = JSONObject().apply {
        put("context", context(c))
        put("videoId", videoId)
        put("contentCheckOk", true)
        put("racyCheckOk", true)
    }

    private fun post(endpoint: String, body: JSONObject, c: Client): JSONObject? {
        val conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 12_000
            readTimeout = 15_000
            doOutput = true
            instanceFollowRedirects = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("User-Agent", c.ua)
            setRequestProperty("Accept-Language", "en-US,en;q=0.9")
            setRequestProperty("Origin", "https://www.youtube.com")
            setRequestProperty("Referer", "https://www.youtube.com/")
            setRequestProperty("X-YouTube-Client-Name", c.numericId.toString())
            setRequestProperty("X-YouTube-Client-Version", c.version)
        }
        return try {
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream: InputStream = if (code in 200..299) conn.inputStream else conn.errorStream ?: return null
            val raw = read(stream)
            if (code !in 200..299) { Log.w(TAG, "HTTP $code from ${c.name}"); return null }
            JSONObject(raw)
        } catch (e: Exception) {
            Log.w(TAG, "request failed (${c.name})", e); null
        } finally {
            try { conn.disconnect() } catch (e: Exception) { }
        }
    }

    private fun read(input: InputStream): String {
        val bos = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        input.use {
            while (true) {
                val n = it.read(buf)
                if (n < 0) break
                bos.write(buf, 0, n)
            }
        }
        return bos.toString("UTF-8")
    }

    /** One-byte range request: proves the CDN will actually serve this device. */
    private fun probe(url: String, ua: String): Boolean = try {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10_000
            readTimeout = 10_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", ua)
            setRequestProperty("Range", "bytes=0-1")
            setRequestProperty("Accept", "*/*")
        }
        val code = try { conn.responseCode } finally { try { conn.disconnect() } catch (e: Exception) { } }
        code in 200..299
    } catch (e: Exception) { false }

    @Suppress("unused")
    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
}
