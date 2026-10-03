package com.mrghalibspcpu.hashplayer

import android.app.Application
import android.webkit.WebView

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        // Chrome DevTools (chrome://inspect) for debuggable builds only
        if (0 != (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
    }
}
