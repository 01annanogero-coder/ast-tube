package com.annan.asttube

import android.os.Handler
import android.os.Looper
import com.grack.nanojson.JsonArray
import com.grack.nanojson.JsonObject as NJsonObject
import com.grack.nanojson.JsonWriter
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.parser.Parser
import org.schabi.newpipe.extractor.Image
import org.schabi.newpipe.extractor.InfoItem
import org.schabi.newpipe.extractor.ListExtractor.InfoItemsPage
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.Page
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.channel.ChannelInfo
import org.schabi.newpipe.extractor.channel.ChannelInfoItem
import org.schabi.newpipe.extractor.channel.tabs.ChannelTabInfo
import org.schabi.newpipe.extractor.comments.CommentsInfo
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import org.schabi.newpipe.extractor.kiosk.KioskInfo
import org.schabi.newpipe.extractor.localization.ContentCountry
import org.schabi.newpipe.extractor.localization.Localization
import org.schabi.newpipe.extractor.playlist.PlaylistInfo
import org.schabi.newpipe.extractor.playlist.PlaylistInfoItem
import org.schabi.newpipe.extractor.search.SearchInfo
import org.schabi.newpipe.extractor.services.youtube.YoutubeParsingHelper
import org.schabi.newpipe.extractor.stream.Description
import org.schabi.newpipe.extractor.stream.StreamInfo
import org.schabi.newpipe.extractor.stream.StreamInfoItem
import org.schabi.newpipe.extractor.stream.StreamType
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Everything AST Tube knows about YouTube comes through here.
 *
 * NewPipeExtractor does the hard work (page parsing, signature/throttling
 * deobfuscation, stream URLs). This class runs its blocking calls on a small
 * thread pool and turns the results into the JSON shapes in docs/API.md, which
 * local_server.dart passes straight to the web UI.
 *
 * Pagination: NewPipe returns a Page object for "more results". We keep those
 * in memory under a short random token and hand the token to the UI as "next".
 */
class YouTube {
    private val main = Handler(Looper.getMainLooper())
    private val pool = Executors.newFixedThreadPool(4)
    private val yt = ServiceList.YouTube

    // token -> function that loads the next page. Oldest dropped first.
    private val pages = object : LinkedHashMap<String, () -> JSONObject>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, () -> JSONObject>?) = size > 300
    }

    init {
        val locale = Locale.getDefault()
        val country = locale.country.ifEmpty { "US" }
        NewPipe.init(OkDownloader, Localization(locale.language.ifEmpty { "en" }, country), ContentCountry(country))
    }

    /** Runs [work] off the main thread and reports back on it. */
    fun run(work: () -> Any, done: (String?, String?) -> Unit) {
        pool.execute {
            val (json, error) = try {
                work().toString() to null
            } catch (e: ReCaptchaException) {
                null to "YouTube asked for a captcha. Try again later."
            } catch (e: Throwable) {
                null to (e.message ?: e.javaClass.simpleName)
            }
            main.post { done(json, error) }
        }
    }

    fun destroy() = pool.shutdownNow()

    // ------------------------------------------------------------------ lists

    /** Curated YouTube lists. ids: trending_music, trending_gaming, trending_movies_and_shows, trending_podcasts_episodes, live */
    fun kiosk(id: String, next: String?): JSONObject {
        next?.let { return more(it) }
        val url = yt.kioskList.getListLinkHandlerFactoryByType(id).fromId(id).url
        val info = KioskInfo.getInfo(yt, url)
        return list(info.relatedItems, info.nextPage) { KioskInfo.getMoreItems(yt, url, it) }
    }

    fun search(query: String, filter: String, next: String?): JSONObject {
        next?.let { return more(it) }
        val filters = if (filter in setOf("videos", "channels", "playlists")) listOf(filter) else emptyList()
        val handler = yt.searchQHFactory.fromQuery(query, filters, "")
        val info = SearchInfo.getInfo(yt, handler)
        return list(info.relatedItems, info.nextPage) { SearchInfo.getMoreItems(yt, handler, it) }
            .put("corrected", if (info.isCorrectedSearch) info.searchSuggestion else JSONObject.NULL)
    }

    fun suggest(query: String): JSONArray = JSONArray(yt.suggestionExtractor.suggestionList(query))

    fun playlist(id: String, next: String?): JSONObject {
        next?.let { return more(it) }
        val url = "https://www.youtube.com/playlist?list=$id"
        val info = PlaylistInfo.getInfo(yt, url)
        return list(info.relatedItems, info.nextPage) { PlaylistInfo.getMoreItems(yt, url, it) }
            .put("id", id)
            .put("title", info.name)
            .put("channel", info.uploaderName ?: "")
            .put("count", info.streamCount)
            .put("thumb", best(info.thumbnails) ?: JSONObject.NULL)
    }

    /** A Mix (list=RD...). It keeps giving new pages, so the queue can go on and on. */
    fun mix(id: String, seed: String, next: String?): JSONObject {
        next?.let { return more(it) }
        val url = "https://www.youtube.com/watch?v=$seed&list=$id"
        val info = PlaylistInfo.getInfo(yt, url)
        return list(info.relatedItems, info.nextPage) { PlaylistInfo.getMoreItems(yt, url, it) }
            .put("id", id)
            .put("seed", seed)
            .put("title", info.name.replace(Regex("^Mix\\s*[–-]\\s*"), ""))
    }

    fun channel(id: String, tab: String, next: String?): JSONObject {
        next?.let { return more(it) }
        val info = ChannelInfo.getInfo(yt, channelUrl(id))
        val tabs = info.tabs.associateBy { tabName(it.contentFilters.firstOrNull()) }.filterKeys { it != null }
        val out = JSONObject()
            .put("id", id)
            .put("name", info.name)
            .put("handle", Regex("/(@[^/?]+)").find(info.url)?.groupValues?.get(1) ?: JSONObject.NULL)
            .put("avatar", best(info.avatars) ?: JSONObject.NULL)
            .put("banner", best(info.banners) ?: JSONObject.NULL)
            .put("subs", info.subscriberCount)
            .put("verified", info.isVerified)
            .put("description", info.description ?: "")
            .put("tabs", JSONArray(tabs.keys.toList()))
        val chosen = tabs[tab] ?: tabs.values.firstOrNull()
        out.put("tab", tabs.entries.firstOrNull { it.value === chosen }?.key ?: tab)
        if (chosen == null) return out.put("items", JSONArray()).put("next", JSONObject.NULL)
        val page = ChannelTabInfo.getInfo(yt, chosen)
        val listed = list(page.relatedItems, page.nextPage) { ChannelTabInfo.getMoreItems(yt, chosen, it) }
        // YouTube leaves avatars out of a channel's own video list; use the channel's.
        val items = listed.getJSONArray("items")
        for (i in 0 until items.length()) {
            val v = items.getJSONObject(i)
            if (v.optString("type") == "video" && v.isNull("channelAvatar")) v.put("channelAvatar", out.get("avatar"))
        }
        return out.put("items", items).put("next", listed.get("next"))
    }

    fun comments(videoId: String, next: String?): JSONObject {
        next?.let { return more(it) }
        val url = watchUrl(videoId)
        val info = CommentsInfo.getInfo(yt, url)
        return commentPage(info.relatedItems, info.nextPage, url)
            .put("disabled", info.isCommentsDisabled)
            .put("count", info.commentsCount)
    }

    private fun commentPage(items: List<org.schabi.newpipe.extractor.comments.CommentsInfoItem>, page: Page?, url: String): JSONObject {
        val arr = JSONArray()
        for (c in items) arr.put(JSONObject()
            .put("id", c.commentId ?: "")
            .put("author", c.uploaderName ?: "")
            .put("avatar", best(c.uploaderAvatars) ?: JSONObject.NULL)
            .put("text", text(c.commentText))
            .put("likes", c.likeCount)
            .put("published", c.textualUploadDate ?: JSONObject.NULL)
            .put("replies", c.replyCount)
            .put("pinned", c.isPinned)
            .put("byUploader", c.isChannelOwner))
        val token = if (page != null && Page.isValid(page)) remember {
            val more = CommentsInfo.getMoreItems(yt, url, page)
            commentPage(more.items, more.nextPage, url)
        } else null
        return JSONObject().put("items", arr).put("next", token ?: JSONObject.NULL)
    }

    // ------------------------------------------------------------------ video

    fun video(id: String): JSONObject {
        val s = StreamInfo.getInfo(yt, watchUrl(id))
        val live = s.streamType == StreamType.LIVE_STREAM || s.streamType == StreamType.AUDIO_LIVE_STREAM
        val sources = JSONArray()
        for (v in s.videoStreams.filter { it.isUrl }.sortedByDescending { it.height }) sources.put(JSONObject()
            .put("quality", v.resolution)
            .put("url", v.content)
            .put("mime", v.format?.mimeType ?: "video/mp4"))
        // Real captions first, then auto-generated. NewPipe hands out TTML, but YouTube's
        // timedtext endpoint serves WebVTT (what <track> understands) for fmt=vtt.
        val captions = JSONArray()
        s.subtitles.filter { it.isUrl }
            .sortedBy { it.isAutoGenerated }
            .distinctBy { it.languageTag + it.isAutoGenerated }
            .forEach { c ->
                val url = c.content.replace(Regex("([?&]fmt=)[^&]*"), "$1vtt").let { if (it.contains("fmt=")) it else "$it&fmt=vtt" }
                captions.put(JSONObject()
                    .put("lang", c.languageTag)
                    .put("label", c.displayLanguageName + if (c.isAutoGenerated) " (auto)" else "")
                    .put("url", url))
            }
        val chapters = JSONArray()
        for (seg in s.streamSegments) chapters.put(JSONObject().put("title", seg.title).put("start", seg.startTimeSeconds))
        return JSONObject()
            .put("id", id)
            .put("title", s.name)
            .put("description", text(s.description))
            .put("channel", JSONObject()
                .put("id", channelId(s.uploaderUrl) ?: JSONObject.NULL)
                .put("name", s.uploaderName ?: "")
                .put("avatar", best(s.uploaderAvatars) ?: JSONObject.NULL)
                .put("subs", s.uploaderSubscriberCount)
                .put("verified", s.isUploaderVerified))
            .put("views", s.viewCount)
            .put("likes", s.likeCount)
            .put("published", s.textualUploadDate ?: JSONObject.NULL)
            .put("uploadDate", s.uploadDate?.localDateTime?.toLocalDate()?.toString() ?: JSONObject.NULL)
            .put("duration", if (live) -1 else s.duration)
            .put("live", live)
            .put("short", s.url.contains("/shorts/"))
            .put("category", s.category ?: "") // YouTube's category ("Music", "Education"...): the topic for recommendations
            .put("thumb", best(s.thumbnails) ?: JSONObject.NULL)
            .put("hls", s.hlsUrl?.takeIf { it.isNotEmpty() } ?: JSONObject.NULL)
            // Audio only, for background play (Android's WebView pauses <video> in the background, not <audio>).
            // Best AAC/M4A in the original language.
            .put("audio", s.audioStreams
                .filter { it.isUrl && it.format?.mimeType == "audio/mp4" }
                .filter { it.audioTrackType == null || it.audioTrackType == org.schabi.newpipe.extractor.stream.AudioTrackType.ORIGINAL }
                .maxByOrNull { it.averageBitrate }?.content ?: JSONObject.NULL)
            .put("sources", sources)
            .put("captions", captions)
            .put("chapters", chapters)
            .put("related", items(s.relatedItems))
            .put("commentCount", -1)
    }

    // ------------------------------------------------------------------ shorts

    /**
     * NewPipe drops Shorts from search results, so this calls YouTube's search
     * with its "Shorts" filter directly and reads the shortsLockupViewModel items.
     */
    fun shorts(query: String, next: String?): JSONObject {
        next?.let { return more(it) }
        return shortsPage(JsonWriter.string(
            YoutubeParsingHelper.prepareDesktopJsonBuilder(NewPipe.getPreferredLocalization(), NewPipe.getPreferredContentCountry())
                .value("query", query)
                .value("params", "EgIQCQ%3D%3D") // search filter: Type = Shorts
                .done()))
    }

    private fun shortsPage(body: String): JSONObject {
        val res = YoutubeParsingHelper.getJsonPostResponse("search", body.toByteArray(StandardCharsets.UTF_8), NewPipe.getPreferredLocalization())
        val arr = JSONArray()
        val seen = HashSet<String>()
        var continuation: String? = null
        walk(res) { key, obj ->
            when (key) {
                "shortsLockupViewModel" -> {
                    val cmd = obj.getObject("onTap").getObject("innertubeCommand")
                    val vid = cmd.getObject("reelWatchEndpoint").getString("videoId")
                    if (vid != null && seen.add(vid)) {
                        val meta = obj.getObject("overlayMetadata")
                        val title = meta.getObject("primaryText").getString("content")
                            ?: obj.getString("accessibilityText", "").substringBeforeLast(", ").substringBeforeLast(" - play Short")
                        arr.put(JSONObject()
                            .put("type", "short")
                            .put("id", vid)
                            .put("title", title)
                            .put("thumb", "https://i.ytimg.com/vi/$vid/frame0.jpg")
                            .put("viewsText", meta.getObject("secondaryText").getString("content") ?: JSONObject.NULL))
                    }
                }
                "continuationCommand" -> obj.getString("token")?.let { continuation = it }
            }
        }
        val token = continuation?.let { c ->
            remember {
                shortsPage(JsonWriter.string(
                    YoutubeParsingHelper.prepareDesktopJsonBuilder(NewPipe.getPreferredLocalization(), NewPipe.getPreferredContentCountry())
                        .value("continuation", c)
                        .done()))
            }
        }
        return JSONObject().put("items", arr).put("next", token ?: JSONObject.NULL)
    }

    // ------------------------------------------------------------------ posts

    /**
     * A channel's Posts tab (text, images, polls, shared videos), page by page. NewPipe
     * doesn't read posts, so this asks YouTube's browse endpoint for the tab directly.
     */
    fun posts(channelId: String, next: String?): JSONObject {
        next?.let { return more(it) }
        // Posts are looked up by the channel's UC id; @handles are resolved first.
        val id = if (channelId.startsWith("UC")) channelId else ChannelInfo.getInfo(yt, channelUrl(channelId)).id
        val body = JsonWriter.string(
            YoutubeParsingHelper.prepareDesktopJsonBuilder(NewPipe.getPreferredLocalization(), NewPipe.getPreferredContentCountry())
                .value("browseId", id)
                .value("params", "Egdwb3N0c_IGBAoCSgA%3D") // the "Posts" tab
                .done())
        val res = YoutubeParsingHelper.getJsonPostResponse("browse", body.toByteArray(StandardCharsets.UTF_8), NewPipe.getPreferredLocalization())
        return postPage(res)
    }

    private fun postPage(root: Any): JSONObject {
        val arr = JSONArray()
        var continuation: String? = null
        walk(root) { key, obj ->
            when (key) {
                "postRenderer", "backstagePostRenderer" -> post(obj)?.let { arr.put(it) }
                "continuationCommand" -> obj.getString("token")?.let { continuation = it }
            }
        }
        val token = continuation?.let { c ->
            remember {
                val body = JsonWriter.string(
                    YoutubeParsingHelper.prepareDesktopJsonBuilder(NewPipe.getPreferredLocalization(), NewPipe.getPreferredContentCountry())
                        .value("continuation", c)
                        .done())
                postPage(YoutubeParsingHelper.getJsonPostResponse("browse", body.toByteArray(StandardCharsets.UTF_8), NewPipe.getPreferredLocalization()))
            }
        }
        return JSONObject().put("items", arr).put("next", token ?: JSONObject.NULL)
    }

    /** All photos of a multi-photo post, from its own page (params from a post's "detail"). */
    fun postImages(params: String): JSONArray {
        val body = JsonWriter.string(
            YoutubeParsingHelper.prepareDesktopJsonBuilder(NewPipe.getPreferredLocalization(), NewPipe.getPreferredContentCountry())
                .value("browseId", "FEpost_detail")
                .value("params", params)
                .done())
        val res = YoutubeParsingHelper.getJsonPostResponse("browse", body.toByteArray(StandardCharsets.UTF_8), NewPipe.getPreferredLocalization())
        var multi: NJsonObject? = null
        walk(res) { k, v -> if (k == "postMultiImageRenderer" && multi == null) multi = v }
        return multi?.let { postImageUrls(it) } ?: JSONArray()
    }

    /** Photo URLs in order, uncropped (YouTube's lists send square crops), at most 1080 px. */
    private fun postImageUrls(node: NJsonObject): JSONArray {
        val images = JSONArray()
        walk(node) { k, v ->
            if (k == "backstageImageRenderer") {
                v.getObject("image").getArray("thumbnails").lastOrNull()?.let { (it as NJsonObject).getString("url") }?.let { u ->
                    val full = if (u.startsWith("//")) "https:$u" else u
                    images.put(full.replace(Regex("=s\\d+(-c-fcrop64=[^-]*)?-"), "=s1080-"))
                }
            }
        }
        return images
    }

    private fun post(p: NJsonObject): JSONObject? {
        val postId = p.getString("postId") ?: return null
        fun runs(o: NJsonObject) = o.getArray("runs").joinToString("") { (it as? NJsonObject)?.getString("text") ?: "" }
            .ifEmpty { o.getString("simpleText") ?: "" }
        val att = p.getObject("backstageAttachment")
        // Images: one (backstageImageRenderer) or several (a carousel); keep their order.
        val images = postImageUrls(att)
        // In a channel's list a multi-photo post shows only its first photo (with a
        // "collection" icon); the rest are on the post's own page ([postImages]).
        var more = false
        walk(att) { k, v -> if (k == "backstageImageRenderer" && v.getObject("icon").getString("iconType") == "COLLECTIONS") more = true }
        var detail: String? = null
        walk(p.getObject("publishedTimeText")) { k, v -> if (k == "browseEndpoint" && v.getString("browseId") == "FEpost_detail") detail = v.getString("params") }
        val poll = att.getObject("pollRenderer").takeIf { it.isNotEmpty() }?.let { pr ->
            JSONObject()
                .put("choices", JSONArray(pr.getArray("choices").mapNotNull { (it as? NJsonObject)?.getObject("text")?.let(::runs) }))
                .put("votes", runs(pr.getObject("totalVotes")))
        }
        // A shared video: enough to show it as a small card that opens the video.
        val video = att.getObject("videoRenderer").takeIf { it.getString("videoId") != null }?.let { vr ->
            val vid = vr.getString("videoId")
            JSONObject()
                .put("type", "video")
                .put("id", vid)
                .put("title", runs(vr.getObject("title")))
                .put("channel", runs(vr.getObject("ownerText")))
                .put("thumb", "https://i.ytimg.com/vi/$vid/hqdefault.jpg")
                .put("duration", seconds(vr.getObject("lengthText").getString("simpleText")))
                .put("views", -1)
        }
        var comments = ""
        walk(p.getObject("actionButtons")) { k, v -> if (k == "replyButton") comments = comments.ifEmpty { runs(v.getObject("buttonRenderer").getObject("text")) } }
        val author = p.getObject("authorText")
        var channelId: String? = null
        walk(p.getObject("authorEndpoint")) { k, v -> if (k == "browseEndpoint") channelId = channelId ?: v.getString("browseId") }
        val avatar = p.getObject("authorThumbnail").getArray("thumbnails").lastOrNull()
            ?.let { (it as NJsonObject).getString("url") }?.let { if (it.startsWith("//")) "https:$it" else it }
        return JSONObject()
            .put("type", "post")
            .put("id", postId)
            .put("channel", runs(author))
            .put("channelId", channelId ?: JSONObject.NULL)
            .put("avatar", avatar ?: JSONObject.NULL)
            .put("text", runs(p.getObject("contentText")))
            .put("published", runs(p.getObject("publishedTimeText")))
            .put("likes", p.getObject("voteCount").getString("simpleText") ?: "")
            .put("comments", comments)
            .put("images", images)
            .put("more", more)
            .put("detail", detail ?: JSONObject.NULL)
            .put("poll", poll ?: JSONObject.NULL)
            .put("video", video ?: JSONObject.NULL)
    }

    // ------------------------------------------------------------------ up next (endless)

    /**
     * The "Up next" list below the player, page after page. NewPipe only gives the first
     * batch, so this asks YouTube's watch-next endpoint directly and reads its
     * lockupViewModel items (videos, playlists/courses, Mixes) and continuation token.
     */
    fun related(id: String, next: String?): JSONObject {
        next?.let { return more(it) }
        val body = JsonWriter.string(
            YoutubeParsingHelper.prepareDesktopJsonBuilder(NewPipe.getPreferredLocalization(), NewPipe.getPreferredContentCountry())
                .value("videoId", id)
                .value("contentCheckOk", true)
                .value("racyCheckOk", true)
                .done())
        val res = YoutubeParsingHelper.getJsonPostResponse("next", body.toByteArray(StandardCharsets.UTF_8), NewPipe.getPreferredLocalization())
        // Only the side column: the rest of the response has comment tokens we don't want.
        return relatedPage(res.getObject("contents").getObject("twoColumnWatchNextResults").getObject("secondaryResults"))
    }

    private fun relatedPage(root: Any): JSONObject {
        val arr = JSONArray()
        val seen = HashSet<String>()
        var continuation: String? = null
        walk(root) { key, obj ->
            when (key) {
                "lockupViewModel" -> lockup(obj)?.let { if (seen.add(it.getString("id"))) arr.put(it) }
                "continuationCommand" -> obj.getString("token")?.let { continuation = it }
            }
        }
        val token = continuation?.let { c ->
            remember {
                val body = JsonWriter.string(
                    YoutubeParsingHelper.prepareDesktopJsonBuilder(NewPipe.getPreferredLocalization(), NewPipe.getPreferredContentCountry())
                        .value("continuation", c)
                        .done())
                val res = YoutubeParsingHelper.getJsonPostResponse("next", body.toByteArray(StandardCharsets.UTF_8), NewPipe.getPreferredLocalization())
                relatedPage(res.getArray("onResponseReceivedEndpoints"))
            }
        }
        return JSONObject().put("items", arr).put("next", token ?: JSONObject.NULL)
    }

    /** One item of YouTube's newer "lockup" format, in our item shapes. */
    private fun lockup(o: NJsonObject): JSONObject? {
        val cid = o.getString("contentId") ?: return null
        val type = o.getString("contentType") ?: ""
        val meta = o.getObject("metadata").getObject("lockupMetadataViewModel")
        val title = meta.getObject("title").getString("content") ?: return null
        val rows = meta.getObject("metadata").getObject("contentMetadataViewModel").getArray("metadataRows")
        val text = rows.map { r -> (r as? NJsonObject)?.getArray("metadataParts")?.map { p -> (p as? NJsonObject)?.getObject("text")?.getString("content") ?: "" } ?: emptyList() }
        val avatar = meta.getObject("image").getObject("decoratedAvatarViewModel").getObject("avatar")
            .getObject("avatarViewModel").getObject("image").getArray("sources").lastOrNull()
            ?.let { (it as NJsonObject).getString("url") }
        var channelId: String? = null
        var badge: String? = null
        var seed: String? = null
        walk(meta.getObject("image")) { k, v -> if (k == "browseEndpoint") channelId = channelId ?: v.getString("browseId") }
        walk(o.getObject("contentImage")) { k, v -> if (k == "thumbnailBadgeViewModel") badge = badge ?: v.getString("text") }
        walk(o.getObject("rendererContext")) { k, v -> if (k == "watchEndpoint") seed = seed ?: v.getString("videoId") }
        val channel = text.getOrNull(0)?.getOrNull(0) ?: ""
        return when {
            type == "LOCKUP_CONTENT_TYPE_VIDEO" -> {
                val live = badge.equals("LIVE", ignoreCase = true)
                JSONObject()
                    .put("type", "video")
                    .put("id", cid)
                    .put("title", title)
                    .put("channel", channel)
                    .put("channelId", channelId ?: JSONObject.NULL)
                    .put("channelAvatar", avatar ?: JSONObject.NULL)
                    .put("verified", false)
                    .put("thumb", "https://i.ytimg.com/vi/$cid/hqdefault.jpg")
                    .put("duration", if (live) -1 else seconds(badge))
                    .put("views", count(text.getOrNull(1)?.getOrNull(0)))
                    .put("published", text.getOrNull(1)?.getOrNull(1)?.takeIf { it.isNotEmpty() } ?: JSONObject.NULL)
                    .put("live", live)
                    .put("short", false)
            }
            cid.startsWith("RD") -> {
                val s = seed ?: cid.removePrefix("RD").takeIf { it.length == 11 } ?: return null
                JSONObject()
                    .put("type", "mix")
                    .put("id", cid)
                    .put("seed", s)
                    .put("title", title.replace(Regex("^Mix\\s*[–-]\\s*"), ""))
                    .put("subtitle", channel)
                    .put("thumb", "https://i.ytimg.com/vi/$s/hqdefault.jpg")
            }
            type == "LOCKUP_CONTENT_TYPE_PLAYLIST" || type == "LOCKUP_CONTENT_TYPE_COURSE" -> {
                var thumb: String? = null
                walk(o.getObject("contentImage")) { k, v -> if (k == "image" && thumb == null) thumb = (v.getArray("sources").lastOrNull() as? NJsonObject)?.getString("url") }
                JSONObject()
                    .put("type", "playlist")
                    .put("id", cid)
                    .put("title", title)
                    .put("channel", channel)
                    .put("thumb", thumb ?: seed?.let { "https://i.ytimg.com/vi/$it/hqdefault.jpg" } ?: JSONObject.NULL)
                    .put("count", Regex("(\\d[\\d,]*)").find(badge ?: "")?.groupValues?.get(1)?.replace(",", "")?.toLongOrNull() ?: -1)
            }
            else -> null
        }
    }

    private fun seconds(t: String?): Long =
        t?.takeIf { Regex("^\\d+(:\\d+)+$").matches(it) }?.split(":")?.fold(0L) { a, p -> a * 60 + p.toLong() } ?: 0

    /** "4.5M" -> 4500000, "823" -> 823, unknown -> -1 */
    private fun count(t: String?): Long {
        val m = Regex("([\\d.,]+)\\s*([KMB])?", RegexOption.IGNORE_CASE).find(t ?: "") ?: return -1
        val n = m.groupValues[1].replace(",", "").toDoubleOrNull() ?: return -1
        val mult = when (m.groupValues[2].uppercase()) { "K" -> 1e3; "M" -> 1e6; "B" -> 1e9; else -> 1.0 }
        return (n * mult).toLong()
    }

    private fun walk(node: Any?, visit: (String, NJsonObject) -> Unit) {
        when (node) {
            is NJsonObject -> for ((k, v) in node) {
                if (v is NJsonObject) visit(k, v)
                walk(v, visit)
            }
            is JsonArray -> for (v in node) walk(v, visit)
        }
    }

    // ------------------------------------------------------------------ helpers

    private fun <T : InfoItem> list(items: List<T>, page: Page?, more: (Page) -> InfoItemsPage<out InfoItem>): JSONObject {
        val token = if (page != null && Page.isValid(page)) remember {
            val p = more(page)
            list(p.items, p.nextPage, more)
        } else null
        return JSONObject().put("items", items(items)).put("next", token ?: JSONObject.NULL)
    }

    private fun more(token: String): JSONObject {
        val load = synchronized(pages) { pages[token] } ?: return JSONObject().put("items", JSONArray()).put("next", JSONObject.NULL)
        return load()
    }

    private fun remember(load: () -> JSONObject): String {
        val token = UUID.randomUUID().toString().substring(0, 13)
        synchronized(pages) { pages[token] = load }
        return token
    }

    private fun items(list: List<InfoItem>): JSONArray {
        val arr = JSONArray()
        for (item in list) item(item)?.let { arr.put(it) }
        return arr
    }

    private fun item(i: InfoItem): JSONObject? = when (i) {
        is StreamInfoItem -> {
            val id = videoId(i.url) ?: return null
            if (i.isShortFormContent || i.url.contains("/shorts/")) JSONObject()
                .put("type", "short")
                .put("id", id)
                .put("title", i.name)
                .put("thumb", "https://i.ytimg.com/vi/$id/frame0.jpg")
                .put("viewsText", if (i.viewCount >= 0) "${compact(i.viewCount)} views" else JSONObject.NULL)
            else {
                val live = i.streamType == StreamType.LIVE_STREAM || i.streamType == StreamType.AUDIO_LIVE_STREAM
                JSONObject()
                    .put("type", "video")
                    .put("id", id)
                    .put("title", i.name)
                    .put("channel", i.uploaderName ?: "")
                    .put("channelId", channelId(i.uploaderUrl) ?: JSONObject.NULL)
                    .put("channelAvatar", best(i.uploaderAvatars) ?: JSONObject.NULL)
                    .put("verified", i.isUploaderVerified)
                    .put("thumb", "https://i.ytimg.com/vi/$id/hqdefault.jpg")
                    .put("duration", if (live) -1 else i.duration)
                    .put("views", i.viewCount)
                    .put("published", i.textualUploadDate ?: JSONObject.NULL)
                    .put("live", live)
                    .put("short", false)
            }
        }
        is ChannelInfoItem -> JSONObject()
            .put("type", "channel")
            .put("id", channelId(i.url) ?: return null)
            .put("name", i.name)
            .put("avatar", best(i.thumbnails) ?: JSONObject.NULL)
            .put("subs", i.subscriberCount)
            .put("verified", i.isVerified)
            .put("description", i.description ?: "")
        // YouTube "Mix": an endless auto-generated playlist (list=RD...) built around a seed video.
        is PlaylistInfoItem if i.playlistType != PlaylistInfo.PlaylistType.NORMAL -> {
            val list = Regex("[?&]list=([\\w-]+)").find(i.url)?.groupValues?.get(1) ?: return null
            val seed = videoId(i.url) ?: list.removePrefix("RD").takeIf { it.length == 11 } ?: return null
            JSONObject()
                .put("type", "mix")
                .put("id", list)
                .put("seed", seed)
                .put("title", i.name.replace(Regex("^Mix\\s*[–-]\\s*"), ""))
                .put("subtitle", i.uploaderName ?: "")
                .put("thumb", "https://i.ytimg.com/vi/$seed/hqdefault.jpg")
        }
        is PlaylistInfoItem -> JSONObject()
            .put("type", "playlist")
            .put("id", Regex("[?&]list=([\\w-]+)").find(i.url)?.groupValues?.get(1) ?: return null)
            .put("title", i.name)
            .put("channel", i.uploaderName ?: "")
            .put("thumb", best(i.thumbnails) ?: JSONObject.NULL)
            .put("count", i.streamCount)
        else -> null
    }

    private fun text(d: Description?): String {
        if (d == null) return ""
        if (d.type != Description.HTML) return d.content ?: ""
        val withBreaks = (d.content ?: "").replace(Regex("(?i)<br\\s*/?>"), "\n").replace(Regex("<[^>]+>"), "")
        return Parser.unescapeEntities(withBreaks, false)
    }

    companion object {
        fun watchUrl(id: String) = "https://www.youtube.com/watch?v=$id"

        fun channelUrl(id: String) = when {
            id.startsWith("@") -> "https://www.youtube.com/$id"
            else -> "https://www.youtube.com/channel/$id"
        }

        fun videoId(url: String?): String? =
            url?.let { Regex("(?:v=|/shorts/|youtu\\.be/|/live/|/embed/)([\\w-]{11})").find(it)?.groupValues?.get(1) }

        fun channelId(url: String?): String? = url?.let {
            Regex("/channel/(UC[\\w-]{22})").find(it)?.groupValues?.get(1)
                ?: Regex("/(@[^/?#]+)").find(it)?.groupValues?.get(1)
        }

        /** The largest image that is still a sensible size for a phone. */
        fun best(images: List<Image>?): String? {
            if (images.isNullOrEmpty()) return null
            val sized = images.filter { it.width in 1..1280 }
            val pick = (sized.ifEmpty { images }).maxByOrNull { it.width }
            return pick?.url?.let { if (it.startsWith("//")) "https:$it" else it }
        }

        fun compact(n: Long): String = when {
            n >= 1_000_000_000 -> String.format(Locale.US, "%.1fB", n / 1e9).replace(".0B", "B")
            n >= 1_000_000 -> String.format(Locale.US, "%.1fM", n / 1e6).replace(".0M", "M")
            n >= 1_000 -> String.format(Locale.US, "%.1fK", n / 1e3).replace(".0K", "K")
            else -> n.toString()
        }

        private fun tabName(filter: String?) = when (filter) {
            "videos" -> "videos"
            "shorts" -> "shorts"
            "livestreams" -> "live"
            "playlists" -> "playlists"
            else -> null
        }
    }
}

/** NewPipe's network layer, backed by OkHttp. */
object OkDownloader : Downloader() {
    private const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0"
    private val client = OkHttpClient.Builder().readTimeout(30, TimeUnit.SECONDS).build()

    override fun execute(request: Request): Response {
        val body = request.dataToSend()?.toRequestBody()
        val builder = okhttp3.Request.Builder()
            .url(request.url())
            .method(request.httpMethod(), body)
            .header("User-Agent", UA)
        for ((name, values) in request.headers()) {
            builder.removeHeader(name)
            for (v in values) builder.addHeader(name, v)
        }
        client.newCall(builder.build()).execute().use { res ->
            if (res.code == 429) throw ReCaptchaException("reCaptcha Challenge requested", request.url())
            return Response(res.code, res.message, res.headers.toMultimap(), res.body?.string(), res.request.url.toString())
        }
    }
}
