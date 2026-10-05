// A tiny HTTP server that runs inside the app on 127.0.0.1.
//
//  - Serves the bundled web UI (assets/web/...) to the visible WebView.
//  - Answers the JSON API in docs/API.md. YouTube data comes from YouTube.kt
//    (NewPipeExtractor) over the "asttube/youtube" method channel.
//  - Builds the Home feed from the local watch history, keeps that history in
//    a JSON file, and proxies HLS playlists/segments and captions (YouTube's
//    servers send no CORS headers for this origin).

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import 'offline.dart';

class LocalServer {
  static const _yt = MethodChannel('asttube/youtube');
  static const _chips = {
    'music': 'trending_music',
    'gaming': 'trending_gaming',
    'movies': 'trending_movies_and_shows',
    'podcasts': 'trending_podcasts_episodes',
    'live': 'live',
  };
  // Used for the Shorts feed alongside channels from the watch history.
  static const _shortTopics = ['funny', 'music', 'football', 'dance', 'comedy', 'gaming', 'satisfying', 'cooking', 'animals', 'travel'];

  late final HttpServer _server;
  late final _History _history;
  final _cache = <String, (DateTime, Object)>{};
  final _random = Random();

  String get origin => 'http://127.0.0.1:${_server.port}';

  /// App preferences (not user data): autoplay, background play, preferred quality.
  final settings = <String, dynamic>{'autoplay': true, 'background': true, 'quality': 'auto'};
  File? _settingsFile;

  late final Offline _offline;

  /// Set by main.dart from Android's connectivity state.
  bool online = true;

  /// The installed app version (shown in Settings › About).
  String version = '';

  // Raw details from YouTube.kt (real stream URLs), cached like everything else.
  Future<Map<String, dynamic>> _rawVideo(String id) async =>
      Map<String, dynamic>.from(await _cached('video|$id', const Duration(minutes: 20), () => _call('video', {'id': id})) as Map);

  Future<void> start() async {
    _history = await _History.open();
    final support = await getApplicationSupportDirectory();
    _offline = await Offline.open(support, _rawVideo);
    _settingsFile = File('${support.path}/settings.json');
    try {
      settings.addAll((jsonDecode(await _settingsFile!.readAsString()) as Map).cast<String, dynamic>());
    } catch (_) {}
    try {
      // A fixed port keeps the page origin (and anything it stores) stable.
      _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 8765);
    } on SocketException {
      _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    }
    _server.listen((req) => _handle(req).catchError((_) {}));
  }

  Future<void> _handle(HttpRequest req) async {
    final res = req.response;
    final path = req.uri.path;
    final p = req.uri.queryParameters;
    final next = p['next']?.isNotEmpty == true ? p['next'] : null;
    try {
      if (path.startsWith('/offline/') || path.startsWith('/cache/')) return await _file(req, _offline.file(Uri.decodeComponent(path)));
      if (!path.startsWith('/api/')) {
        return await _asset(res, path == '/' ? 'index.html' : Uri.decodeComponent(path.substring(1)));
      }
      final parts = path.substring(5).split('/').map(Uri.decodeComponent).toList();
      if (parts[0] == 'net') return _json(res, {'online': online, 'version': version});
      // Pull-to-refresh: drop cached results so this request asks YouTube again.
      if (p['fresh'] == '1') {
        final prefix = switch (parts[0]) {
          'search' => 'search|${p['filter'] ?? 'all'}|${(p['q'] ?? '').trim()}|',
          'home' || 'feed' => 'feed|',
          _ => null,
        };
        if (prefix != null) _cache.removeWhere((k, _) => k.startsWith(prefix));
        if (parts[0] == 'home') _cache.removeWhere((k, _) => k.startsWith('shorts|')); // new Shorts shelf too
      }
      // No internet: answer at once instead of waiting for YouTube to time out.
      // (Videos still work when they're saved; Shorts fall back to the saved ones.)
      if (!online && const {'home', 'feed', 'search', 'suggest', 'comments', 'channel', 'playlist', 'related', 'mix'}.contains(parts[0])) {
        return _json(res, {'error': "You're offline", 'offline': true}, 503);
      }
      if (!online && parts[0] == 'video' && await _offline.localDetails(parts[1]) == null) {
        return _json(res, {'error': "You're offline and this video isn't downloaded", 'offline': true}, 503);
      }
      if (!online && parts[0] == 'shorts' && req.method == 'GET') {
        return _json(res, {'items': _offline.cachedShortItems(), 'next': null, 'offline': true});
      }
      switch (parts[0]) {
        case 'home':
          return _json(res, await _home(next, fresh: p['fresh'] == '1'));
        case 'feed':
          final kiosk = _chips[parts.length > 1 ? parts[1] : ''];
          if (kiosk == null) return _json(res, {'error': 'Unknown feed'}, 404);
          return _json(res, await _feed(parts[1], kiosk, next));
        case 'search':
          final q = (p['q'] ?? '').trim();
          if (q.isEmpty) return _json(res, {'error': 'Missing ?q='}, 400);
          final filter = p['filter'] ?? 'all';
          return _json(res, await _cached('search|$filter|$q|$next', const Duration(minutes: 15), () => _call('search', {'q': q, 'filter': filter, 'next': next})));
        case 'suggest':
          final q = (p['q'] ?? '').trim();
          if (q.isEmpty) return _json(res, []);
          return _json(res, await _cached('suggest|$q', const Duration(hours: 1), () => _call('suggest', {'q': q})));
        case 'video':
          return _json(res, await _video(parts[1]));
        case 'comments':
          return _json(res, await _cached('comments|${parts[1]}|$next', const Duration(minutes: 15), () => _call('comments', {'id': parts[1], 'next': next})));
        case 'channel':
          final tab = p['tab'] ?? 'videos';
          return _json(res, await _cached('channel|${parts[1]}|$tab|$next', const Duration(minutes: 15), () => _call('channel', {'id': parts[1], 'tab': tab, 'next': next})));
        case 'playlist':
          return _json(res, await _cached('playlist|${parts[1]}|$next', const Duration(minutes: 15), () => _call('playlist', {'id': parts[1], 'next': next})));
        case 'mix':
          final seed = p['seed'] ?? (parts[1].startsWith('RD') && parts[1].length == 13 ? parts[1].substring(2) : '');
          if (seed.isEmpty) return _json(res, {'error': 'Missing ?seed='}, 400);
          return _json(res, await _cached('mix|${parts[1]}|$seed|$next', const Duration(minutes: 30), () => _call('mix', {'id': parts[1], 'seed': seed, 'next': next})));
        case 'offline':
          return await _offlineRoute(req, parts.length > 1 ? parts[1] : null, parts.length > 2 ? parts[2] : null);
        case 'related':
          return _json(res, await _related(parts[1], next));
        case 'settings':
          if (req.method == 'POST') {
            settings.addAll((jsonDecode(await utf8.decodeStream(req)) as Map).cast<String, dynamic>());
            await _settingsFile?.writeAsString(jsonEncode(settings));
          }
          return _json(res, settings);
        case 'shorts':
          // Offline (or YouTube unreachable): play the cached Shorts.
          final cached = {'items': _offline.cachedShortItems(), 'next': null, 'offline': true};
          if (p['offline'] == '1') return _json(res, cached);
          try {
            return _json(res, await _shorts(next));
          } catch (_) {
            if (next != null || _offline.shorts.isEmpty) rethrow;
            return _json(res, cached);
          }
        case 'history':
          return await _historyRoute(req, parts.length > 1 ? parts[1] : null);
        case 'hls':
          return await _hls(req);
        case 'captions':
          return await _captions(req);
      }
      _json(res, {'error': 'Not found'}, 404);
    } on PlatformException catch (e) {
      _json(res, {'error': 'Could not get this from YouTube', 'detail': e.message}, 502);
    } on TimeoutException {
      _json(res, {'error': 'YouTube took too long to answer', 'detail': 'timeout'}, 504);
    } catch (e) {
      _json(res, {'error': 'Internal error', 'detail': '$e'}, 500);
    }
  }

  // ------------------------------------------------------------------ YouTube

  Future<dynamic> _call(String method, Map<String, dynamic> args) async {
    final raw = await _yt.invokeMethod<String>(method, args).timeout(const Duration(seconds: 45));
    return jsonDecode(raw!);
  }

  // Requests already on their way to YouTube, so a tap during a prefetch waits for it instead of asking twice.
  final _inFlight = <String, Future<Object>>{};

  Future<Object> _cached(String key, Duration ttl, Future<dynamic> Function() load) async {
    final hit = _cache[key];
    if (hit != null && DateTime.now().difference(hit.$1) < ttl) return hit.$2;
    final pending = _inFlight[key];
    if (pending != null) return pending;
    final future = load().then((v) => v as Object);
    _inFlight[key] = future;
    try {
      final value = await future;
      _cache[key] = (DateTime.now(), value);
      if (_cache.length > 400) _cache.remove(_cache.keys.first);
      return value;
    } finally {
      _inFlight.remove(key);
    }
  }

  // Stream URLs last a few hours; keep video details for 20 minutes.
  Future<Map<String, dynamic>> _video(String id) async {
    // A saved copy (download or cached Short) plays from the phone, online or not.
    final local = await _offline.localDetails(id);
    if (local != null) {
      _history.rememberRelated(id, local['related'] as List? ?? []);
      return local;
    }
    final v = await _rawVideo(id);
    _history.rememberRelated(id, v['related'] as List);
    final hls = v['hls'] as String?;
    return {
      ...v,
      'hls': hls == null ? null : '/api/hls?u=${Uri.encodeComponent(hls)}',
      'captions': [
        for (final c in v['captions'] as List) {...c as Map, 'url': '/api/captions?u=${Uri.encodeComponent(c['url'] as String)}'},
      ],
    };
  }

  // ------------------------------------------------------------------ home

  // Home is built like signed-out YouTube does it: from what you watched.
  // Related videos of the most recent history entries are interleaved; with no
  // history (first launch) YouTube's curated lists fill it instead. The whole
  // list is built on the first page and then served in pages of 20.
  List<Map<String, dynamic>> _homeItems = [];
  static const _homePage = 20;

  Future<Map<String, dynamic>> _home(String? next, {bool fresh = false}) async {
    if (next != null && next.startsWith('d|')) return _discover(int.parse(next.substring(2)));
    var offset = int.tryParse(next ?? '') ?? 0;
    List<dynamic> shorts = [];
    if (next == null) {
      final built = await Future.wait([_buildHome(shuffle: fresh), _shortsShelf()]);
      _homeItems = built[0].cast<Map<String, dynamic>>();
      // Discovery pages start fresh and never repeat what Home already showed or you watched.
      _homeSeen
        ..clear()
        ..addAll(_homeItems.map((v) => v['id']))
        ..addAll(_history.items.map((h) => h['id']));
      _discQueries = _discoveryQueries();
      shorts = built[1];
      offset = 0;
    }
    final end = min(offset + _homePage, _homeItems.length);
    return {
      'items': offset < end ? _homeItems.sublist(offset, end) : [],
      'shorts': shorts,
      // After the built list, Home keeps going with discovery pages: it never ends.
      'next': end < _homeItems.length ? '$end' : 'd|0',
    };
  }

  // ---- endless scrolling: search pages around what you watch, then general topics.
  static const _topics = ['music', 'comedy', 'football highlights', 'movie trailers', 'gaming', 'cooking', 'science', 'technology', 'travel', 'animals'];
  final _homeSeen = <dynamic>{};
  List<String> _discQueries = [];
  final _searchNext = <String, String?>{}; // query -> YouTube's next page token
  final _searchDone = <String>{};

  List<String> _discoveryQueries() {
    final videos = _history.items.where((h) => h['type'] == 'video');
    final channels = videos.map((h) => '${h['channel'] ?? ''}').where((c) => c.isNotEmpty).toSet().take(8);
    // A recent title, minus the "(Official Video)" style noise, makes a good topic.
    final titles = videos.take(4).map((h) => '${h['title'] ?? ''}'
        .replaceAll(RegExp(r'[\(\[\|].*$'), '')
        .split(RegExp(r'\s+'))
        .take(5)
        .join(' ')
        .trim()).where((t) => t.length > 3);
    final topics = [..._topics]..shuffle(_random);
    final out = <String>[];
    for (final q in [...channels, ...titles, ...topics]) {
      if (!out.contains(q)) out.add(q);
    }
    return out;
  }

  /// One page of new videos for [query]; walks YouTube's pages for it, skipping anything in [seen].
  Future<List<dynamic>> _searchPage(String query, Set<dynamic> seen) async {
    if (_searchDone.contains(query)) return [];
    final r = await _call('search', {'q': query, 'filter': 'videos', 'next': _searchNext[query]}) as Map;
    _searchNext[query] = r['next'] as String?;
    if (r['next'] == null) _searchDone.add(query);
    return [for (final v in r['items'] as List) if (v['type'] == 'video' && seen.add(v['id'])) v];
  }

  Future<Map<String, dynamic>> _discover(int n) async {
    if (_discQueries.isEmpty) _discQueries = _discoveryQueries();
    final items = <dynamic>[];
    // Rotate through the topics so the feed keeps changing; stop after a few tries.
    for (var tries = 0; items.length < 12 && tries < 6; tries++, n++) {
      try {
        items.addAll(await _searchPage(_discQueries[n % _discQueries.length], _homeSeen));
      } catch (_) {}
      if (_searchDone.length >= _discQueries.length) {
        _searchDone.clear(); // everything ran dry: start the topics over from page 1
        _searchNext.clear();
      }
    }
    items.shuffle(_random);
    return {'items': items, 'shorts': [], 'next': 'd|$n'};
  }

  // "Up next" below the player never ends: YouTube's own watch-next pages first,
  // then searches on the video's topic and channel. Every other page also brings a
  // shelf of Shorts on the same topic. "next" is a YouTube token or "s|<n>".
  final _relatedSeen = <String, Set<dynamic>>{};
  final _relatedPage = <String, int>{};
  final _shortsNext = <String, String?>{};
  final _shortsQuery = <String, String>{}; // video id -> the Shorts search that worked for it

  static String _topicOf(String title) => title
      .replaceAll(RegExp(r'[\(\[\|].*$'), '')
      .replaceAll(RegExp(r'[^\p{L}\p{N}\s\-]', unicode: true), ' ')
      .split(RegExp(r'\s+'))
      .where((w) => w.isNotEmpty)
      .take(5)
      .join(' ');

  Future<Map<String, dynamic>> _related(String id, String? next) async {
    final v = await _video(id);
    final topic = _topicOf('${v['title']}');
    final channel = '${(v['channel'] as Map)['name'] ?? ''}';
    // Opening the video again starts its list over.
    if (next == null) {
      _relatedSeen.remove(id);
      _shortsNext.remove('rel:$id');
      _shortsQuery.remove(id);
    }
    final seen = _relatedSeen.putIfAbsent(id, () => <dynamic>{id, for (final r in v['related'] as List) r['id']});
    if (_relatedSeen.length > 30) _relatedSeen.remove(_relatedSeen.keys.first);
    final page = _relatedPage[id] = (next == null ? 0 : (_relatedPage[id] ?? 0) + 1);

    final items = <dynamic>[];
    String? more;
    if (next == null || !next.startsWith('s|')) {
      try {
        final r = await _cached('related|$id|$next', const Duration(minutes: 20), () => _call('related', {'id': id, 'next': next})) as Map;
        for (final i in r['items'] as List) {
          if (seen.add(i['id'])) items.add(i);
        }
        more = r['next'] as String?;
      } catch (_) {}
      more ??= 's|0';
    }
    if (more == null || (items.length < 6 && more.startsWith('s|'))) {
      // Past YouTube's list: search around the topic and channel.
      var n = next != null && next.startsWith('s|') ? int.parse(next.substring(2)) : 0;
      final queries = [topic, if (channel.isNotEmpty) channel, if (channel.isNotEmpty) '$channel $topic'].where((q) => q.trim().isNotEmpty).toList();
      for (var tries = 0; items.length < 10 && tries < queries.length * 2; tries++, n++) {
        try {
          items.addAll(await _searchPage(queries[n % queries.length], seen));
        } catch (_) {}
      }
      more = 's|$n';
    }

    // Shorts on the same topic, as a shelf on every other page.
    var shorts = <dynamic>[];
    if (page.isEven) {
      // A long title finds few Shorts; fall back to its first words, then the channel.
      final words = topic.split(' ');
      final candidates = [
        if (_shortsQuery[id] != null) _shortsQuery[id]!,
        topic,
        if (words.length > 2) words.take(2).join(' '),
        if (channel.isNotEmpty) channel,
      ];
      final key = 'rel:$id';
      for (final q in candidates.toSet()) {
        try {
          final sameQuery = _shortsQuery[id] == q;
          final r = await _call('shorts', {'q': q, 'next': sameQuery ? _shortsNext[key] : null}) as Map;
          shorts = (r['items'] as List).where((s) => seen.add(s['id'])).take(12).toList();
          if (shorts.length >= 3) {
            _shortsQuery[id] = q;
            _shortsNext[key] = r['next'] as String?;
            break;
          }
          if (sameQuery) _shortsQuery.remove(id); // this topic ran dry
        } catch (_) {}
      }
    }
    return {'items': items, 'shorts': shorts, 'next': more};
  }

  // Chips: YouTube's curated list first, then search pages on the chip's topic.
  static const _chipTopics = {
    'music': ['new music video', 'official music video', 'live performance', 'acoustic cover', 'music video 2026'],
    'gaming': ['gameplay', 'gaming highlights', 'minecraft', 'gta', 'fifa gameplay', 'walkthrough'],
    'movies': ['official trailer', 'movie trailer 2026', 'movie clip', 'teaser trailer'],
    'podcasts': ['podcast full episode', 'podcast interview', 'podcast clips'],
    'live': ['live now', 'live stream', 'live news'],
  };
  final _chipSeen = <String, Set<dynamic>>{};

  Future<Map<String, dynamic>> _feed(String chip, String kiosk, String? next) async {
    final seen = _chipSeen.putIfAbsent(chip, () => <dynamic>{});
    if (next != null && next.startsWith('s|')) {
      var n = int.parse(next.substring(2));
      final topics = _chipTopics[chip]!;
      final items = <dynamic>[];
      for (var tries = 0; items.length < 12 && tries < topics.length; tries++, n++) {
        try {
          items.addAll(await _searchPage(topics[n % topics.length], seen));
        } catch (_) {}
      }
      return {'items': items, 'next': 's|$n'};
    }
    if (next == null) seen.clear();
    final r = Map<String, dynamic>.from(await _cached('feed|$kiosk|$next', const Duration(minutes: 15), () => _call('kiosk', {'id': kiosk, 'next': next})) as Map);
    for (final v in r['items'] as List) {
      seen.add(v['id']);
    }
    r['next'] ??= 's|0';
    return r;
  }

  Future<List<dynamic>> _buildHome({bool shuffle = false}) async {
    final seeds = _history.items.map((h) => h['id'] as String).toSet().take(10).toList();
    final lists = <List<dynamic>>[];
    var fetches = 0;
    for (final id in seeds) {
      var related = _history.related[id];
      if (related == null && fetches < 3) {
        fetches++;
        try {
          related = (await _video(id))['related'] as List;
        } catch (_) {}
      }
      // Refreshing reshuffles each list, so pulling down gives a different Home.
      if (related != null) lists.add(shuffle ? (related.toList()..shuffle(_random)) : related);
    }
    if (shuffle) lists.shuffle(_random);
    final watched = _history.items.map((h) => h['id']).toSet();
    final fromHistory = _interleave(lists, skip: watched);

    // Curated lists: everything on first launch, a sprinkle otherwise.
    final kiosks = await Future.wait(['trending_music', 'trending_gaming', 'trending_movies_and_shows', 'live'].map((k) async {
      try {
        final r = await _cached('feed|$k|null', const Duration(minutes: 15), () => _call('kiosk', {'id': k, 'next': null})) as Map;
        return (r['items'] as List).toList()..shuffle(_random);
      } catch (_) {
        return <dynamic>[];
      }
    }));
    final curated = _interleave(kiosks, skip: watched);

    // Mixes, like YouTube's "Mix - <song>" cards: the ones YouTube suggests next to
    // what you watched, plus one built around each of your latest videos. On first
    // launch they come from the trending music list.
    final mixes = <dynamic>[];
    final mixIds = <String>{};
    void addMix(Map m) {
      if (mixIds.add(m['id'] as String)) mixes.add(m);
    }
    for (final h in _history.items.where((h) => h['type'] == 'video' && _isMusic(h)).take(4)) {
      addMix(_mixFor(h));
    }
    for (final l in lists) {
      for (final m in l.where((i) => i['type'] == 'mix')) {
        addMix(m as Map);
      }
    }
    if (mixes.isEmpty) {
      for (final v in kiosks[0].take(4)) {
        addMix(_mixFor(v as Map));
      }
    }

    final videos = fromHistory.isEmpty ? curated : _blend(fromHistory, curated);
    // A Mix after the 2nd video, then one every 6.
    final out = <dynamic>[];
    var m = 0;
    for (var i = 0; i < videos.length; i++) {
      out.add(videos[i]);
      if ((i == 1 || (i > 1 && (i - 1) % 6 == 0)) && m < mixes.length) out.add(mixes[m++]);
    }
    return out;
  }

  // Mixes are for music; a "Mix" of a trailer or a vlog makes no sense.
  static final _musicTitle = RegExp(
      r'official\s+(music\s+)?video|official\s+audio|\baudio\b|lyrics?\b|\bft\.?\s|\bfeat\.?\s|remix|music video|visuali[sz]er|acoustic|\bmv\b|\(live',
      caseSensitive: false);
  static bool _isMusic(Map v) =>
      _musicTitle.hasMatch('${v['title'] ?? ''} ') || RegExp(r'(VEVO| - Topic)$').hasMatch('${v['channel'] ?? ''}');

  static Map<String, dynamic> _mixFor(Map v) => {
        'type': 'mix',
        'id': 'RD${v['id']}',
        'seed': v['id'],
        'title': v['title'],
        'subtitle': '${v['channel'] ?? 'YouTube'} and more',
        'thumb': 'https://i.ytimg.com/vi/${v['id']}/hqdefault.jpg',
      };

  /// Roughly one curated video for every four from your history.
  static List<dynamic> _blend(List<dynamic> fromHistory, List<dynamic> curated) {
    final out = <dynamic>[];
    final seen = <String>{};
    var c = 0;
    for (var i = 0; i < fromHistory.length; i++) {
      if (seen.add(fromHistory[i]['id'] as String)) out.add(fromHistory[i]);
      if (i % 4 == 3 && c < curated.length && seen.add(curated[c]['id'] as String)) out.add(curated[c++]);
    }
    for (; c < curated.length; c++) {
      if (seen.add(curated[c]['id'] as String)) out.add(curated[c]);
    }
    return out;
  }

  /// Round-robin through several lists, keeping only regular videos, no repeats.
  static List<dynamic> _interleave(List<List<dynamic>> lists, {Set<dynamic> skip = const {}}) {
    final out = <dynamic>[];
    final seen = <dynamic>{...skip};
    final longest = lists.fold<int>(0, (m, l) => max(m, l.length));
    for (var i = 0; i < longest; i++) {
      for (final l in lists) {
        if (i < l.length && l[i]['type'] == 'video' && seen.add(l[i]['id'])) out.add(l[i]);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ shorts

  // Topics for Shorts: channels you watched recently, then general topics.
  List<String> _shortQueries() {
    final channels = _history.items.map((h) => h['channel'] as String? ?? '').where((c) => c.isNotEmpty).toSet().take(5).toList();
    final topics = [..._shortTopics]..shuffle(_random);
    final out = <String>[];
    for (var i = 0; i < max(channels.length, topics.length); i++) {
      if (i < channels.length) out.add(channels[i]);
      if (i < topics.length) out.add(topics[i]);
    }
    return out;
  }

  Future<List<dynamic>> _shortsShelf() async {
    try {
      final q = _shortQueries().first;
      final r = await _cached('shorts|$q|null', const Duration(minutes: 30), () => _call('shorts', {'q': q, 'next': null})) as Map;
      return (r['items'] as List).take(12).toList();
    } catch (_) {
      return [];
    }
  }

  // The feed walks through the topics, two pages each, so it keeps changing.
  // "next" is "<feed id>|<topic index>|<page in topic>|<YouTube page token>".
  final _shortFeeds = <String, List<String>>{};
  final _shortsSeen = <String>{};

  Future<Map<String, dynamic>> _shorts(String? next) async {
    String feed;
    var index = 0, page = 0;
    String? token;
    if (next == null) {
      feed = '${DateTime.now().millisecondsSinceEpoch}';
      _shortFeeds[feed] = _shortQueries();
      _shortsSeen.clear();
    } else {
      final parts = next.split('|');
      feed = parts[0];
      index = int.parse(parts[1]);
      page = int.parse(parts[2]);
      final t = parts.sublist(3).join('|');
      token = t.isEmpty ? null : t;
    }
    final queries = _shortFeeds[feed] ?? (_shortFeeds[feed] = _shortQueries());
    final items = <dynamic>[];
    // Keep asking until we have a screenful of new Shorts or run out of topics.
    while (items.length < 8 && index < queries.length) {
      final r = await _call('shorts', {'q': queries[index], 'next': token}) as Map;
      for (final s in r['items'] as List) {
        if (_shortsSeen.add(s['id'] as String)) items.add(s);
      }
      token = r['next'] as String?;
      if (token != null && page < 1) {
        page++;
      } else {
        index++;
        page = 0;
        token = null;
      }
    }
    items.shuffle(_random);
    return {'items': items, 'next': index < queries.length ? '$feed|$index|$page|${token ?? ''}' : null};
  }

  // ------------------------------------------------------------------ offline

  Future<void> _offlineRoute(HttpRequest req, String? id, String? action) async {
    final res = req.response;
    Map<String, dynamic> body() => {};
    Future<Map<String, dynamic>> readBody() async {
      final text = await utf8.decodeStream(req);
      return text.isEmpty ? body() : (jsonDecode(text) as Map).cast<String, dynamic>();
    }

    if (id == null) {
      final list = _offline.downloads.values.toList()..sort((a, b) => (b['addedAt'] as int).compareTo(a['addedAt'] as int));
      return _json(res, {
        'downloads': [
          for (final d in list)
            {
              ...d,
              'item': {...(d['item'] as Map), if (d['status'] == 'done') 'thumb': '/offline/${d['id']}/thumb.jpg'},
              'progress': (d['total'] as int) > 0 ? (d['done'] as int) / (d['total'] as int) : 0,
            },
        ],
        'downloadsBytes': _offline.downloadsBytes,
        'shorts': {'count': _offline.shorts.length, 'bytes': _offline.shortsBytes, 'limit': Offline.shortsCacheLimit},
      });
    }
    if (id == 'shorts') {
      if (req.method == 'POST') {
        final items = ((await readBody())['items'] as List? ?? []).cast<Map>().map((m) => m.cast<String, dynamic>()).toList();
        _offline.cacheShorts(items);
        return _json(res, {'ok': true});
      }
      if (req.method == 'DELETE') {
        await _offline.clearShorts();
        return _json(res, {'ok': true});
      }
      return _json(res, {'items': _offline.cachedShortItems(), 'next': null, 'offline': true});
    }
    switch (req.method) {
      case 'GET':
        final d = _offline.downloads[id];
        if (d != null && d['status'] != 'failed') {
          return _json(res, {'status': d['status'], 'progress': (d['total'] as int) > 0 ? (d['done'] as int) / (d['total'] as int) : 0, 'options': []});
        }
        return _json(res, await _offline.options(id));
      case 'POST':
        if (action == 'retry') {
          await _offline.retry(id);
          return _json(res, {'ok': true});
        }
        final b = await readBody();
        await _offline.download(id, (b['height'] as num?)?.toInt() ?? 480, (b['video'] as Map? ?? {'id': id}).cast<String, dynamic>());
        return _json(res, {'ok': true});
      case 'DELETE':
        await _offline.remove(id);
        return _json(res, {'ok': true});
    }
    _json(res, {'error': 'Method not allowed'}, 405);
  }

  // Saved files, with Range support so <audio>/<video> can seek in them.
  Future<void> _file(HttpRequest req, File? f) async {
    final res = req.response;
    if (f == null || !await f.exists()) {
      res.statusCode = 404;
      return res.close();
    }
    final name = f.path.toLowerCase();
    res.headers.contentType = name.endsWith('.m3u8')
        ? _m3u8
        : name.endsWith('.ts')
            ? ContentType('video', 'mp2t')
            : name.endsWith('.m4a')
                ? ContentType('audio', 'mp4')
                : name.endsWith('.mp4')
                    ? ContentType('video', 'mp4')
                    : name.endsWith('.vtt')
                        ? ContentType('text', 'vtt', charset: 'utf-8')
                        : name.endsWith('.jpg')
                            ? ContentType('image', 'jpeg')
                            : ContentType.binary;
    res.headers.set('Accept-Ranges', 'bytes');
    final len = await f.length();
    final range = RegExp(r'bytes=(\d*)-(\d*)').firstMatch(req.headers.value(HttpHeaders.rangeHeader) ?? '');
    if (range != null) {
      final start = range[1]!.isEmpty ? max(0, len - int.parse(range[2]!)) : int.parse(range[1]!);
      final end = range[1]!.isNotEmpty && range[2]!.isNotEmpty ? min(int.parse(range[2]!), len - 1) : len - 1;
      if (start >= len) {
        res.statusCode = HttpStatus.requestedRangeNotSatisfiable;
        res.headers.set('Content-Range', 'bytes */$len');
        return res.close();
      }
      res.statusCode = HttpStatus.partialContent;
      res.headers.set('Content-Range', 'bytes $start-$end/$len');
      res.contentLength = end - start + 1;
      await res.addStream(f.openRead(start, end + 1));
    } else {
      res.contentLength = len;
      await res.addStream(f.openRead());
    }
    await res.close();
  }

  // ------------------------------------------------------------------ history

  Future<void> _historyRoute(HttpRequest req, String? id) async {
    final res = req.response;
    switch (req.method) {
      case 'GET':
        return _json(res, {'items': _history.items});
      case 'POST':
        final body = jsonDecode(await utf8.decodeStream(req)) as Map<String, dynamic>;
        final video = body['video'] as Map<String, dynamic>?;
        if (video == null || video['id'] is! String) return _json(res, {'error': 'Missing video'}, 400);
        await _history.add(video, (body['position'] as num?)?.round() ?? 0);
        return _json(res, {'ok': true});
      case 'DELETE':
        await (id == null ? _history.clear() : _history.remove(id));
        return _json(res, {'ok': true});
    }
    _json(res, {'error': 'Method not allowed'}, 405);
  }

  // ------------------------------------------------------------------ playback

  // The page can't fetch YouTube's HLS playlists itself (no CORS headers), so
  // they come through here. Every URI inside a playlist is rewritten to come
  // back through /api/hls on this same origin; segments are streamed through.
  static final _proxyHosts = RegExp(r'(^|\.)(googlevideo\.com|youtube\.com)$');
  static final _m3u8 = ContentType('application', 'vnd.apple.mpegurl', charset: 'utf-8');
  final _http = HttpClient()
    ..userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'
    ..connectionTimeout = const Duration(seconds: 15);

  Uri? _allowed(HttpRequest req) {
    final url = Uri.tryParse(req.uri.queryParameters['u'] ?? '');
    if (url == null || url.scheme != 'https' || !_proxyHosts.hasMatch(url.host)) return null;
    return url;
  }

  // The URL a response actually came from, after redirects (relative URIs resolve against it).
  static Uri _finalUrl(Uri url, HttpClientResponse res) => res.redirects.fold(url, (u, r) => u.resolveUri(r.location));

  // GET /api/hls?u=<url> -> playlist (rewritten) or media segment (streamed)
  Future<void> _hls(HttpRequest req) async {
    final url = _allowed(req);
    if (url == null) return _json(req.response, {'error': 'Host not allowed'}, 403);
    final up = await (await _http.getUrl(url)).close();
    final out = req.response;
    if (up.statusCode != 200) {
      await up.drain<void>();
      out.statusCode = up.statusCode;
      return out.close();
    }
    final type = up.headers.contentType?.mimeType.toLowerCase() ?? '';
    if (type.contains('mpegurl') || url.path.endsWith('.m3u8') || url.path.contains('/hls_playlist/') || url.path.contains('/hls_variant/')) {
      out.headers.contentType = _m3u8;
      out.headers.set('Cache-Control', 'no-cache');
      out.write(rewritePlaylist(await utf8.decodeStream(up), _finalUrl(url, up)));
      return out.close();
    }
    out.headers.contentType = up.headers.contentType ?? ContentType('video', 'mp2t');
    if (up.contentLength >= 0) out.contentLength = up.contentLength;
    await out.addStream(up);
    await out.close();
  }

  static String rewritePlaylist(String text, Uri base) {
    String proxied(String uri) => '/api/hls?u=${Uri.encodeComponent(base.resolve(uri).removeFragment().toString())}';
    // Videos with AI dubs list several audio tracks with none marked default, so players
    // take the first one (often a dub). Make the original-language track the default, like YouTube does.
    final hasOriginal = text.contains(RegExp(r'TYPE=AUDIO[^\n]*NAME="[^"]*original"'));
    return const LineSplitter().convert(text).map((line) {
      final l = line.trim();
      if (l.isEmpty) return line;
      if (!l.startsWith('#')) return proxied(l);
      var out = line;
      if (hasOriginal && l.startsWith('#EXT-X-MEDIA:') && l.contains('TYPE=AUDIO')) {
        final original = RegExp(r'NAME="[^"]*original"').hasMatch(l);
        out = out.replaceAll(RegExp(r'DEFAULT=(YES|NO)'), 'DEFAULT=${original ? 'YES' : 'NO'}');
      }
      return out.replaceAllMapped(RegExp(r'URI="([^"]+)"'), (m) => 'URI="${proxied(m[1]!)}"');
    }).join('\n');
  }

  // GET /api/captions?u=<url> -> WebVTT text track
  Future<void> _captions(HttpRequest req) async {
    final url = _allowed(req);
    if (url == null) return _json(req.response, {'error': 'Host not allowed'}, 403);
    final up = await (await _http.getUrl(url)).close();
    final out = req.response;
    out.statusCode = up.statusCode;
    out.headers.contentType = ContentType('text', 'vtt', charset: 'utf-8');
    await out.addStream(up);
    await out.close();
  }

  // ------------------------------------------------------------------ plumbing

  Future<void> _asset(HttpResponse res, String path) async {
    if (path.contains('..')) return _json(res, {'error': 'Not found'}, 404);
    ByteData data;
    try {
      data = await rootBundle.load('assets/web/$path');
    } catch (_) {
      res.statusCode = 404;
      return res.close();
    }
    res.headers.contentType = _types[path.split('.').last.toLowerCase()] ?? ContentType.binary;
    res.headers.set('Cache-Control', 'no-cache');
    res.add(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes));
    await res.close();
  }

  void _json(HttpResponse res, Object? body, [int status = 200]) {
    res.statusCode = status;
    res.headers.contentType = ContentType.json;
    res.write(jsonEncode(body));
    res.close();
  }

  static final _types = {
    'html': ContentType.html,
    'css': ContentType('text', 'css', charset: 'utf-8'),
    'js': ContentType('text', 'javascript', charset: 'utf-8'),
    'json': ContentType.json,
    'svg': ContentType('image', 'svg+xml'),
    'jpg': ContentType('image', 'jpeg'),
    'jpeg': ContentType('image', 'jpeg'),
    'png': ContentType('image', 'png'),
    'webp': ContentType('image', 'webp'),
    'gif': ContentType('image', 'gif'),
    'woff2': ContentType('font', 'woff2'),
  };
}

/// Watch history, the only user data AST Tube keeps. Stored on the phone in
/// history.json; related.json caches each watched video's related list so Home
/// can be built without asking YouTube again.
class _History {
  _History(this._file, this._relatedFile, this.items, this.related);

  static const _max = 500;
  final File _file;
  final File _relatedFile;
  final List<Map<String, dynamic>> items;
  final Map<String, List<dynamic>> related;
  Future<void> _saving = Future.value();

  static Future<_History> open() async {
    final dir = await getApplicationSupportDirectory();
    final file = File('${dir.path}/history.json');
    final relatedFile = File('${dir.path}/related.json');
    List<Map<String, dynamic>> items = [];
    Map<String, List<dynamic>> related = {};
    try {
      items = (jsonDecode(await file.readAsString()) as List).cast<Map<String, dynamic>>();
    } catch (_) {}
    try {
      related = (jsonDecode(await relatedFile.readAsString()) as Map).cast<String, List<dynamic>>();
    } catch (_) {}
    return _History(file, relatedFile, items, related);
  }

  Future<void> add(Map<String, dynamic> video, int position) {
    items.removeWhere((h) => h['id'] == video['id']);
    items.insert(0, {...video, 'watchedAt': DateTime.now().millisecondsSinceEpoch, 'position': position});
    if (items.length > _max) items.removeRange(_max, items.length);
    return _save();
  }

  Future<void> remove(String id) {
    items.removeWhere((h) => h['id'] == id);
    related.remove(id);
    return _save();
  }

  Future<void> clear() {
    items.clear();
    related.clear();
    return _save();
  }

  /// Keeps related lists only for the 30 most recent history entries.
  void rememberRelated(String id, List<dynamic> list) {
    related[id] = list;
    final keep = items.take(30).map((h) => h['id']).toSet()..add(id);
    related.removeWhere((k, _) => !keep.contains(k));
    _save();
  }

  // Writes are chained so two saves never interleave.
  Future<void> _save() => _saving = _saving.then((_) async {
        await _file.writeAsString(jsonEncode(items));
        await _relatedFile.writeAsString(jsonEncode(related));
      }).catchError((_) {});
}
