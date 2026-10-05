package com.annan.asttube

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.ConnectivityManager
import android.os.Build
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlin.concurrent.thread

/**
 * Self-update from the latest GitHub release (the app is not on the Play Store).
 *
 * On each launch:
 *  1. If an earlier launch downloaded the APK of a newer version, hand it to
 *     Android's installer. Android always asks the user to confirm.
 *  2. In the background, check the latest release. If it is newer and the phone
 *     is on Wi-Fi (not metered data), download its APK for the next launch.
 */
class Updater(private val activity: Activity) {
    private val dir = File(activity.filesDir, "updates")
    private val current = activity.packageManager.getPackageInfo(activity.packageName, 0).versionName ?: "0"

    fun run() {
        val ready = dir.listFiles()?.firstOrNull { it.name.endsWith(".apk") }
        if (ready != null) {
            if (newer(versionOf(ready), current)) install(ready)
            else dir.deleteRecursively() // already installed
        }
        thread(isDaemon = true, name = "updater") {
            try { download() } catch (_: Exception) { /* offline etc.: try again next launch */ }
        }
    }

    private fun download() {
        val cm = activity.getSystemService(ConnectivityManager::class.java)
        if (cm.isActiveNetworkMetered) return // don't spend mobile data on a ~70 MB download
        val release = JSONObject(open(LATEST_RELEASE).use { it.readBytes().decodeToString() })
        val version = release.getString("tag_name").removePrefix("v")
        if (!newer(version, current)) return
        val target = File(dir, "ASTTube-$version.apk")
        if (target.exists()) return
        val assets = release.getJSONArray("assets")
        val apk = (0 until assets.length()).map { assets.getJSONObject(it) }
            .firstOrNull { it.getString("name").endsWith(".apk") } ?: return

        dir.mkdirs()
        val part = File(dir, "download.part")
        open(apk.getString("browser_download_url")).use { input -> part.outputStream().use { input.copyTo(it) } }
        // GitHub lists each asset's size and, for newer uploads, its SHA-256.
        val digest = apk.optString("digest")
        if (part.length() != apk.getLong("size") || (digest.startsWith("sha256:") && sha256(part) != digest.removePrefix("sha256:"))) {
            part.delete()
            return
        }
        dir.listFiles()?.filter { it.name.endsWith(".apk") }?.forEach { it.delete() }
        part.renameTo(target)
    }

    // A PackageInstaller session goes straight to the system "update this app?"
    // prompt. (Opening the APK with ACTION_VIEW instead lets any app that claims
    // APK files, like file managers or editors, into an "Open with" chooser.)
    private fun install(apk: File) = thread(name = "updater-install") {
        try {
            val installer = activity.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            params.setAppPackageName(activity.packageName)
            val id = installer.createSession(params)
            installer.openSession(id).use { session ->
                session.openWrite("update.apk", 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                val mutable = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
                val result = PendingIntent.getBroadcast(
                    activity, id, Intent(activity, UpdateInstallReceiver::class.java),
                    PendingIntent.FLAG_UPDATE_CURRENT or mutable,
                )
                session.commit(result.intentSender)
            }
        } catch (_: Exception) { /* try again next launch */ }
    }

    private fun open(url: String): InputStream {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15_000
        c.readTimeout = 30_000
        c.setRequestProperty("Accept", "application/vnd.github+json")
        c.setRequestProperty("User-Agent", "ASTTube/$current")
        if (c.responseCode != 200) throw IllegalStateException("HTTP ${c.responseCode} for $url")
        return c.inputStream
    }

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(1 shl 16)
            while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n) }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    companion object {
        const val LATEST_RELEASE = "https://api.github.com/repos/01annanogero-coder/ast-tube/releases/latest"

        private fun versionOf(apk: File) = apk.name.removePrefix("ASTTube-").removeSuffix(".apk")

        /** "1.2.10" > "1.2.9"; ignores anything after a "+" or "-". */
        fun newer(a: String, b: String): Boolean {
            val pa = a.split('+', '-')[0].split('.').map { it.toIntOrNull() ?: 0 }
            val pb = b.split('+', '-')[0].split('.').map { it.toIntOrNull() ?: 0 }
            for (i in 0 until maxOf(pa.size, pb.size)) {
                val x = pa.getOrElse(i) { 0 }
                val y = pb.getOrElse(i) { 0 }
                if (x != y) return x > y
            }
            return false
        }
    }
}

/** Android reports the install session here; it asks us to show the user its confirmation screen. */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -1) != PackageInstaller.STATUS_PENDING_USER_ACTION) return
        val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
        confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { context.startActivity(it) }
    }
}
