# AST Tube local API

The app runs a small HTTP server on the phone (`http://127.0.0.1:8765`). It serves the
web UI from `app/assets/web/` and answers the JSON endpoints below. The UI must use
**relative URLs** (`/api/...`) so it works on the phone and on the dev mock server.

All responses are JSON unless noted. Errors: HTTP 4xx/5xx with `{"error": "...", "detail": "..."}`.

Pagination: list endpoints return `"next"`: an opaque string, or `null` when there is
no more. Pass it back as `?next=<value>` (URL-encoded) to get the following page.

## Item shapes

```jsonc
// VideoItem
{
  "type": "video",
  "id": "dQw4w9WgXcQ",              // 11-char YouTube id
  "title": "Video title",
  "channel": "Channel name",
  "channelId": "UCxxxx",             // may be null
  "channelAvatar": "https://...",    // may be null
  "verified": false,
  "thumb": "https://i.ytimg.com/vi/<id>/hqdefault.jpg",
  "duration": 235,                   // seconds; -1 = live; 0 = unknown
  "views": 52431435,                 // -1 = unknown
  "published": "2 years ago",        // text as YouTube shows it; may be null
  "live": false,
  "short": false                     // true for Shorts
}

// ShortItem (Shorts feed / Shorts shelf)
{
  "type": "short",
  "id": "d99vrWc2m7E",
  "title": "Try Not To Smile 494",
  "thumb": "https://i.ytimg.com/vi/<id>/frame0.jpg",  // portrait 9:16
  "viewsText": "4.3M views"          // may be null
}

// ChannelItem
{ "type": "channel", "id": "UCxxxx", "name": "Alikiba", "avatar": "https://...",
  "subs": 2630000, "verified": true, "description": "..." }

// MixItem: YouTube "Mix", an endless auto-generated playlist around a seed video.
// Open it as #/watch/<seed>?list=<id>.
{ "type": "mix", "id": "RDsJXZ9Dok7u8", "seed": "sJXZ9Dok7u8",
  "title": "Alan Walker - Diamond Heart", "subtitle": "Alan Walker, Sophia Somajo and more",
  "thumb": "https://i.ytimg.com/vi/<seed>/hqdefault.jpg" }

// PlaylistItem
{ "type": "playlist", "id": "PLxxxx", "title": "...", "channel": "...",
  "thumb": "https://...", "count": 25 }
```

## Endpoints

### `GET /api/home?next=`
The Home feed. Built from the related videos of the local watch history; on first
launch (empty history) it falls back to YouTube's curated lists.
```jsonc
{ "items": [VideoItem | MixItem ...], "shorts": [ShortItem...], "next": "..." | null }
```
`shorts` is only filled on the first page (UI shows it as the "Shorts" shelf after the
first video, like YouTube). Later pages return `"shorts": []`.

### `GET /api/feed/<chip>?next=`
Chip feeds shown under the header. `<chip>` is one of:
`music`, `gaming`, `movies`, `podcasts`, `live`.
```jsonc
{ "items": [VideoItem...], "next": "..." | null }
```

### `GET /api/search?q=<text>&filter=<all|videos|channels|playlists>&next=`
```jsonc
{ "items": [VideoItem | ChannelItem | PlaylistItem ...], "next": "..." | null,
  "corrected": "did you mean text" | null }
```

### `GET /api/suggest?q=<text>`
Search-box autocomplete. Returns `["alikiba", "alikiba songs", ...]`.

### `GET /api/video/<id>`
Everything the watch page needs.
```jsonc
{
  "id": "...", "title": "...", "description": "plain text with \n newlines",
  "channel": { "id": "UCxxxx", "name": "...", "avatar": "https://...", "subs": 2630000, "verified": true },
  "views": 52431435, "likes": 310000,          // -1 = hidden/unknown
  "published": "2 years ago", "uploadDate": "2023-10-04",   // either may be null
  "duration": 235, "live": false, "short": false,
  "thumb": "https://...maxresdefault.jpg",
  "hls": "/api/hls?u=...",      // adaptive stream (144p..1080p); play with hls.js. May be null.
  "audio": "https://...",       // audio-only M4A, used for background play. May be null.
  "sources": [                   // progressive MP4 with audio (usually only 360p). Fallback when hls is null or fails.
    { "quality": "360p", "url": "https://...", "mime": "video/mp4" }
  ],
  "captions": [ { "lang": "en", "label": "English", "url": "/api/captions?u=..." } ],  // WebVTT
  "chapters": [ { "title": "Intro", "start": 0 } ],
  "related": [VideoItem...],
  "commentCount": 1234           // -1 = unknown / disabled
}
```

### `GET /api/related/<videoId>?next=`
More of "Up next" after the `related` list in `/api/video`. Never ends: YouTube's own
watch-next pages first, then searches on the video's topic and channel. Every other page
also has Shorts on the same topic for a shelf.
```jsonc
{ "items": [VideoItem | MixItem | PlaylistItem ...], "shorts": [ShortItem...], "next": "..." }
```

### `GET /api/comments/<videoId>?next=`
```jsonc
{ "items": [ { "id": "...", "author": "@name", "avatar": "https://...", "text": "...",
               "likes": 12, "published": "3 days ago", "replies": 4, "pinned": false,
               "byUploader": false } ],
  "next": "..." | null, "disabled": false }
```

### `GET /api/channel/<channelId>?tab=<videos|shorts|live|playlists>&next=`
```jsonc
{ "id": "UCxxxx", "name": "...", "handle": "@name" | null, "avatar": "...", "banner": "..." | null,
  "subs": 2630000, "verified": true, "description": "...",
  "tabs": ["videos", "shorts", "live", "playlists"],    // tabs this channel actually has
  "tab": "videos",
  "items": [VideoItem | ShortItem | PlaylistItem ...], "next": "..." | null }
```

### `GET /api/playlist/<playlistId>?next=`
```jsonc
{ "id": "...", "title": "...", "channel": "...", "count": 25, "thumb": "...",
  "items": [VideoItem...], "next": "..." | null }
```

### `GET /api/mix/<mixId>?seed=<videoId>&next=`
One page of a Mix. Mixes keep returning new pages; the UI also starts a fresh Mix from a
recent song when one runs out, so the queue never ends.
```jsonc
{ "id": "RD...", "seed": "...", "title": "...", "items": [VideoItem...], "next": "..." | null }
```

### `GET /api/settings`, `POST /api/settings`
App preferences (not user data), kept in settings.json so the native side can read them.
`{ "autoplay": true, "background": true, "quality": "auto" | "1080" | "720" | "480" | "360" | "240" }`.
POST any subset of keys; returns the full object.

### `GET /api/shorts?next=`
The vertical Shorts feed (swipe up/down). Each item is a ShortItem; to play one the UI
calls `GET /api/video/<id>` and uses its `hls`/`sources` like any video.
```jsonc
{ "items": [ShortItem...], "next": "..." | null }
```

### Watch history (stored on the phone; the only user data the app keeps)
- `GET /api/history` → `{ "items": [ { ...VideoItem, "watchedAt": 1759600000000, "position": 42 } ] }`, newest first.
- `POST /api/history` with body `{ "video": VideoItem, "position": 42 }` → `{ "ok": true }`.
  Call it when a video starts and every ~15 s while playing (updates `position`, moves it to the top).
- `DELETE /api/history/<id>` → remove one. `DELETE /api/history` → clear all.

### Offline
- `GET /api/net` → `{ "online": true }` (from Android). While offline, network-only endpoints answer `503 { "offline": true }` at once.
- `GET /api/offline` → `{ downloads: [{ id, item, height, status: queued|downloading|done|failed, progress, bytes, error }], downloadsBytes, shorts: { count, bytes, limit } }`
- `GET /api/offline/<id>` → download status, or `{ options: [{ height, bytes }] }` to choose a quality.
- `POST /api/offline/<id>` `{ height, video: VideoItem }` → start. `POST /api/offline/<id>/retry`. `DELETE /api/offline/<id>` → cancel/delete.
- `GET /api/offline/shorts` → saved Shorts as ShortItems. `POST /api/offline/shorts` `{ items: [ShortItem] }` → save these. `DELETE /api/offline/shorts` → clear.
- Saved files are served from `/offline/<id>/...` and `/cache/shorts/<id>/...` (Range supported). `/api/video/<id>` returns these local URLs whenever a saved copy exists, online or not.

### Recommendations
- `GET /api/blocklist` → `{ videos: [id], channels: [{ id, name }] }`. `POST {"video": {"id"}}` or `{"channel": {"id", "name"}}` adds; `DELETE ?video=<id>` / `?channel=<id>` removes one, no query clears all. Blocked items never appear in Home, chips, Up next, related videos or Shorts (search is not filtered).
- `GET /api/taste` → what Home is currently based on: `{ seeds, topics, channels, shortChannels }` (read-only, for checking).
- History entries also keep `maxPosition` (furthest point reached; for Shorts, total seconds watched) and `category`. Limits: 120 videos, 200 Shorts; `DELETE /api/history?type=short|video` clears one kind.

### Streaming helpers (used through URLs the API already returns; the UI never builds these)
- `GET /api/hls?u=<url>`: proxied HLS playlist or segment.
- `GET /api/captions?u=<url>`: proxied caption track as WebVTT.
