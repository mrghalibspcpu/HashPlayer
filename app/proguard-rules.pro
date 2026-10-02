# Keep the JavaScript bridge reachable from the WebView
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.mrghalibspcpu.hashplayer.** { *; }
-dontwarn android.webkit.**
