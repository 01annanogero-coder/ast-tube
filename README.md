<h1 align="center">AST Tube</h1>

<p align="center">A watch-only YouTube app for Android: no account, no ads, no tracking.</p>

AST Tube looks and works like the YouTube app you know (Home feed, Shorts, search,
channels, playlists, comments) in its own purple and blue design. You can't sign in,
upload, like or subscribe. The only thing the app stores is your **watch history**,
and only on your phone. That history is also what Home is built from.

> [!IMPORTANT]
> **AST Tube owns none of the content it shows.** Every video, title, thumbnail and
> comment belongs to its creators and rights holders on YouTube. AST Tube is not
> affiliated with or endorsed by YouTube or Google. Third-party YouTube clients are
> against YouTube's Terms of Service, so AST Tube is shared as an APK, not through
> the Play Store. To support creators, watch on **[youtube.com](https://www.youtube.com)**;
> every video has an "Open on YouTube" button.

## Download

Get the latest APK from **[Releases](https://github.com/01annanogero-coder/ast-tube/releases/latest)** (Android 7.0+).

Open the APK on your phone. The first time, Android asks you to allow installing apps
from your browser or file manager.

## Automatic updates

AST Tube checks this repository's latest release each time it starts. A newer version
downloads quietly in the background (on Wi-Fi only, to save mobile data). On the next
launch Android's installer opens and you tap **Update**. The first time, Android asks
you to allow AST Tube to install apps.

## Features

| | |
| --- | --- |
| **Home** | Built from the related videos of what you watched, like signed-out YouTube, with Mix cards and a Shorts shelf. On first launch (no history yet) it shows YouTube's curated Music, Gaming, Movies and Live lists. |
| **Mix** | YouTube's endless music playlists. Start one from a Mix card or the Mix button on any video. The queue has shuffle and keeps loading new songs. |
| **Series and playlists** | Courses like Blender Guru's Donut tutorial play in order with a queue ("3 / 14"), Play all and Shuffle, moving to the next episode on their own. |
| **Pull to refresh** | Pull down on Home, the chips or search results for fresh results. |
| **Endless scrolling** | Home, the chips and "Up next" under the player never end: after the history-based feed they continue with searches around what you watch. Pages load well before you reach the bottom. |
| **Watch progress** | A progress bar under every thumbnail you've started, like YouTube's red line. |
| **Chips** | Music, Gaming, Movies, Podcasts, Live: YouTube's own curated lists. |
| **Player** | Adaptive quality up to 1080p (HLS), quality/speed/captions menus, double-tap to seek 10 s, fullscreen in landscape, chapters, resume where you stopped, autoplay switch. |
| **Mini player** | Go back while a video plays and it shrinks into a small window. Drag it anywhere and it snaps to the nearest corner; tap to open it again. |
| **Background play** | Keeps playing when you leave the app or lock the screen, with a media notification and lock-screen controls (previous, play/pause, next). Can be turned off in Settings. |
| **Shorts** | Full-screen vertical feed: swipe up for the next one. The next Shorts buffer ahead of time, so they start at once. Topics come from the channels you watch. |
| **Search** | Suggestions as you type, filters for videos, channels and playlists. |
| **Channels and playlists** | Videos, Shorts, Live and Playlists tabs. |
| **Comments** | Read-only, with clickable timestamps. |
| **Downloads** | "Download" under any video (or in its ⋮ menu): pick 240p–1080p, each with its size. Saved inside the app on this phone, never in your Downloads folder. Plays without internet, including in the background, with captions. Settings › Downloads lists them with progress. |
| **Offline Shorts** | Shorts you watch (and the next few) are kept in a 300 MB rolling cache, oldest removed first. Without internet the app opens straight to them. |
| **Settings** | Watch history (grouped by day, swipe to remove, Clear all), Autoplay, Background play, preferred quality. |
| **Navigation** | Bottom bar: Home, Shorts, Search, Settings. |

## How it works

Everything runs on the phone. There is no AST Tube server.

| Job | Where |
| --- | --- |
| Talking to YouTube: search, videos, stream URLs, channels, comments | [NewPipeExtractor](https://github.com/TeamNewPipe/NewPipeExtractor), wrapped by [YouTube.kt](app/android/app/src/main/kotlin/com/annan/asttube/YouTube.kt) |
| Shorts feed (NewPipe skips Shorts in search) | YouTube's search with its Shorts filter, also in `YouTube.kt` |
| Local web server for the UI and `/api/...` | [local_server.dart](app/lib/local_server.dart) on `127.0.0.1:8765`. It also builds Home, stores history and proxies HLS and captions. |
| The UI | Plain HTML/CSS/JS in [app/assets/web/](app/assets/web/), plus [hls.js](https://github.com/video-dev/hls.js) |
| What you see | A full-screen WebView in the Flutter app ([main.dart](app/lib/main.dart)) |
| Offline | [offline.dart](app/lib/offline.dart) saves one quality + the original audio of a video's HLS stream (every segment, playlists rewritten to local files) into private storage: `offline/` for downloads, `cache/shorts/` for the rolling Shorts cache. The local server plays saved copies whenever they exist. Android's connectivity state (not the WebView's `navigator.onLine`, which always says online) switches the app to offline mode. |
| Updates | [Updater.kt](app/android/app/src/main/kotlin/com/annan/asttube/Updater.kt) checks the latest GitHub release, downloads a newer APK in the background on Wi-Fi (size and SHA-256 checked), and hands it to Android's installer on the next launch. |
| Background play | Android's WebView pauses `<video>` in the background but not `<audio>`, so the page hands over to the audio-only stream when you leave and back to the video when you return ([watch.js](app/assets/web/js/watch.js)). [MediaService.kt](app/android/app/src/main/kotlin/com/annan/asttube/MediaService.kt) keeps the app alive and shows the media notification. |

The API between the UI and the server is documented in [docs/API.md](docs/API.md).

## Build from source

Needs Flutter 3.47+ and the Android SDK.

```sh
cd app
flutter build apk --release
# -> app/build/app/outputs/flutter-apk/app-release.apk
```

### Debugging on a phone

```sh
adb forward tcp:8765 tcp:8765          # call the app's API from your PC: curl localhost:8765/api/home
adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof com.annan.asttube)
node dev/cdp.mjs "location.hash"       # run JS inside the app's WebView (debug builds)
```

## Publishing a new version

1. Raise the version in `app/pubspec.yaml` (e.g. `1.1.0+2`).
2. Run `scripts/release.sh --publish` (Git Bash). It builds the APK, signs it, checks the
   signatures, backs it up and attaches `ASTTube-1.1.0.apk` to the GitHub release `v1.1.0`.
   Installed apps pick it up through the automatic updater.

**Signing.** Android only installs an update signed with the same key as the installed app.
Version 1.0.0 was signed with a debug key; later versions use a release key with
[key rotation](https://source.android.com/docs/security/features/apksigning/v3#key-rotation):
`release.sh` signs with both, so every existing install keeps updating. Never upload an APK
that didn't go through `release.sh`. The keys and their passwords are not in this repository
(`app/android/key.properties` is git-ignored); they are backed up offline.

## License

GPL-3.0. AST Tube uses NewPipeExtractor, which is GPL-3.0.
