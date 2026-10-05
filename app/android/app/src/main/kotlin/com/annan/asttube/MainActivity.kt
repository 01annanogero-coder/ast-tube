package com.annan.asttube

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import org.json.JSONObject

class MainActivity : FlutterActivity() {
    private var youtube: YouTube? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        mediaChannel(flutterEngine)
        netChannel(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "asttube/youtube").setMethodCallHandler { call, result ->
            val yt = youtube ?: YouTube().also { youtube = it }
            fun arg(name: String) = call.argument<String>(name) ?: ""
            fun next() = call.argument<String>("next")?.takeIf { it.isNotEmpty() }
            val work: (() -> Any)? = when (call.method) {
                "kiosk" -> { { yt.kiosk(arg("id"), next()) } }
                "search" -> { { yt.search(arg("q"), arg("filter"), next()) } }
                "suggest" -> { { yt.suggest(arg("q")) } }
                "video" -> { { yt.video(arg("id")) } }
                "comments" -> { { yt.comments(arg("id"), next()) } }
                "channel" -> { { yt.channel(arg("id"), arg("tab"), next()) } }
                "playlist" -> { { yt.playlist(arg("id"), next()) } }
                "mix" -> { { yt.mix(arg("id"), arg("seed"), next()) } }
                "related" -> { { yt.related(arg("id"), next()) } }
                "shorts" -> { { yt.shorts(arg("q"), next()) } }
                else -> null
            }
            if (work == null) {
                result.notImplemented()
            } else {
                yt.run(work) { json, error ->
                    if (error != null) result.error("YOUTUBE_FAILED", error, null) else result.success(json)
                }
            }
        }
    }

    // Internet on/off. The WebView's navigator.onLine stays "true" on its own, so the
    // real state comes from Android's ConnectivityManager.
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    private fun netChannel(flutterEngine: FlutterEngine) {
        val net = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "asttube/net")
        val cm = getSystemService(ConnectivityManager::class.java)
        fun online(): Boolean {
            val n = cm.activeNetwork ?: return false
            return cm.getNetworkCapabilities(n)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        }
        net.setMethodCallHandler { call, result ->
            when (call.method) {
                "online" -> result.success(online())
                "version" -> result.success(packageManager.getPackageInfo(packageName, 0).versionName)
                else -> result.notImplemented()
            }
        }
        val main = android.os.Handler(mainLooper)
        netCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { main.post { net.invokeMethod("changed", true) } }
            override fun onLost(network: Network) { main.post { net.invokeMethod("changed", online()) } }
        }.also { cm.registerDefaultNetworkCallback(it) }
    }

    // Background playback: the page reports what's playing; notification buttons go back to it.
    private fun mediaChannel(flutterEngine: FlutterEngine) {
        val media = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "asttube/media")
        MediaService.onAction = { action -> media.invokeMethod("action", action) }
        media.setMethodCallHandler { call, result ->
            when (call.method) {
                "update" -> {
                    try {
                        MediaService.update(this, JSONObject(call.arguments as String))
                    } catch (e: Exception) {
                        // Android refuses to start the service while we're in the background; the next foreground update will.
                    }
                    result.success(null)
                }
                "stop" -> { MediaService.stop(this); result.success(null) }
                else -> result.notImplemented()
            }
        }
    }

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        // Self-update from GitHub releases: install what the last launch downloaded, look for newer.
        if (savedInstanceState == null) Updater(this).run() // once per launch, not on rotation
    }

    override fun onDestroy() {
        netCallback?.let { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
        MediaService.onAction = null
        MediaService.stop(this)
        youtube?.destroy()
        super.onDestroy()
    }
}
