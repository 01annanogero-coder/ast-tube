// Shorts: a full-screen vertical feed, one Short per screen (scroll-snap).
//
// Getting a Short's stream takes YouTube several seconds, so the feed works
// ahead: the Short on screen and the next two each get their own player that
// starts buffering in advance, and details for a few more are requested early.
// Swiping then starts the next one at once. Players far from the screen are
// released to save memory and data.
'use strict';

function shortsScreen(screen, { id }) {
  screen.innerHTML = `
    <div class="shorts-feed"></div>
    <span class="shorts-title">Shorts</span>`;
  const feed = screen.querySelector('.shorts-feed');
  const details = new Map(); // id -> Promise<video details>
  const AHEAD = 2, DETAILS_AHEAD = 4;
  let current = null, next = null, loading = false, done = false, alive = true, lastSaved = 0;

  const getDetails = (sid) => {
    if (!details.has(sid)) details.set(sid, api(`/api/video/${encodeURIComponent(sid)}`).catch((e) => { details.delete(sid); throw e; }));
    return details.get(sid);
  };
  const slides = () => [...feed.querySelectorAll('.short')];

  function slide(s) {
    const sl = el(`<section class="short" data-id="${esc(s.id)}">
      <img class="short-poster" src="${esc(s.thumb)}" alt="" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/${esc(s.id)}/hqdefault.jpg'">
      <div class="short-tap"></div>
      <div class="short-paused hidden">${icon('play', 56)}</div>
      <div class="short-side">
        <div class="short-act act-like">${icon('thumbUp', 26)}<span>Like</span></div>
        <button class="short-act act-comments">${icon('comment', 26)}<span>Comments</span></button>
        <button class="short-act act-share">${icon('share', 26)}<span>Share</span></button>
        <button class="short-act act-more">${icon('moreH', 26)}</button>
      </div>
      <div class="short-info">
        <a class="short-ch"><span class="short-av"></span><b></b></a>
        <p class="short-text"></p>
      </div>
      <div class="short-prog"><i></i></div>
    </section>`);
    sl.querySelector('.short-text').textContent = s.title || '';
    sl.querySelector('.act-share').onclick = () => share(s.title, `https://youtube.com/shorts/${s.id}`);
    sl.querySelector('.act-comments').onclick = () => commentsSheet(s.id, null);
    sl.querySelector('.act-more').onclick = () => menuSheet([
      { icon: 'link', label: 'Copy link', run: () => copy(`https://youtube.com/shorts/${s.id}`) },
      { icon: 'external', label: 'Open on YouTube', run: () => window.open(`https://youtube.com/shorts/${s.id}`, '_blank') },
      { icon: 'close', label: 'Not interested', run: () => hideShort(sl, { video: { id: s.id } }) },
      ...(sl._details && sl._details.channel.id ? [{ icon: 'trash', label: `Don't recommend ${sl._details.channel.name}`, run: () => hideShort(sl, { channel: { id: sl._details.channel.id, name: sl._details.channel.name } }) }] : []),
    ]);
    sl.querySelector('.short-tap').onclick = () => {
      const v = sl._video;
      if (current !== sl || !v) return;
      if (v.paused) v.play().catch(() => {}); else v.pause();
    };
    sl._item = s;
    io.observe(sl);
    return sl;
  }

  // "Not interested": remember it, and move on to the next Short.
  async function hideShort(sl, body) {
    try { await post('/api/blocklist', body); } catch (e) { toast(e.message); return; }
    toast(body.video ? 'Short hidden. We\x27ll show fewer like it.' : `You won't see ${body.channel.name} in recommendations.`);
    const next = sl.nextElementSibling;
    if (next) next.scrollIntoView({ behavior: 'smooth' });
  }

  function fill(sl, v) {
    sl._details = v;
    const ch = sl.querySelector('.short-ch');
    if (v.channel.id) ch.href = `#/channel/${encodeURIComponent(v.channel.id)}`;
    ch.querySelector('.short-av').innerHTML = avatar(v.channel.avatar, v.channel.name, 32);
    ch.querySelector('b').textContent = v.channel.name;
    sl.querySelector('.short-text').textContent = v.title;
    if (v.likes >= 0) sl.querySelector('.act-like span').textContent = compact(v.likes);
  }

  // ------------------------------------------------------------ per-slide players

  function prepare(sl) {
    if (sl._video) return;
    const video = el('<video playsinline loop preload="auto"></video>');
    sl._video = video;
    sl.insertBefore(video, sl.querySelector('.short-tap'));
    video.addEventListener('playing', () => { video.classList.add('ready'); sl.querySelector('.short-paused').classList.add('hidden'); });
    video.addEventListener('pause', () => {
      if (current !== sl || !alive) return;
      sl.querySelector('.short-paused').classList.remove('hidden');
      saveHistory(sl);
    });
    // Shorts loop, so "how far" says little: count every second actually watched instead.
    let lastT = 0;
    sl._watched = sl._watched || 0;
    video.addEventListener('timeupdate', () => {
      const t = video.currentTime, d = t - lastT;
      lastT = t;
      if (current === sl && !video.paused && d > 0 && d < 2) sl._watched += d;
      if (current !== sl || !video.duration) return;
      sl.querySelector('.short-prog i').style.width = `${(video.currentTime / video.duration) * 100}%`;
      if (Date.now() - lastSaved > 15000) saveHistory(sl);
    });
    getDetails(sl.dataset.id).then((v) => {
      if (sl._video !== video || !alive) return;
      fill(sl, v);
      if (v.hls && window.Hls && Hls.isSupported()) {
        // Shorts are short: a small buffer is enough and keeps data use down for the ones ahead.
        const hls = new Hls({ maxBufferLength: 12, maxMaxBufferLength: 20, startLevel: -1 });
        sl._hls = hls;
        hls.loadSource(v.hls);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (e, d) => {
          if (d.fatal && v.sources.length) { hls.destroy(); sl._hls = null; video.src = v.sources[0].url; if (current === sl) video.play().catch(() => {}); }
        });
      } else if (v.sources.length) {
        video.src = v.sources[0].url;
      }
      if (current === sl) start(sl);
    }).catch((e) => { if (current === sl) toast(e.message); });
  }

  function release(sl) {
    if (!sl._video) return;
    if (sl._hls) { sl._hls.destroy(); sl._hls = null; }
    sl._video.pause();
    sl._video.removeAttribute('src');
    sl._video.load();
    sl._video.remove();
    sl._video = null;
  }

  function start(sl) {
    const v = sl._video;
    if (!v || !sl._details) return;
    v.currentTime = 0;
    v.play().catch(() => sl.querySelector('.short-paused').classList.remove('hidden'));
    saveHistory(sl);
  }

  function activate(sl) {
    if (current === sl) return;
    if (current && current !== sl) saveHistory(current); // the final watch time of the one we leave
    if (current && current._video) current._video.pause();
    current = sl;
    history.replaceState(null, '', `#/shorts/${sl.dataset.id}`);
    sl.querySelector('.short-paused').classList.add('hidden');
    const all = slides();
    const at = all.indexOf(sl);
    all.forEach((s, i) => {
      const d = i - at;
      if (d >= -1 && d <= AHEAD) prepare(s); else release(s);
      if (d > 0 && d <= DETAILS_AHEAD) getDetails(s.dataset.id).then((v) => fill(s, v)).catch(() => {});
    });
    if (sl._details) start(sl);
    if (all.length - at <= 5) loadMore();
    // Keep this one and the next few on the phone, so Shorts still play without internet.
    // Wi-Fi: the next 10; mobile data: the next 3.
    if (!isOffline()) post('/api/offline/shorts', { items: all.slice(at, at + 1 + (netMetered ? 3 : 10)).map((s) => s._item) }).catch(() => {});
  }

  // Reports seconds watched in total (loops included); the server keeps the highest value.
  function saveHistory(sl) {
    const t = sl._watched || 0;
    const v = sl._details;
    if (!v) return;
    lastSaved = Date.now();
    post('/api/history', {
      video: {
        type: 'short', id: sl.dataset.id, title: v.title, channel: v.channel.name, channelId: v.channel.id,
        channelAvatar: v.channel.avatar, verified: v.channel.verified, thumb: sl._item.thumb,
        duration: v.duration, views: v.views, published: v.published, live: false, short: true, category: v.category || "",
      },
      position: Math.floor(t),
    }).catch(() => {});
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting && e.intersectionRatio > 0.6) activate(e.target);
  }, { root: feed, threshold: [0.6] });

  async function loadMore() {
    if (loading || done) return;
    loading = true;
    try {
      const data = await api(isOffline() ? '/api/shorts?offline=1' : `/api/shorts${next ? `?next=${encodeURIComponent(next)}` : ''}`);
      if (!alive) return;
      if (data.offline) {
        const fresh = data.items.filter((i) => i.fresh).length;
        screen.querySelector('.shorts-title').innerHTML = `Shorts <span class="offline-tag">${icon('wifiOff', 14)} Offline · ${fresh} new · ${data.items.length - fresh} watched</span>`;
        if (!data.items.length && !feed.children.length) {
          feed.appendChild(el(`<div class="error-card offline-card">${icon('wifiOff', 40)}<p><b>No saved Shorts yet</b><br>Shorts you watch online are saved here to play without internet.</p><a class="pill" href="#/downloads">${icon('download', 18)} Downloads</a></div>`));
        }
      }
      for (const s of data.items) if (!feed.querySelector(`[data-id="${CSS.escape(s.id)}"]`)) feed.appendChild(slide(s));
      next = data.next;
      done = !next;
      // Newly added slides may be inside the look-ahead window.
      if (current) {
        const all = slides(), at = all.indexOf(current);
        all.forEach((s, i) => {
          const d = i - at;
          if (d > 0 && d <= AHEAD) prepare(s);
          if (d > 0 && d <= DETAILS_AHEAD) getDetails(s.dataset.id).catch(() => {});
        });
      }
    } catch (e) {
      if (!feed.children.length) feed.appendChild(errorCard(e.message, loadMore));
      else toast(e.message);
    } finally {
      loading = false;
    }
  }

  // Opened from a Short card: that one first.
  if (id) {
    const k = known.get(id);
    getDetails(id).catch(() => {});
    feed.appendChild(slide(k && k.type === 'short' ? k : { id, title: k ? k.title : '', thumb: `https://i.ytimg.com/vi/${id}/frame0.jpg` }));
  }
  loadMore();

  return () => {
    alive = false;
    io.disconnect();
    if (current && current._video && current._video.currentTime) saveHistory(current);
    slides().forEach(release);
  };
}
