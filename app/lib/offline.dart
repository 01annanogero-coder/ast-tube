// Offline viewing. Two separate stores in the app's private storage:
//
//   offline/<id>/        Downloads the user asked for. Kept until they delete them.
//   cache/shorts/<id>/   A rolling cache of Shorts (watched + the next few), so the
//                        Shorts tab still plays without internet. Oldest go first
//                        once it passes its size limit.
//
// A saved video is a small local HLS stream: one picture quality + the original
// audio track, every segment downloaded and the playlists rewritten to point at
// the local files. The same player plays it, served by local_server.dart from
// /offline/... and /cache/shorts/.... Downloads also keep an audio-only .m4a for
// background play, the thumbnail, channel avatar and captions.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

/// Loads a video's raw details (as YouTube.kt returns them, with real stream URLs).
typedef DetailsLoader = Future<Map<String, dynamic>> Function(String id);

class Offline {
  Offline._(this._root, this._details);

  static const shortsCacheLimit = 300 * 1024 * 1024; // chosen by Annan, 2026-10-04
  static const _shortHeight = 480;

  final Directory _root;
  final DetailsLoader _details;
  final _http = HttpClient()
    ..userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'
    ..connectionTimeout = const Duration(seconds: 15);

  /// id -> record: {id, item, height, status, done, total, bytes, error, addedAt}
  /// status: queued | downloading | done | failed
  final downloads = <String, Map<String, dynamic>>{};

  /// id -> record: {id, item, status, bytes, usedAt}
  final shorts = <String, Map<String, dynamic>>{};

  final _cancelled = <String>{};
  bool _downloading = false, _caching = false;
  final _shortQueue = <Map<String, dynamic>>[];

  Directory get _downloadsDir => Directory('${_root.path}/offline');
  Directory get _shortsDir => Directory('${_root.path}/cache/shorts');
  File get _downloadsIndex => File('${_root.path}/offline/index.json');
  File get _shortsIndex => File('${_root.path}/cache/shorts/index.json');

  static Future<Offline> open(Directory root, DetailsLoader details) async {
    final o = Offline._(root, details);
    await o._downloadsDir.create(recursive: true);
    await o._shortsDir.create(recursive: true);
    try {
      for (final r in jsonDecode(await o._downloadsIndex.readAsString()) as List) {
        o.downloads[r['id'] as String] = (r as Map).cast<String, dynamic>();
      }
    } catch (_) {}
    try {
      for (final r in jsonDecode(await o._shortsIndex.readAsString()) as List) {
        if (r['status'] == 'done') o.shorts[r['id'] as String] = (r as Map).cast<String, dynamic>();
      }
    } catch (_) {}
    // Downloads cut off last time (app closed) carry on where they stopped.
    for (final d in o.downloads.values) {
      if (d['status'] == 'downloading') d['status'] = 'queued';
    }
    o._runDownloads();
    return o;
  }

  // ------------------------------------------------------------------ queries

  /// Local details for a downloaded video or cached Short, with stream URLs pointing at the files.
  Future<Map<String, dynamic>?> localDetails(String id) async {
    final d = downloads[id];
    if (d != null && d['status'] == 'done') return _readMeta('/offline/$id', Directory('${_downloadsDir.path}/$id'));
    final s = shorts[id];
    if (s != null) {
      s['usedAt'] = DateTime.now().millisecondsSinceEpoch;
      return _readMeta('/cache/shorts/$id', Directory('${_shortsDir.path}/$id'));
    }
    return null;
  }

  Future<Map<String, dynamic>?> _readMeta(String base, Directory dir) async {
    try {
      final m = (jsonDecode(await File('${dir.path}/meta.json').readAsString()) as Map).cast<String, dynamic>();
      final channel = Map<String, dynamic>.from(m['channel'] as Map);
      if (await File('${dir.path}/avatar.jpg').exists()) channel['avatar'] = '$base/avatar.jpg';
      return {
        ...m,
        'channel': channel,
        'hls': '$base/master.m3u8',
        'sources': [],
        'audio': await File('${dir.path}/audio.m4a').exists() ? '$base/audio.m4a' : null,
        'thumb': '$base/thumb.jpg',
        'captions': [
          for (final c in (m['captions'] as List? ?? [])) {...c as Map, 'url': '$base/${c['file']}'},
        ],
        'offline': true,
      };
    } catch (_) {
      return null;
    }
  }

  /// Quality choices for the download sheet, with estimated sizes.
  Future<Map<String, dynamic>> options(String id) async {
    final rec = downloads[id];
    final v = await _details(id);
    final hls = v['hls'] as String?;
    if (hls == null) return {'status': rec?['status'], 'options': [], 'error': 'This video can\'t be downloaded (live or no stream).'};
    final master = await _getText(Uri.parse(hls));
    final duration = (v['duration'] as num?)?.toDouble() ?? 0;
    final byHeight = <int, int>{};
    for (final s in _variants(master.text, master.url)) {
      if (!s.avc) continue;
      byHeight[s.height] = max(byHeight[s.height] ?? 0, s.bandwidth);
    }
    final heights = byHeight.keys.where((h) => h >= 240).toList()..sort();
    return {
      'status': rec?['status'],
      'options': [
        for (final h in heights) {'height': h, 'bytes': (byHeight[h]! * duration / 8).round() + (128000 * duration / 8).round()},
      ],
    };
  }

  int get downloadsBytes => downloads.values.fold(0, (a, d) => a + ((d['bytes'] as num?)?.toInt() ?? 0));
  int get shortsBytes => shorts.values.fold(0, (a, s) => a + ((s['bytes'] as num?)?.toInt() ?? 0));

  List<Map<String, dynamic>> cachedShortItems() {
    final list = shorts.values.toList()..sort((a, b) => (b['usedAt'] as int).compareTo(a['usedAt'] as int));
    return [
      for (final s in list) {...(s['item'] as Map).cast<String, dynamic>(), 'thumb': '/cache/shorts/${s['id']}/thumb.jpg'},
    ];
  }

  /// The file behind /offline/... or /cache/shorts/..., or null.
  File? file(String path) {
    if (path.contains('..')) return null;
    if (path.startsWith('/offline/')) return File('${_downloadsDir.path}/${path.substring(9)}');
    if (path.startsWith('/cache/shorts/')) return File('${_shortsDir.path}/${path.substring(14)}');
    return null;
  }

  // ------------------------------------------------------------------ downloads

  Future<void> download(String id, int height, Map<String, dynamic> item) async {
    _cancelled.remove(id);
    downloads[id] = {
      'id': id, 'item': item, 'height': height, 'status': 'queued',
      'done': 0, 'total': 0, 'bytes': 0, 'error': null, 'addedAt': DateTime.now().millisecondsSinceEpoch,
    };
    await _saveDownloads();
    _runDownloads();
  }

  Future<void> remove(String id) async {
    _cancelled.add(id);
    downloads.remove(id);
    await _saveDownloads();
    try {
      await Directory('${_downloadsDir.path}/$id').delete(recursive: true);
    } catch (_) {}
  }

  // One download at a time, oldest first.
  Future<void> _runDownloads() async {
    if (_downloading) return;
    _downloading = true;
    try {
      while (true) {
        final next = downloads.values.where((d) => d['status'] == 'queued').toList()
          ..sort((a, b) => (a['addedAt'] as int).compareTo(b['addedAt'] as int));
        if (next.isEmpty) break;
        final d = next.first;
        final id = d['id'] as String;
        d['status'] = 'downloading';
        d['error'] = null;
        try {
          await _save(id, Directory('${_downloadsDir.path}/$id'), d['height'] as int, d, full: true);
          if (_cancelled.contains(id)) continue;
          d['status'] = 'done';
        } catch (e) {
          if (_cancelled.contains(id)) continue;
          d['status'] = 'failed';
          d['error'] = e is SocketException || e is HttpException ? 'No connection. Tap Retry when you\'re back online.' : '$e';
        }
        await _saveDownloads();
      }
    } finally {
      _downloading = false;
    }
  }

  Future<void> retry(String id) async {
    final d = downloads[id];
    if (d == null) return;
    d['status'] = 'queued';
    await _saveDownloads();
    _runDownloads();
  }

  // ------------------------------------------------------------------ Shorts cache

  /// Adds Shorts to the cache (the one being watched and the next few).
  void cacheShorts(List<Map<String, dynamic>> items) {
    for (final it in items) {
      final id = it['id'] as String?;
      if (id == null) continue;
      final have = shorts[id];
      if (have != null) {
        have['usedAt'] = DateTime.now().millisecondsSinceEpoch;
        continue;
      }
      if (_shortQueue.any((q) => q['id'] == id)) continue;
      _shortQueue.add(it);
    }
    // Keep the queue short: it follows where the user is now.
    while (_shortQueue.length > 8) {
      _shortQueue.removeAt(0);
    }
    _runShorts();
  }

  Future<void> clearShorts() async {
    _shortQueue.clear();
    shorts.clear();
    await _saveShorts();
    try {
      await for (final e in _shortsDir.list()) {
        if (e is Directory) await e.delete(recursive: true);
      }
    } catch (_) {}
  }

  Future<void> _runShorts() async {
    if (_caching) return;
    _caching = true;
    try {
      while (_shortQueue.isNotEmpty) {
        final it = _shortQueue.removeAt(0);
        final id = it['id'] as String;
        if (shorts.containsKey(id)) continue;
        final dir = Directory('${_shortsDir.path}/$id');
        final rec = <String, dynamic>{'id': id, 'item': it, 'status': 'downloading', 'bytes': 0, 'usedAt': DateTime.now().millisecondsSinceEpoch, 'done': 0, 'total': 0};
        try {
          await _save(id, dir, _shortHeight, rec, full: false);
          rec['status'] = 'done';
          final v = await _details(id);
          rec['item'] = {
            'type': 'short', 'id': id, 'title': v['title'] ?? it['title'] ?? '',
            'viewsText': it['viewsText'], 'channel': (v['channel'] as Map?)?['name'],
          };
          shorts[id] = rec;
          await _evictShorts();
          await _saveShorts();
        } catch (_) {
          try {
            await dir.delete(recursive: true);
          } catch (_) {}
        }
      }
    } finally {
      _caching = false;
    }
  }

  // Oldest-used first, until the cache fits its limit.
  Future<void> _evictShorts() async {
    final list = shorts.values.toList()..sort((a, b) => (a['usedAt'] as int).compareTo(b['usedAt'] as int));
    var total = shortsBytes;
    for (final s in list) {
      if (total <= shortsCacheLimit) break;
      total -= (s['bytes'] as num).toInt();
      shorts.remove(s['id']);
      try {
        await Directory('${_shortsDir.path}/${s['id']}').delete(recursive: true);
      } catch (_) {}
    }
  }

  // ------------------------------------------------------------------ saving one video

  /// Saves video [id] at [height] (or the closest lower H.264 quality) into [dir].
  /// Updates rec['done'/'total'/'bytes'] as it goes. Already-saved segments are kept,
  /// so an interrupted download resumes (with fresh links from YouTube).
  Future<void> _save(String id, Directory dir, int height, Map<String, dynamic> rec, {required bool full}) async {
    await dir.create(recursive: true);
    final v = await _details(id);
    final hls = v['hls'] as String?;
    if (hls == null) throw 'This video can\'t be saved (live or no stream).';
    final master = await _getText(Uri.parse(hls));

    // Picture: the best H.264 variant at or below the chosen height (H.264 plays everywhere).
    final variants = _variants(master.text, master.url).where((s) => s.avc).toList()..sort((a, b) => b.height.compareTo(a.height));
    if (variants.isEmpty) throw 'No downloadable stream for this video.';
    final pick = variants.firstWhere((s) => s.height <= height, orElse: () => variants.last);

    // Sound: the original-language track of that variant's audio group.
    final audios = _audioTracks(master.text, master.url).where((a) => a.group == pick.audioGroup).toList();
    _Audio? audio;
    if (audios.isNotEmpty) {
      audio = audios.firstWhere((a) => a.original, orElse: () => audios.firstWhere((a) => a.isDefault, orElse: () => audios.first));
    }

    final videoList = await _getText(pick.url);
    final audioList = audio == null ? null : await _getText(audio.url);
    final jobs = <(Uri, File)>[];
    final localVideo = _localPlaylist(videoList, 'v', dir, jobs);
    final localAudio = audioList == null ? null : _localPlaylist(audioList, 'a', dir, jobs);
    rec['total'] = jobs.length;

    // Small extras first: thumbnail, channel avatar, details.
    final thumbUrl = 'https://i.ytimg.com/vi/$id/${full ? 'hqdefault' : 'frame0'}.jpg';
    await _download(Uri.parse(thumbUrl), File('${dir.path}/thumb.jpg')).catchError((_) => 0);
    final avatar = (v['channel'] as Map?)?['avatar'] as String?;
    if (avatar != null) await _download(Uri.parse(avatar), File('${dir.path}/avatar.jpg')).catchError((_) => 0);

    // Segments, three at a time.
    var bytes = 0;
    var next = 0;
    Future<void> worker() async {
      while (next < jobs.length) {
        if (_cancelled.contains(id)) throw 'cancelled';
        final (url, f) = jobs[next++];
        final n = await _download(url, f); // (not "bytes += await": that loses updates between workers)
        bytes += n;
        rec['done'] = (rec['done'] as int) + 1;
        rec['bytes'] = bytes;
      }
    }
    rec['done'] = 0;
    await Future.wait([worker(), worker(), worker()]);

    // Downloads also get an audio-only file (background play) and captions.
    final captions = <Map<String, dynamic>>[];
    if (full) {
      final a = v['audio'] as String?;
      if (a != null) {
        try {
          await _downloadRanged(Uri.parse(a), File('${dir.path}/audio.m4a'));
        } catch (_) {}
      }
      var i = 0;
      for (final c in (v['captions'] as List? ?? []).take(4)) {
        try {
          final name = 'cap_${i++}.vtt';
          bytes += await _download(Uri.parse(c['url'] as String), File('${dir.path}/$name'));
          captions.add({'lang': c['lang'], 'label': c['label'], 'file': name});
        } catch (_) {}
      }
    }
    rec['bytes'] = await _sizeOf(dir);

    await File('${dir.path}/v.m3u8').writeAsString(localVideo);
    if (localAudio != null) await File('${dir.path}/a.m3u8').writeAsString(localAudio);
    final masterLines = ['#EXTM3U', '#EXT-X-INDEPENDENT-SEGMENTS'];
    if (audio != null) {
      masterLines.add(audio.line
          .replaceAll(RegExp(r'URI="[^"]*"'), 'URI="a.m3u8"')
          .replaceAll(RegExp(r'DEFAULT=(YES|NO)'), 'DEFAULT=YES'));
    }
    masterLines
      ..add(pick.line)
      ..add('v.m3u8');
    await File('${dir.path}/master.m3u8').writeAsString('${masterLines.join('\n')}\n');
    await File('${dir.path}/meta.json').writeAsString(jsonEncode({
      for (final k in ['id', 'title', 'description', 'channel', 'views', 'likes', 'published', 'uploadDate', 'duration', 'live', 'short', 'chapters', 'related', 'commentCount'])
        k: v[k],
      'captions': captions,
      'quality': pick.height,
    }));
  }

  /// Rewrites a media playlist to local file names and queues its segments.
  String _localPlaylist(({String text, Uri url}) list, String prefix, Directory dir, List<(Uri, File)> jobs) {
    var n = 0;
    return const LineSplitter().convert(list.text).map((line) {
      final l = line.trim();
      if (l.isEmpty) return line;
      if (l.startsWith('#EXT-X-MAP:')) {
        return line.replaceAllMapped(RegExp(r'URI="([^"]+)"'), (m) {
          final name = '${prefix}_init.mp4';
          jobs.add((list.url.resolve(m[1]!), File('${dir.path}/$name')));
          return 'URI="$name"';
        });
      }
      if (l.startsWith('#')) return line;
      final name = '${prefix}_${(n++).toString().padLeft(5, '0')}.ts';
      jobs.add((list.url.resolve(l), File('${dir.path}/$name')));
      return name;
    }).join('\n');
  }

  // ------------------------------------------------------------------ HLS parsing

  Iterable<_Variant> _variants(String master, Uri base) sync* {
    final lines = const LineSplitter().convert(master);
    for (var i = 0; i < lines.length - 1; i++) {
      final l = lines[i];
      if (!l.startsWith('#EXT-X-STREAM-INF:')) continue;
      final res = RegExp(r'RESOLUTION=(\d+)x(\d+)').firstMatch(l);
      yield _Variant(
        line: l,
        url: base.resolve(lines[i + 1].trim()),
        // "480p" means the short side, so vertical videos (Shorts: 480x854) count as 480p too.
        height: res == null ? 0 : min(int.parse(res[1]!), int.parse(res[2]!)),
        bandwidth: int.tryParse(RegExp(r'BANDWIDTH=(\d+)').firstMatch(l)?[1] ?? '') ?? 0,
        avc: l.contains('avc1'),
        audioGroup: RegExp(r'AUDIO="([^"]+)"').firstMatch(l)?[1],
      );
    }
  }

  Iterable<_Audio> _audioTracks(String master, Uri base) sync* {
    for (final l in const LineSplitter().convert(master)) {
      if (!l.startsWith('#EXT-X-MEDIA:') || !l.contains('TYPE=AUDIO')) continue;
      final uri = RegExp(r'URI="([^"]+)"').firstMatch(l)?[1];
      if (uri == null) continue;
      yield _Audio(
        line: l,
        url: base.resolve(uri),
        group: RegExp(r'GROUP-ID="([^"]+)"').firstMatch(l)?[1],
        original: RegExp(r'NAME="[^"]*original"').hasMatch(l),
        isDefault: l.contains('DEFAULT=YES'),
      );
    }
  }

  // ------------------------------------------------------------------ plumbing

  Future<({String text, Uri url})> _getText(Uri url) async {
    final res = await (await _http.getUrl(url)).close();
    if (res.statusCode != 200) {
      await res.drain<void>();
      throw HttpException('HTTP ${res.statusCode}', uri: url);
    }
    final finalUrl = res.redirects.fold(url, (u, r) => u.resolveUri(r.location));
    return (text: await utf8.decodeStream(res), url: finalUrl);
  }

  /// Downloads to [f] unless it's already there. Returns its size.
  Future<int> _download(Uri url, File f) async {
    if (await f.exists()) {
      final len = await f.length();
      if (len > 0) return len;
    }
    for (var attempt = 0;; attempt++) {
      try {
        final res = await (await _http.getUrl(url)).close();
        if (res.statusCode != 200) {
          await res.drain<void>();
          throw HttpException('HTTP ${res.statusCode}', uri: url);
        }
        final tmp = File('${f.path}.part');
        final sink = tmp.openWrite();
        await res.pipe(sink);
        await tmp.rename(f.path);
        return await f.length();
      } catch (e) {
        if (attempt >= 2) rethrow;
        await Future<void>.delayed(Duration(seconds: 1 + attempt * 2));
      }
    }
  }

  /// YouTube slows down one long request for a whole file, so big files come in
  /// 512 KB ranges, four at a time, written into place.
  Future<void> _downloadRanged(Uri url, File f) async {
    if (await f.exists() && await f.length() > 0) return;
    const chunk = 512 * 1024;
    Future<(List<int>, int)> part(int start) async {
      for (var attempt = 0;; attempt++) {
        try {
          final req = await _http.getUrl(url);
          req.headers.set(HttpHeaders.rangeHeader, 'bytes=$start-${start + chunk - 1}');
          final res = await req.close();
          if (res.statusCode != 206 && res.statusCode != 200) {
            await res.drain<void>();
            throw HttpException('HTTP ${res.statusCode}', uri: url);
          }
          final total = int.tryParse(RegExp(r'/(\d+)$').firstMatch(res.headers.value('content-range') ?? '')?[1] ?? '') ?? -1;
          final data = await res.fold<List<int>>(<int>[], (a, b) => a..addAll(b));
          return (data, total);
        } catch (e) {
          if (attempt >= 2) rethrow;
          await Future<void>.delayed(Duration(seconds: 1 + attempt * 2));
        }
      }
    }

    final tmp = File('${f.path}.part');
    final raf = await tmp.open(mode: FileMode.write);
    try {
      final (first, total) = await part(0);
      await raf.writeFrom(first);
      if (total > first.length) {
        var next = first.length;
        // Downloads run in parallel; writes to the file go one at a time (seek + write must not interleave).
        Future<void> writes = Future.value();
        Future<void> worker() async {
          while (next < total) {
            final start = next;
            next += chunk;
            final (data, _) = await part(start);
            writes = writes.then((_) async {
              await raf.setPosition(start);
              await raf.writeFrom(data);
            });
            await writes;
          }
        }
        await Future.wait([worker(), worker(), worker(), worker()]);
        await writes;
      }
    } finally {
      await raf.close();
    }
    await tmp.rename(f.path);
  }

  Future<int> _sizeOf(Directory dir, {Set<String> except = const {}}) async {
    var total = 0;
    await for (final e in dir.list()) {
      if (e is File && !except.contains(e.uri.pathSegments.last)) total += await e.length();
    }
    return total;
  }

  Future<void> _saveDownloads() => _downloadsIndex.writeAsString(jsonEncode(downloads.values.toList())).catchError((_) => _downloadsIndex);
  Future<void> _saveShorts() => _shortsIndex.writeAsString(jsonEncode(shorts.values.toList())).catchError((_) => _shortsIndex);
}

class _Variant {
  _Variant({required this.line, required this.url, required this.height, required this.bandwidth, required this.avc, required this.audioGroup});
  final String line;
  final Uri url;
  final int height, bandwidth;
  final bool avc;
  final String? audioGroup;
}

class _Audio {
  _Audio({required this.line, required this.url, required this.group, required this.original, required this.isDefault});
  final String line;
  final Uri url;
  final String? group;
  final bool original, isDefault;
}
