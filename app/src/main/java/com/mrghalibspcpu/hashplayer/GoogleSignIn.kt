package com.mrghalibspcpu.hashplayer

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat

/* ══════════════════════════════════════════════════════════════════
   "Continue with Google"

   The sign-in screen other apps show, built the same way the rest of the
   shell builds its overlays: a dimmed layer above the player with a card in
   the middle — HashPlayer's own copy, Google's four-colour G, one white pill
   and nothing else to decide.

   Tapping the pill hands over to Google's own account chooser inside the
   in-app YouTube WebView, so the session cookie lands exactly where YouTube
   reads it. Sign in once and the feed, subscriptions and history are yours
   from then on; long live the cookie jar.
   ══════════════════════════════════════════════════════════════════ */
class GoogleSignInSheet(
    private val act: Activity,
    private val root: FrameLayout
) {

    /** Ask the shell whether a Google session already exists. */
    var signedIn: () -> Boolean = { false }

    /** "Continue with Google" (or "Switch account") was tapped. */
    var onContinue: (() -> Unit)? = null

    /** Already signed in → open the feed instead of the chooser. */
    var onOpenFeed: (() -> Unit)? = null

    var onSignOut: (() -> Unit)? = null

    /** "Not now" — remembered, so the card never nags again. */
    var onDismiss: (() -> Unit)? = null

    private var view: View? = null

    fun isShowing(): Boolean = view != null

    fun hide() {
        val v = view ?: return
        view = null
        try { root.removeView(v) } catch (e: Exception) { }
    }

    fun show() {
        hide()
        val d = act.resources.displayMetrics.density
        val px = { v: Int -> (v * d).toInt() }
        val signed = try { signedIn() } catch (e: Exception) { false }

        val scrim = FrameLayout(act).apply {
            setBackgroundColor(Color.parseColor("#B304060C"))
            isClickable = true                       // swallow taps meant for the player
            setOnClickListener { hide() }            // tapping outside only closes the card
        }

        val card = LinearLayout(act).apply {
            orientation = LinearLayout.VERTICAL
            background = ContextCompat.getDrawable(act, R.drawable.g_sheet_card)
            setPadding(px(22), px(22), px(22), px(18))
            isClickable = true
        }

        /* the G on a white tile, like Google's own branding asks for */
        val mark = FrameLayout(act).apply {
            background = ContextCompat.getDrawable(act, R.drawable.g_mark_bg)
            addView(
                ImageView(act).apply {
                    setImageResource(R.drawable.ic_google_g)
                }, FrameLayout.LayoutParams(px(26), px(26), Gravity.CENTER)
            )
        }
        card.addView(mark, LinearLayout.LayoutParams(px(46), px(46)))

        card.addView(
            TextView(act).apply {
                text = act.getString(R.string.g_sheet_title)
                setTextColor(Color.parseColor("#F4F6FC"))
                textSize = 19f
                typeface = Typeface.DEFAULT_BOLD
            }, lp(px(0), top = px(15))
        )

        card.addView(
            TextView(act).apply {
                text = act.getString(
                    if (signed) R.string.g_sheet_hint else R.string.g_sheet_body
                )
                setTextColor(Color.parseColor("#9AA2B8"))
                textSize = 13f
                setLineSpacing(px(3).toFloat(), 1f)
            }, lp(px(0), top = px(9))
        )

        if (signed) {
            card.addView(
                TextView(act).apply {
                    text = act.getString(R.string.g_signed_in)
                    setTextColor(Color.parseColor("#59D98A"))
                    textSize = 12.5f
                    typeface = Typeface.DEFAULT_BOLD
                }, lp(px(0), top = px(12))
            )
        }

        /* the pill itself */
        val pill = LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            background = ContextCompat.getDrawable(
                act, if (signed) R.drawable.g_pill_green else R.drawable.g_pill_white
            )
            setPadding(px(16), px(13), px(16), px(13))
            isClickable = true
            addView(
                ImageView(act).apply { setImageResource(R.drawable.ic_google_g) },
                LinearLayout.LayoutParams(px(19), px(19))
            )
            addView(
                TextView(act).apply {
                    text = act.getString(if (signed) R.string.g_open_feed else R.string.g_continue)
                    setTextColor(Color.parseColor(if (signed) "#8FE6AE" else "#1F1F1F"))
                    textSize = 14.5f
                    typeface = Typeface.DEFAULT_BOLD
                    setPadding(px(10), 0, 0, 0)
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
                )
            )
            setOnClickListener {
                hide()
                if (signed) onOpenFeed?.invoke() else onContinue?.invoke()
            }
        }
        card.addView(
            pill,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                .apply { topMargin = px(20) }
        )

        /* the quiet row underneath: switch / sign out / not now */
        val foot = LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(0, px(14), 0, 0)
        }
        if (signed) {
            foot.addView(ghost(act.getString(R.string.g_switch), "#9AA2B8") {
                hide(); onContinue?.invoke()
            }, ghostLp(px(16)))
            foot.addView(ghost(act.getString(R.string.g_sign_out), "#E4736F") {
                hide(); onSignOut?.invoke()
            }, ghostLp(px(16)))
        }
        foot.addView(ghost(act.getString(R.string.g_not_now), "#8B93A9") { dismiss() }, ghostLp(px(16)))
        card.addView(foot, lp(ViewGroup.LayoutParams.MATCH_PARENT))

        /* a phone-shaped card, whatever the screen size */
        val widest = act.resources.displayMetrics.widthPixels - px(48)
        scrim.addView(
            card,
            FrameLayout.LayoutParams(minOf(px(380), widest), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER)
        )

        root.addView(
            scrim,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        view = scrim
    }

    private fun dismiss() {
        hide()
        onDismiss?.invoke()
    }

    private fun ghost(label: String, colour: String, onClick: () -> Unit): TextView =
        TextView(act).apply {
            text = label
            textSize = 12.5f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.parseColor(colour))
            setPadding(0, (8 * act.resources.displayMetrics.density).toInt(), 0,
                (8 * act.resources.displayMetrics.density).toInt())
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                cornerRadius = 999 * act.resources.displayMetrics.density
                setColor(Color.parseColor("#14FFFFFF"))
            }
            setOnClickListener { onClick() }
        }

    private fun ghostLp(margin: Int) =
        LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
            leftMargin = margin / 2; rightMargin = margin / 2
        }

    private fun lp(width: Int, top: Int = 0) =
        LinearLayout.LayoutParams(
            if (width == 0) ViewGroup.LayoutParams.MATCH_PARENT else width,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = top }
}
