// The watch page. Unlike other screens it is one persistent layer, so the
// player can keep going while you browse:
//   full  - covers the app (route #/watch/<id>[?list=<mixId>])
//   mini  - a small draggable window that snaps to the nearest corner
//   closed
// It also owns the Mix queue (endless playlist), autoplay, history saving and
// the media notification used for background play.
'use strict';

const Watch = (() => {
  const layer = el(`<section class="watch hidden" aria-label="Video">
    <div class="watch-player"></div>
    <div class="mini-ctl">
      <div class="mini-tap"></div>
      <button class="icon-btn mini-play" aria-label="Play or pause">${icon('pause', 22)}</button>
      <button class="icon-btn mini-close" aria-label="Close">${icon('close', 22)}</button>
    </div>
    <div class="watch-body"></div>
  </section>`);
  document.body.appendChild(layer);
  const body = layer.querySelector('.watch-body');

  let mode = 'closed';
  let id = null; // video in the player
  let video = null; // its details from /api/video
  let loadToken = 0, lastSaved = 0, lastPush = 0, warmed = false, mediaOn = false;
  let queue = null; // Mix: { id, title, items, index, next, src: {id, seed}, loading, shuffle, open, seen }
  let corner = 'br';
  let pendingShuffle = null;

  // Background play. Android's WebView pauses <video> when the app is in the
  // background but lets <audio> continue, so while hidden we hand the sound
  // over to an audio-only stream and hand back to the video on return.
  const audio = new Audio();
  audio.preload = 'auto';
  let audioMode = false;
  // Only a pause the user asked for (player, mini player, notification, headset) stops
  // background play. Android pausing the video when we leave the app doesn't count.
  let userPaused = false;
  const media = () => (audioMode ? audio : player.video);
  const now = () => media().currentTime || 0;
  const isPaused = () => media().paused;

  function ended() {
    save(video ? video.duration : 0);
    if (!settings.autoplay) return;
    if (queue) { playNext(); return; }
    const n = nextItem();
    if (!n) return;
    // Full page: a short countdown you can cancel. Mini or background: just go.
    if (mode === 'full' && !document.hidden) player.showNext(n, 5, () => navigate(n));
    else navigate(n);
  }

  const player = createPlayer(layer.querySelector('.watch-player'), {
    onUserPlay() { userPaused = false; },
    onUserPause() { userPaused = true; },
    onPlay() {
      save(player.time);
      // Up next is likely; have it ready when this one ends.
      if (!warmed && video) {
        warmed = true;
        setTimeout(() => { const n = nextItem(); if (n && video) prefetch(n.id); }, 8000);
      }
    },
    onPause(t) { save(t); },
    onProgress(t) {
      if (audioMode) return;
      if (Date.now() - lastSaved > 15000) save(t);
      if (Date.now() - lastPush > 30000) pushMedia();
    },
    onEnded() { if (!audioMode) ended(); },
    onState() { if (!audioMode) paintState(); },
  });

  function paintState() {
    layer.querySelector('.mini-play').innerHTML = icon(isPaused() ? 'play' : 'pause', 22);
    pushMedia();
  }

  audio.addEventListener('ended', () => { if (audioMode) ended(); });
  for (const ev of ['play', 'pause', 'seeked', 'loadedmetadata']) audio.addEventListener(ev, () => { if (audioMode) paintState(); });
  audio.addEventListener('timeupdate', () => {
    if (!audioMode) return;
    if (Date.now() - lastSaved > 15000) save(audio.currentTime);
    if (Date.now() - lastPush > 30000) pushMedia();
  });
  // If the audio-only stream fails, there's nothing else we can play in the background.
  audio.addEventListener('error', () => { if (audioMode && audio.src) toast('Background play failed for this video'); });

  function toAudio() {
    if (audioMode || !id || !settings.background || userPaused) return;
    // Still loading: switch now; load() starts the audio as soon as the details arrive.
    if (!video) { audioMode = true; return; }
    if (!video.audio) return; // live streams have no separate audio track
    audioMode = true;
    // Left during the "Up next" countdown (or right at the end): go straight to the next one.
    if (player.video.ended) { player.clearNext(); player.pause(); ended(); return; }
    const t = player.time;
    player.pause();
    audio.src = video.audio;
    audio.playbackRate = player.video.playbackRate;
    audio.currentTime = t;
    audio.play().catch(() => {});
  }

  function toVideo() {
    if (!audioMode) return;
    const t = audio.currentTime, play = !userPaused;
    audio.pause();
    audioMode = false;
    if (!video) { paintState(); return; } // still loading: it will start as video
    if (!player.details) player.load(video, t, { autoplay: play });
    else {
      player.video.currentTime = t;
      if (play) player.play();
    }
    paintState();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { toVideo(); return; }
    if (!settings.background) { player.pause(); audio.pause(); return; }
    // The WebView is about to pause the video; hand over to audio now.
    toAudio();
  });

  // ------------------------------------------------------------ modes

  function setMode(m) {
    if (mode === m) return;
    mode = m;
    layer.classList.toggle('hidden', m === 'closed');
    layer.classList.toggle('mini', m === 'mini');
    document.body.dataset.watch = m;
    if (m === 'mini') {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      player.clearNext();
      requestAnimationFrame(() => place(corner, false));
    } else {
      layer.style.transform = '';
    }
  }

  function open(newId, list) {
    setMode('full');
    if (newId === id && (video || loadToken)) {
      if (list && (!queue || queue.id !== list)) { startQueue(list, newId); renderQueue(); }
      if (!list && queue) { queue = null; renderQueue(); }
      return;
    }
    load(newId, list);
  }

  function minimize() {
    if (mode !== 'full') return;
    if (id) setMode('mini'); else close();
  }

  function close() {
    if (id && video && now() > 0) save(now());
    player.unload();
    audio.pause();
    audio.removeAttribute('src');
    audioMode = false;
    userPaused = false;
    id = null; video = null; queue = null; loadToken++;
    body.innerHTML = '';
    setMode('closed');
    if (mediaOn && window.AstNative) AstNative.postMessage(JSON.stringify({ type: 'mediaStop' }));
    mediaOn = false;
  }

  const watchHash = () => `#/watch/${id}${queue ? `?list=${encodeURIComponent(queue.id)}` : ''}`;

  // Go to another video. On the full page that's a real navigation (so Back
  // works); in the mini player or in the background it just switches videos.
  function navigate(item) {
    // Replace, not push: Back from the player always returns to the screen under it.
    if (mode === 'full' && !document.hidden) location.replace(`#/watch/${item.id}${queue ? `?list=${encodeURIComponent(queue.id)}` : ''}`);
    else load(item.id, queue && queue.id);
  }

  // ------------------------------------------------------------ loading

  function load(newId, list) {
    if (id && video && now() > 0) save(now());
    id = newId; video = null; warmed = false;
    userPaused = false; // a new video is meant to play
    const token = ++loadToken;
    if (stopRelated) { stopRelated(); stopRelated = null; }
    player.unload();
    if (audioMode) audio.pause();
    const preview = known.get(newId);
    player.video.poster = (preview && preview.thumb) || `https://i.ytimg.com/vi/${newId}/hqdefault.jpg`;
    body.innerHTML = `<div class="watch-head">${preview ? `<h1 class="watch-title">${esc(preview.title)}</h1>` : '<div class="skel skel-line"></div><div class="skel skel-line half"></div>'}</div>
      <div class="queue-slot"></div>`;
    if (mode === 'full') layer.scrollTop = 0;
    if (list) {
      if (!queue || queue.id !== list) startQueue(list, newId);
      else syncQueue(newId);
    } else {
      queue = null;
    }
    renderQueue();
    // Switched videos without a navigation (background, mini player): keep the address in step.
    if (mode === 'full' && location.hash.startsWith('#/watch/') && location.hash !== watchHash()) history.replaceState(null, '', watchHash());
    Promise.all([api(`/api/video/${encodeURIComponent(newId)}`), api('/api/history').catch(() => ({ items: [] }))]).then(([v, h]) => {
      if (token !== loadToken) return;
      video = v;
      const hist = (h.items || []).find((x) => x.id === newId);
      let start = 0;
      if (hist && hist.type !== 'short' && !v.short && hist.position > 10 && v.duration > 0 && hist.position < v.duration - 15) start = hist.position;
      if (audioMode) {
        // Still in the background (e.g. the Mix moved on): keep going on audio.
        player.load(v, start, { autoplay: false });
        if (v.audio) {
          audio.src = v.audio;
          audio.currentTime = start;
          audio.play().catch(() => {});
        }
      } else {
        player.load(v, start);
      }
      renderDetails(v);
      pushMedia();
    }).catch((e) => {
      if (token !== loadToken) return;
      body.innerHTML = '';
      body.appendChild(errorCard(e.message, () => load(newId, list)));
      // In a Mix, skip what can't be played.
      if (queue && settings.autoplay) setTimeout(() => { if (token === loadToken) playNext(); }, 2500);
    });
  }

  function save(t) {
    if (!video || !id) return;
    lastSaved = Date.now();
    watched.set(id, { position: Math.floor(t || 0), duration: video.duration });
    const preview = known.get(id);
    post('/api/history', {
      video: {
        type: 'video', id, title: video.title, channel: video.channel.name, channelId: video.channel.id,
        channelAvatar: video.channel.avatar, verified: video.channel.verified,
        thumb: (preview && preview.type === 'video' && preview.thumb) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        duration: video.duration, views: video.views, published: video.published, live: video.live, short: false, category: video.category || "",
      },
      position: Math.floor(t || 0),
    }).catch(() => {});
  }

  // ------------------------------------------------------------ details

  function renderDetails(v) {
    remember(v.related);
    const vid = id;
    body.innerHTML = `
      <div class="watch-head" role="button">
        <h1 class="watch-title">${esc(v.title)}</h1>
        <p class="watch-meta">${dot(views(v.views, v.live), ago(v.published))} <b class="more-link">...more</b></p>
      </div>
      <div class="watch-channel">
        <a class="wc-link" ${v.channel.id ? `href="#/channel/${esc(v.channel.id)}"` : ''}>
          ${avatar(v.channel.avatar, v.channel.name, 40)}
          <div><b>${esc(v.channel.name)}${v.channel.verified ? icon('verified', 14, 'vf') : ''}</b>
          <span>${v.channel.subs >= 0 ? `${compact(v.channel.subs)} subscribers` : ''}</span></div>
        </a>
      </div>
      <div class="actions">
        ${v.likes >= 0 ? `<span class="pill">${icon('thumbUp', 18)} ${compact(v.likes)}</span>` : ''}
        ${queue ? '' : `<button class="pill pill-accent act-mix">${icon('live', 18)} Mix</button>`}
        <button class="pill act-dl">${icon('download', 18)} Download</button>
        <button class="pill act-share">${icon('share', 18)} Share</button>
        <a class="pill" href="${esc(ytUrl(vid))}" target="_blank" rel="noopener">${icon('external', 18)} Open on YouTube</a>
      </div>
      <div class="queue-slot"></div>
      <button class="comments-teaser">
        <div class="ct-head"><b>Comments</b><span class="ct-count"></span><span class="grow"></span>${icon('chevronDown', 20)}</div>
        <div class="ct-first"><span class="skel skel-line"></span></div>
      </button>
      <h2 class="upnext">Up next</h2>
      <div class="related"></div>`;
    body.querySelector('.watch-head').onclick = () => descriptionSheet(v, player);
    body.querySelector('.act-share').onclick = () => share(v.title, ytUrl(vid));
    downloadButton(vid, v, body.querySelector('.act-dl'));
    const mixBtn = body.querySelector('.act-mix');
    if (mixBtn) mixBtn.onclick = () => location.replace(`#/watch/${vid}?list=RD${vid}`);
    renderQueue();

    const rel = body.querySelector('.related');
    const shorts = v.related.filter((r) => r.type === 'short');
    let n = 0;
    for (const r of v.related) {
      if (r.type === 'video') {
        rel.appendChild(videoCard(r));
        if (++n === 3 && shorts.length) rel.appendChild(shortsShelf(shorts));
      } else if (r.type === 'mix') {
        rel.appendChild(mixCard(r));
      }
    }
    if (!rel.children.length) rel.appendChild(el('<p class="empty">No related videos.</p>'));
    endlessRelated(vid, rel, v.related);

    const teaser = body.querySelector('.comments-teaser');
    teaser.onclick = () => commentsSheet(vid, player);
    api(`/api/comments/${encodeURIComponent(vid)}`).then((c) => {
      if (vid !== id) return;
      const first = body.querySelector('.ct-first');
      if (!first) return;
      if (c.disabled) { first.textContent = 'Comments are turned off.'; teaser.onclick = null; return; }
      if (c.count > 0) body.querySelector('.ct-count').textContent = compact(c.count);
      const top = c.items[0];
      first.innerHTML = top ? `${avatar(top.avatar, top.author, 24)}<span>${esc(top.text)}</span>` : 'No comments yet.';
    }).catch(() => { const f = body.querySelector('.ct-first'); if (f) f.textContent = 'Tap to load comments'; });
  }

  // The Download button shows where the download is: Download / Waiting / 34% / Downloaded / Retry.
  function downloadButton(vid, v, btn) {
    const item = {
      type: 'video', id: vid, title: v.title, channel: v.channel.name, channelId: v.channel.id,
      channelAvatar: v.channel.avatar, verified: v.channel.verified, thumb: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
      duration: v.duration, views: v.views, published: v.published, live: v.live, short: false,
    };
    let timer = 0;
    const paint = async () => {
      clearTimeout(timer);
      if (vid !== id || !btn.isConnected) return;
      let d = null;
      try { d = (await api('/api/offline')).downloads.find((x) => x.id === vid); } catch (e) { /* offline server error: leave as is */ }
      if (v.offline && !d) d = { status: 'done' };
      const st = d ? d.status : null;
      btn.innerHTML = st === 'done' ? `${icon('downloaded', 18)} Downloaded`
        : st === 'downloading' ? `${icon('download', 18)} ${Math.floor((d.progress || 0) * 100)}%`
        : st === 'queued' ? `${icon('download', 18)} Waiting…`
        : st === 'failed' ? `${icon('refresh', 18)} Retry download`
        : `${icon('download', 18)} Download`;
      btn.classList.toggle('pill-accent', st === 'done');
      btn.onclick = () => {
        if (st === 'done' || st === 'downloading' || st === 'queued') {
          menuSheet([
            { icon: 'download', label: 'Open Downloads', run: () => go('#/downloads') },
            { icon: 'trash', label: st === 'done' ? 'Delete download' : 'Cancel download', run: async () => { await api(`/api/offline/${vid}`, { method: 'DELETE' }).catch(() => {}); toast('Download removed'); paint(); } },
          ]);
        } else if (st === 'failed') {
          post(`/api/offline/${vid}/retry`, {}).then(paint).catch((e) => toast(e.message));
        } else {
          downloadSheet(item, paint);
        }
      };
      if (st === 'downloading' || st === 'queued') timer = setTimeout(paint, 1500);
    };
    paint();
  }

  // Up next keeps going as you scroll (like Home), with Shorts shelves mixed in.
  let stopRelated = null;
  function endlessRelated(vid, rel, first) {
    if (stopRelated) stopRelated();
    const shown = new Set([vid, ...first.map((r) => r.id)]);
    const sentinel = el('<div class="sentinel"></div>');
    rel.after(sentinel);
    let next = null;
    stopRelated = infinite(layer, sentinel, async () => {
      if (vid !== id) return false;
      const spin = spinner();
      rel.appendChild(spin);
      try {
        const r = await api(`/api/related/${encodeURIComponent(vid)}${next ? `?next=${encodeURIComponent(next)}` : ''}`);
        if (vid !== id) return false;
        const fresh = (r.items || []).filter((i) => !shown.has(i.id));
        fresh.forEach((i) => shown.add(i.id));
        remember(fresh);
        const shorts = (r.shorts || []).filter((s) => !shown.has(s.id));
        fresh.forEach((it, i) => {
          const c = anyCard(it);
          if (c) rel.appendChild(c);
          // A Shorts shelf partway through the page, like YouTube.
          if (i === 3 && shorts.length) { remember(shorts); rel.appendChild(shortsShelf(shorts)); }
        });
        if (fresh.length <= 3 && shorts.length) { remember(shorts); rel.appendChild(shortsShelf(shorts)); }
        next = r.next;
        return !!next;
      } catch (e) {
        await new Promise((r) => setTimeout(r, 3000));
        return true; // try again on the next scroll
      } finally {
        spin.remove();
      }
    });
  }

  // ------------------------------------------------------------ Mix queue

  // A queue is a Mix (list=RD..., endless) or a playlist/series (list=PL..., plays in order and ends).
  const listUrl = (q, next) => (q.kind === 'mix'
    ? `/api/mix/${encodeURIComponent(q.src.id)}?seed=${encodeURIComponent(q.src.seed)}`
    : `/api/playlist/${encodeURIComponent(q.id)}`) + (next ? `${q.kind === 'mix' ? '&' : '?'}next=${encodeURIComponent(next)}` : '');

  function startQueue(list, seedId) {
    const kind = list.startsWith('RD') ? 'mix' : 'playlist';
    const seed = list.startsWith('RD') && list.length === 13 ? list.slice(2) : seedId;
    const q = queue = { kind, id: list, title: '', channel: '', count: -1, items: [], index: 0, next: null, src: { id: list, seed }, loading: false, shuffle: false, open: false, seen: new Set(), misses: 0 };
    // "Shuffle" from a playlist page asks for a shuffled queue.
    if (pendingShuffle === list) { q.shuffle = true; pendingShuffle = null; }
    q.loading = true;
    api(listUrl(q)).then((r) => {
      if (queue !== q) return;
      q.title = r.title;
      q.channel = r.channel || '';
      q.count = r.count != null ? r.count : -1;
      if (q.shuffle) {
        // Keep the video that's playing first, shuffle the rest.
        const first = (r.items || []).filter((i) => i.id === id);
        add(q, first);
        q.shuffle = false; add(q, shuffled((r.items || []).filter((i) => i.id !== id))); q.shuffle = true;
      } else {
        add(q, r.items);
      }
      q.next = r.next;
      q.loading = false;
      syncQueue(id);
      renderQueue();
      pushMedia();
    }).catch((e) => {
      if (queue !== q) return;
      q.loading = false;
      toast(`Couldn't load this ${kind === 'mix' ? 'Mix' : 'playlist'}: ${e.message}`);
    });
  }

  function add(q, items) {
    let fresh = (items || []).filter((i) => i.type === 'video' && !q.seen.has(i.id));
    fresh.forEach((i) => q.seen.add(i.id));
    if (q.shuffle) fresh = shuffled(fresh);
    remember(fresh);
    q.items.push(...fresh);
    return fresh.length;
  }

  function syncQueue(vid) {
    const q = queue;
    if (!q || !q.items.length) return;
    const i = q.items.findIndex((x) => x.id === vid);
    if (i >= 0) q.index = i;
    else {
      // Opened from outside the list: slot it in at the current position.
      const k = known.get(vid);
      q.items.splice(q.index + 1, 0, k && k.type === 'video' ? k : { type: 'video', id: vid, title: '', channel: '', thumb: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` });
      q.seen.add(vid);
      q.index += 1;
    }
    if (q.items.length - q.index <= 5) more(q);
  }

  // The Mix never ends: next page of this Mix, or a fresh Mix from a recent song.
  async function more(q) {
    if (q.loading || q.misses > 3) return;
    q.loading = true;
    try {
      let r;
      if (q.next) {
        r = await api(listUrl(q, q.next));
      } else if (q.kind === 'playlist') {
        return; // a series ends
      } else {
        const recent = q.items.slice(-8);
        const pick = recent[Math.floor(Math.random() * recent.length)];
        q.src = { id: `RD${pick.id}`, seed: pick.id };
        r = await api(`/api/mix/RD${pick.id}?seed=${pick.id}`);
      }
      if (queue !== q) return;
      q.next = r.next;
      q.misses = add(q, r.items) ? 0 : q.misses + 1;
    } catch (e) {
      q.misses++;
    } finally {
      q.loading = false;
    }
    if (queue === q) {
      renderQueue();
      if (q.items.length - q.index <= 5 && q.misses && q.misses <= 3) more(q);
    }
  }

  function shuffled(a) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  function renderQueue() {
    const slot = body.querySelector('.queue-slot');
    if (!slot) return;
    if (!queue) { slot.innerHTML = ''; return; }
    const q = queue;
    const nxt = q.items[q.index + 1];
    slot.innerHTML = `<div class="queue${q.open ? ' open' : ''}">
      <button class="queue-head">
        <span class="queue-ic">${icon(q.kind === 'mix' ? 'live' : 'list', 18)}</span>
        <div class="queue-text"><b>${q.kind === 'mix' ? 'Mix - ' : ''}${esc(q.title || (q.kind === 'mix' && video && video.title) || '')}</b>
        <span>${q.items.length ? `${q.index + 1} / ${q.kind === 'mix' ? '∞' : (q.count > 0 ? q.count : q.items.length)}` : 'Loading…'}${q.kind === 'playlist' && q.channel ? ` · ${esc(q.channel)}` : ''}${nxt ? ` · Next: ${esc(nxt.title)}` : (q.kind === 'playlist' && q.items.length && !q.next ? ' · Last video' : '')}</span></div>
        ${icon('chevronDown', 22, 'queue-chev')}
      </button>
      <div class="queue-tools">
        <button class="pill small q-shuffle${q.shuffle ? ' on' : ''}">${icon('refresh', 16)} Shuffle</button>
        <button class="pill small q-exit">${icon('close', 16)} Exit ${q.kind === 'mix' ? 'Mix' : 'playlist'}</button>
      </div>
      <div class="queue-list"></div>
    </div>`;
    slot.querySelector('.queue-head').onclick = () => { q.open = !q.open; renderQueue(); };
    slot.querySelector('.q-shuffle').onclick = () => {
      q.shuffle = !q.shuffle;
      if (q.shuffle) q.items.splice(q.index + 1, Infinity, ...shuffled(q.items.slice(q.index + 1)));
      toast(q.shuffle ? 'Shuffle on' : 'Shuffle off');
      renderQueue();
    };
    slot.querySelector('.q-exit').onclick = () => location.replace(`#/watch/${id}`);
    if (!q.open) return;
    const list = slot.querySelector('.queue-list');
    q.items.forEach((it, i) => {
      const row = el(`<button class="q-row${i === q.index ? ' current' : ''}">
        <span class="q-num">${i === q.index ? icon('play', 14) : i + 1}</span>
        <img src="${esc(it.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">
        <span class="q-text"><b>${esc(it.title)}</b><span>${esc(it.channel || '')}</span></span>
      </button>`);
      row.onclick = () => { if (i !== q.index) navigate(it); };
      list.appendChild(row);
    });
    const cur = list.querySelector('.current');
    if (cur) list.scrollTop = Math.max(0, cur.offsetTop - list.offsetTop - 60);
  }

  function nextItem() {
    if (queue) return queue.items[queue.index + 1] || null;
    return video ? video.related.find((r) => r.type === 'video') || null : null;
  }

  function playNext() {
    const n = nextItem();
    if (n) navigate(n);
    else if (queue) more(queue).then(() => { const m = nextItem(); if (m) navigate(m); });
  }

  function playPrev() {
    const p = queue && queue.index > 0 ? queue.items[queue.index - 1] : null;
    if (now() > 5 || !p) { media().currentTime = 0; media().play().catch(() => {}); } else navigate(p);
  }

  // ------------------------------------------------------------ media notification

  function pushMedia() {
    if (!window.AstNative || !id) return;
    const playing = !isPaused();
    if (!mediaOn && !playing) return; // the service may only start while we're in the foreground and playing
    mediaOn = true;
    lastPush = Date.now();
    const preview = known.get(id);
    AstNative.postMessage(JSON.stringify({
      type: 'media',
      state: {
        title: (video && video.title) || (preview && preview.title) || '',
        artist: (video && video.channel.name) || (preview && preview.channel) || '',
        artwork: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        playing,
        position: now(),
        duration: video && video.duration > 0 ? video.duration : 0,
        rate: media().playbackRate,
        hasNext: !!nextItem(),
        hasPrev: true,
      },
    }));
  }

  // Notification, lock screen and headset buttons (from the Flutter shell).
  window.astMedia = (action) => {
    if (action === 'play') { userPaused = false; media().play().catch(() => {}); }
    else if (action === 'pause') { userPaused = true; media().pause(); document.querySelectorAll('video').forEach((v) => v.pause()); }
    else if (action === 'next') playNext();
    else if (action === 'prev') playPrev();
    else if (action === 'close') close();
    else if (String(action).startsWith('seek:')) { media().currentTime = Number(action.slice(5)); pushMedia(); }
  };

  // ------------------------------------------------------------ mini player

  const MARGIN = 10;
  function place(c, animate) {
    const w = layer.offsetWidth, h = layer.offsetHeight;
    const nav = document.querySelector('.bottom-nav');
    const navH = nav ? nav.offsetHeight : 0;
    const x = c.includes('l') ? MARGIN : innerWidth - w - MARGIN;
    const y = c.includes('t') ? 64 : innerHeight - navH - h - MARGIN;
    layer.classList.toggle('snapping', animate);
    layer.style.transform = `translate(${x}px, ${y}px)`;
    if (animate) setTimeout(() => layer.classList.remove('snapping'), 260);
  }
  addEventListener('resize', () => { if (mode === 'mini') place(corner, false); });

  const tap = layer.querySelector('.mini-tap');
  let drag = null;
  tap.addEventListener('pointerdown', (e) => {
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(layer.style.transform) || [0, 0, 0];
    drag = { x0: e.clientX, y0: e.clientY, left: Number(m[1]), top: Number(m[2]), moved: false };
    tap.setPointerCapture(e.pointerId);
  });
  tap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) < 8) return;
    drag.moved = true;
    layer.style.transform = `translate(${drag.left + dx}px, ${drag.top + dy}px)`;
  });
  tap.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) { go(watchHash()); return; }
    // Snap to the closest corner.
    const r = layer.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    corner = `${cy < innerHeight / 2 ? 't' : 'b'}${cx < innerWidth / 2 ? 'l' : 'r'}`;
    place(corner, true);
  });
  tap.addEventListener('pointercancel', () => { drag = null; place(corner, true); });
  layer.querySelector('.mini-play').onclick = () => {
    if (isPaused()) { userPaused = false; media().play().catch(() => {}); } else { userPaused = true; media().pause(); }
  };
  layer.querySelector('.mini-close').onclick = close;

  return {
    open, minimize, close,
    /** The next queue for this list starts shuffled (Shuffle on a playlist page). */
    shuffleNext(list) { pendingShuffle = list; },
    pause() { player.pause(); },
    get mode() { return mode; },
  };
})();
