import 'package:asttube/recommend.dart';
import 'package:flutter_test/flutter_test.dart';

final now = DateTime(2026, 10, 8, 12);
int daysAgo(double d) => now.millisecondsSinceEpoch - (d * 864e5).round();

Map<String, dynamic> watch(String id, {String ch = 'chA', String? cat, int dur = 600, int reached = 600, double ago = 0, bool short = false}) => {
      'type': short ? 'short' : 'video', 'id': id, 'title': id, 'channel': ch, 'channelId': 'UC$ch',
      'category': ?cat, 'duration': dur, 'maxPosition': reached, 'position': reached, 'watchedAt': daysAgo(ago),
    };

List<Map<String, dynamic>> related(String prefix, int n, {String? ch}) =>
    [for (var i = 0; i < n; i++) {'type': 'video', 'id': '$prefix$i', 'channel': ch ?? '$prefix-ch${i % 5}', 'channelId': 'UC${ch ?? '$prefix-ch${i % 5}'}'}];

void main() {
  group('dwell gate', () {
    test('an accidental tap does not count', () => expect(engagement(watch('a', reached: 5)), 0));
    test('2 minutes of a long video counts', () => expect(engagement(watch('a', dur: 3600, reached: 130)), greaterThan(0)));
    test('30% of a short video counts', () => expect(engagement(watch('a', dur: 200, reached: 61)), greaterThan(0)));
    test('a Short counts after half of it', () {
      expect(engagement(watch('s', dur: 20, reached: 4, short: true)), 0);
      expect(engagement(watch('s', dur: 20, reached: 11, short: true)), greaterThan(0));
    });
  });

  test('interest halves every 3 days', () {
    expect(decay(watch('a', ago: 0), now), closeTo(1, 0.001));
    expect(decay(watch('a', ago: 3), now), closeTo(0.5, 0.001));
    expect(decay(watch('a', ago: 6), now), closeTo(0.25, 0.001));
  });

  test('a binge is capped: 3 seeds per channel, 4 per topic', () {
    final history = [
      for (var i = 0; i < 6; i++) watch('blender$i', ch: 'BlenderGuru', cat: 'Education'),
      for (var i = 0; i < 3; i++) watch('tut$i', ch: 'Other$i', cat: 'Education'),
      watch('song', ch: 'Artist', cat: 'Music', ago: 2),
    ];
    final t = Taste.from(history, Blocklist(), now: now);
    expect(t.seeds.where((s) => s['channel'] == 'BlenderGuru').length, 3);
    expect(t.seeds.where((s) => s['category'] == 'Education').length, 4);
    expect(t.seeds.any((s) => s['id'] == 'song'), isTrue); // the older interest still gets a seed
    expect(t.topics.first.key, 'cat:Education');
  });

  test('accidental taps and blocked channels are not seeds', () {
    final t = Taste.from([watch('tap', reached: 3), watch('ok', ch: 'Good'), watch('bad', ch: 'Bad')],
        Blocklist(channels: {'UCBad': 'Bad'}), now: now);
    expect(t.seeds.map((s) => s['id']), ['ok']);
  });

  test('channels you return to need 2+ real watches', () {
    final t = Taste.from([watch('a1', ch: 'A'), watch('a2', ch: 'A'), watch('b1', ch: 'B')], Blocklist(), now: now);
    expect(t.channels.map((c) => c.name), ['A']);
  });

  test('Home: the main interest gets 2 of every 10 cards, a channel at most 2', () {
    final home = composeHome(
      interests: [related('blend', 40), related('music', 40)],
      curated: related('trend', 40),
      returning: related('guru', 40, ch: 'BlenderGuru'),
      skip: {},
      blocked: Blocklist(),
    );
    for (var b = 0; b + 10 <= 30; b += 10) {
      final block = home.sublist(b, b + 10);
      expect(block.where((i) => '${i['id']}'.startsWith('blend')).length, lessThanOrEqualTo(3));
      final perChannel = <String, int>{};
      for (final i in block) {
        perChannel[i['channel']] = (perChannel[i['channel']] ?? 0) + 1;
      }
      expect(perChannel.values.every((n) => n <= 2), isTrue, reason: 'block $b: $perChannel');
    }
  });

  test('Home: empty sources hand their slots on, watched and blocked never show', () {
    final home = composeHome(
      interests: [related('only', 30)],
      curated: [],
      returning: [],
      skip: {'only0'},
      blocked: Blocklist(videos: {'only1'}),
    );
    expect(home.length, 28);
    expect(home.any((i) => i['id'] == 'only0' || i['id'] == 'only1'), isFalse);
  });
}
