// How AST Tube decides what you like, from the watch history alone (no searches,
// no server). Used by local_server.dart to build Home, the Shorts topics and the
// offline Shorts pool.
//
//  - Dwell gate: a video only counts once you've watched a fair part of it
//    (30% or 2 minutes; Shorts: half or 15 s). Accidental taps don't steer Home.
//  - Time decay: each watch fades by half every 3 days, so a binge on one topic
//    leads for a day or two and then gives way unless you keep watching it.
//  - Caps: at most 3 seeds per channel and 4 per topic, and Home is laid out in
//    fixed slots (see [composeHome]) so one interest can't fill the screen.
//  - Blocklist: "Not interested" videos and "Don't recommend" channels never show.

import 'dart:math';

const _halfLifeDays = 3.0;

bool isShortEntry(Map h) => h['type'] == 'short' || h['short'] == true;

/// How far into the video the user got (old entries only have the resume position).
num _reached(Map h) => (h['maxPosition'] as num?) ?? (h['position'] as num?) ?? 0;

/// 0 if the dwell gate isn't met, otherwise 0.5..1 by how much of it was watched.
double engagement(Map h) {
  final secs = _reached(h).toDouble();
  final dur = (h['duration'] as num?)?.toDouble() ?? 0;
  if (isShortEntry(h)) {
    final ok = dur > 0 ? secs >= min(15.0, dur * 0.5) : secs >= 15;
    return ok ? 0.5 + 0.5 * (dur > 0 ? min(1.0, secs / dur) : 0.5) : 0;
  }
  final ok = dur > 0 ? secs >= min(120.0, dur * 0.3) : secs >= 120; // live/unknown length: 2 minutes
  return ok ? 0.5 + 0.5 * (dur > 0 ? min(1.0, secs / dur) : 0.5) : 0;
}

double decay(Map h, DateTime now) {
  final at = (h['watchedAt'] as num?)?.toInt() ?? now.millisecondsSinceEpoch;
  final days = max(0, now.millisecondsSinceEpoch - at) / 864e5;
  return pow(0.5, days / _halfLifeDays).toDouble();
}

/// The topic a video belongs to: YouTube's category ("Music", "Education"...) when
/// known, otherwise its channel.
String topicOf(Map h) {
  final c = '${h['category'] ?? ''}'.trim();
  return c.isNotEmpty ? 'cat:$c' : 'ch:${h['channelId'] ?? h['channel'] ?? '?'}';
}

/// Things the user said they don't want recommended.
class Blocklist {
  Blocklist({Set<String>? videos, Map<String, String>? channels})
      : videos = videos ?? {},
        channels = channels ?? {};

  final Set<String> videos; // video ids
  final Map<String, String> channels; // channel id -> name (for Settings)

  bool blocks(Map item) {
    if (videos.contains(item['id']) || videos.contains(item['seed'])) return true;
    final ch = item['channelId'] ?? (item['channel'] is Map ? (item['channel'] as Map)['id'] : null);
    return ch != null && channels.containsKey(ch);
  }

  List<dynamic> filter(Iterable<dynamic> items) => [for (final i in items) if (!blocks(i as Map)) i];

  Map<String, dynamic> toJson() => {
        'videos': videos.toList(),
        'channels': [for (final e in channels.entries) {'id': e.key, 'name': e.value}],
      };

  static Blocklist fromJson(Map j) => Blocklist(
        videos: {for (final v in (j['videos'] as List? ?? [])) '$v'},
        channels: {for (final c in (j['channels'] as List? ?? [])) '${c['id']}': '${c['name'] ?? ''}'},
      );
}

/// The user's interests at a moment, from their history.
class Taste {
  Taste._(this.seeds, this.topics, this.channels, this.shortChannels);

  /// Long videos to base Home on, best first (gated, decayed, capped per channel/topic).
  final List<Map<String, dynamic>> seeds;

  /// Topics by total weight, strongest first; each with its seeds.
  final List<MapEntry<String, List<Map<String, dynamic>>>> topics;

  /// Channels watched properly at least twice, strongest first: "channels you return to".
  final List<({String id, String name, double weight})> channels;

  /// Channel names for Shorts topics, strongest first (from Shorts and videos).
  final List<String> shortChannels;

  bool get isEmpty => seeds.isEmpty;

  static Taste from(List<Map<String, dynamic>> history, Blocklist blocked, {DateTime? now, int maxSeeds = 10}) {
    now ??= DateTime.now();
    final scored = <(Map<String, dynamic>, double)>[];
    for (final h in history) {
      if (blocked.blocks(h)) continue;
      final w = engagement(h) * decay(h, now);
      if (w > 0) scored.add((h, w));
    }
    scored.sort((a, b) => b.$2.compareTo(a.$2));

    // Seeds: long videos only, capped so one channel or topic can't take over.
    final seeds = <Map<String, dynamic>>[];
    final perChannel = <String, int>{}, perTopic = <String, int>{};
    for (final (h, w) in scored) {
      if (isShortEntry(h)) continue;
      final ch = '${h['channelId'] ?? h['channel']}';
      final t = topicOf(h);
      if ((perChannel[ch] ?? 0) >= 3 || (perTopic[t] ?? 0) >= 4) continue;
      perChannel[ch] = (perChannel[ch] ?? 0) + 1;
      perTopic[t] = (perTopic[t] ?? 0) + 1;
      seeds.add({...h, '_weight': w});
      if (seeds.length >= maxSeeds) break;
    }

    final topicWeight = <String, double>{};
    final topicSeeds = <String, List<Map<String, dynamic>>>{};
    for (final s in seeds) {
      final t = topicOf(s);
      topicWeight[t] = (topicWeight[t] ?? 0) + (s['_weight'] as double);
      (topicSeeds[t] ??= []).add(s);
    }
    final topics = topicSeeds.entries.toList()..sort((a, b) => topicWeight[b.key]!.compareTo(topicWeight[a.key]!));

    // Channels you keep coming back to: 2+ properly watched long videos.
    final chWeight = <String, double>{}, chCount = <String, int>{}, chName = <String, String>{};
    for (final (h, w) in scored) {
      if (isShortEntry(h)) continue;
      final id = h['channelId'] as String?;
      if (id == null) continue;
      chWeight[id] = (chWeight[id] ?? 0) + w;
      chCount[id] = (chCount[id] ?? 0) + 1;
      chName[id] = '${h['channel'] ?? ''}';
    }
    final channels = [
      for (final id in chWeight.keys) if (chCount[id]! >= 2) (id: id, name: chName[id]!, weight: chWeight[id]!),
    ]..sort((a, b) => b.weight.compareTo(a.weight));

    final shortChannels = <String>[];
    for (final (h, _) in scored) {
      final name = '${h['channel'] ?? ''}';
      if (name.isNotEmpty && !shortChannels.contains(name)) shortChannels.add(name);
      if (shortChannels.length >= 5) break;
    }
    return Taste._(seeds, topics, channels, shortChannels);
  }
}

/// Lays out Home in repeating blocks of 10 so no single interest dominates:
///
///   1-2   main interest          (related videos of your strongest topic)
///   3-4   second interest
///   5-6   curated / trending     (YouTube's own lists, to get out of the bubble)
///   7     third interest, else curated
///   8-10  channels you return to (their latest uploads)
///
/// An empty source passes its slot to the next one. Within each block of 10 a channel
/// gets at most 2 cards. Items in [skip] (watched) and blocked items never appear.
List<dynamic> composeHome({
  required List<List<dynamic>> interests,
  required List<dynamic> curated,
  required List<dynamic> returning,
  required Set<dynamic> skip,
  required Blocklist blocked,
  int max = 400,
}) {
  final seen = <dynamic>{...skip};
  final queues = <String, List<dynamic>>{
    'i0': interests.isNotEmpty ? interests[0].toList() : [],
    'i1': interests.length > 1 ? interests[1].toList() : [],
    // Weaker interests share the third queue, round-robin.
    'i2': _roundRobin(interests.length > 2 ? interests.sublist(2) : const []),
    'cur': curated.toList(),
    'ch': returning.toList(),
  };
  const pattern = ['i0', 'i0', 'i1', 'i1', 'cur', 'cur', 'i2', 'ch', 'ch', 'ch'];
  const fallback = {
    'i0': ['i1', 'i2', 'ch', 'cur'],
    'i1': ['i0', 'i2', 'ch', 'cur'],
    'i2': ['cur', 'i1', 'i0', 'ch'],
    'cur': ['i2', 'i1', 'i0', 'ch'],
    'ch': ['i0', 'i1', 'i2', 'cur'],
  };
  final out = <dynamic>[];
  var block = <String, int>{}; // channel -> cards in the current block of 10

  dynamic take(String q) {
    final list = queues[q]!;
    for (var i = 0; i < list.length; i++) {
      final it = list[i] as Map;
      if (it['type'] != 'video') { list.removeAt(i--); continue; }
      if (seen.contains(it['id']) || blocked.blocks(it)) { list.removeAt(i--); continue; }
      final ch = '${it['channelId'] ?? it['channel']}';
      if ((block[ch] ?? 0) >= 2) continue; // try a different channel for this slot
      list.removeAt(i);
      seen.add(it['id']);
      block[ch] = (block[ch] ?? 0) + 1;
      return it;
    }
    return null;
  }

  while (out.length < max) {
    var added = 0;
    block = {};
    for (final slot in pattern) {
      var it = take(slot);
      for (final f in fallback[slot]!) {
        if (it != null) break;
        it = take(f);
      }
      if (it != null) {
        out.add(it);
        added++;
      }
    }
    if (added == 0) break; // every source is used up
  }
  return out;
}

List<dynamic> _roundRobin(List<List<dynamic>> lists) {
  final out = <dynamic>[];
  final longest = lists.fold<int>(0, (m, l) => l.length > m ? l.length : m);
  for (var i = 0; i < longest; i++) {
    for (final l in lists) {
      if (i < l.length) out.add(l[i]);
    }
  }
  return out;
}
