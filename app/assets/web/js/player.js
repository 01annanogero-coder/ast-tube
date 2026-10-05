// The video player: hls.js (adaptive 144p-1080p) with a progressive MP4
// fallback, and AST Tube's own controls.
//
//   const p = createPlayer(container, { onEnded, onProgress, compact })
//   p.load(videoDetails, startAtSeconds); p.destroy();
'use strict';

function createPlayer(container, opts = {}) {
  const root = el(`<div class="player${opts.compact ? ' compact' : ''}">
    <video playsinline preload="auto"></video>
    <div class="pl-spin hidden"><span class="spinner"></span></div>
    <div class="pl-tapzones"><div data-zone="l"></div><div data-zone="c"></div><div data-zone="r"></div></div>
    <div class="pl-seekflash l hidden">${icon('rewind', 28)}<span>10 seconds</span></div>
    <div class="pl-seekflash r hidden">${icon('forward', 28)}<span>10 seconds</span></div>
    <div class="pl-controls">
      <div class="pl-top">
        <span class="pl-chapter"></span>
        <button class="pl-auto" aria-label="Autoplay"><span class="pl-auto-track"><span class="pl-auto-knob">${icon('play', 12)}</span></span></button>
        <button class="icon-btn pl-cc hidden" aria-label="Captions">${icon('cc')}</button>
        <button class="icon-btn pl-settings" aria-label="Settings">${icon('settings')}</button>
      </div>
      <div class="pl-center">
        <button class="icon-btn pl-rw" aria-label="Back 10 seconds">${icon('rewind', 30)}</button>
        <button class="pl-play" aria-label="Play">${icon('play', 34)}</button>
        <button class="icon-btn pl-ff" aria-label="Forward 10 seconds">${icon('forward', 30)}</button>
      </div>
      <div class="pl-bottom">
        <span class="pl-time">0:00 / 0:00</span>
        <span class="pl-live hidden">LIVE</span>
        <button class="icon-btn pl-fs" aria-label="Fullscreen">${icon('fullscreen')}</button>
      </div>
      <div class="pl-bar"><div class="pl-buf"></div><div class="pl-prog"></div><div class="pl-knob"></div></div>
    </div>
    <div class="pl-next hidden"></div>
    <div class="pl-error hidden"></div>
  </div>`);
  container.appendChild(root);

  const video = root.querySelector('video');
  const $ = (s) => root.querySelector(s);
  let hls = null, details = null, sources = [], captionsOn = -1, hideTimer = 0, nextTimer = 0, destroyed = false;
  let levels = []; // [{height, index}] for the quality menu
  let currentSource = -1; // index in sources when not using hls

  // ------------------------------------------------------------ loading

  function load(v, startAt = 0, { autoplay = true } = {}) {
    details = v;
    sources = v.sources || [];
    clearNext();
    $('.pl-error').classList.add('hidden');
    $('.pl-live').classList.toggle('hidden', !v.live);
    video.poster = v.thumb || '';
    for (const t of [...video.querySelectorAll('track')]) t.remove();
    (v.captions || []).forEach((c, i) => {
      const t = document.createElement('track');
      t.kind = 'subtitles'; t.label = c.label; t.srclang = c.lang; t.src = c.url;
      video.appendChild(t);
      t.track.mode = 'disabled';
      t.dataset.i = i;
    });
    $('.pl-cc').classList.toggle('hidden', !(v.captions || []).length);
    captionsOn = -1;
    const start = () => {
      if (startAt > 0) {
        const seek = () => { try { video.currentTime = startAt; } catch (e) {} };
        if (video.readyState >= 1) seek(); else video.addEventListener('loadedmetadata', seek, { once: true });
      }
      if (autoplay) video.play().catch(() => showControls(true));
      else showControls(true);
    };
    if (v.hls && window.Hls && Hls.isSupported()) {
      useHls(v.hls, start);
    } else if (sources.length) {
      useSource(0, start);
    } else {
      fail('This video can\'t be played here.');
    }
  }

  function useHls(url, then) {
    destroyHls();
    // Captions come from our own <track> elements, so hls.js's subtitle handling stays off.
    hls = new Hls({
      maxBufferLength: 30, maxMaxBufferLength: 60, startLevel: -1, capLevelToPlayerSize: false,
      enableWebVTT: false, enableIMSC1: false, enableCEA708Captions: false,
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      const seen = new Map();
      hls.levels.forEach((l, i) => {
        const h = l.height || 0;
        // Several variants share a height (H.264 / VP9); prefer H.264, it decodes everywhere.
        const avc = /avc1/.test(l.videoCodec || l.attrs && l.attrs.CODECS || '');
        if (!seen.has(h) || (avc && !seen.get(h).avc)) seen.set(h, { height: h, index: i, avc });
      });
      levels = [...seen.values()].sort((a, b) => b.height - a.height);
      // Preferred quality from Settings: the best level at or below it.
      const pref = Number(settings.quality);
      if (pref) {
        const pick = levels.find((l) => l.height <= pref) || levels[levels.length - 1];
        if (pick) hls.currentLevel = pick.index;
      }
      then();
    });
    let recovered = false;
    hls.on(Hls.Events.ERROR, (e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); return; }
      // Network trouble or unplayable stream: fall back to the progressive MP4.
      const at = video.currentTime;
      destroyHls();
      if (sources.length) useSource(0, () => { if (at) video.currentTime = at; video.play().catch(() => {}); });
      else fail('This video can\'t be played right now.');
    });
  }

  function useSource(i, then) {
    destroyHls();
    currentSource = i;
    levels = [];
    video.src = sources[i].url;
    video.load();
    then && then();
  }

  function destroyHls() {
    if (hls) { hls.destroy(); hls = null; }
    currentSource = -1;
  }

  function fail(msg) {
    const e = $('.pl-error');
    e.innerHTML = `${icon('wifiOff', 34)}<p>${esc(msg)}</p>`;
    if (details) {
      const a = el(`<a class="pill" href="${esc(ytUrl(details.id))}" target="_blank" rel="noopener">${icon('external', 18)} Open on YouTube</a>`);
      e.appendChild(a);
    }
    e.classList.remove('hidden');
  }

  // ------------------------------------------------------------ controls

  function showControls(stay) {
    root.classList.add('show-ctl');
    clearTimeout(hideTimer);
    if (!stay && !video.paused) hideTimer = setTimeout(() => root.classList.remove('show-ctl'), 3000);
  }
  function toggleControls() {
    if (root.classList.contains('show-ctl')) { root.classList.remove('show-ctl'); clearTimeout(hideTimer); }
    else showControls();
  }
  function togglePlay() { if (video.paused) video.play().catch(() => {}); else video.pause(); showControls(); }
  function seekBy(d, side) {
    if (!isFinite(video.duration) && !details.live) return;
    video.currentTime = Math.max(0, Math.min((video.duration || 0) - 0.5, video.currentTime + d));
    const f = $(`.pl-seekflash.${side}`);
    f.classList.remove('hidden'); f.classList.remove('pop'); void f.offsetWidth; f.classList.add('pop');
    clearTimeout(f._t); f._t = setTimeout(() => f.classList.add('hidden'), 650);
  }

  // Single tap toggles the controls; double tap on the sides seeks 10 s.
  let lastTap = 0, lastZone = '', tapTimer = 0;
  root.querySelector('.pl-tapzones').addEventListener('click', (e) => {
    const zone = e.target.dataset.zone || 'c';
    const now = Date.now();
    if (now - lastTap < 300 && zone === lastZone && zone !== 'c') {
      clearTimeout(tapTimer);
      seekBy(zone === 'l' ? -10 : 10, zone);
      lastTap = now; // allow triple tap = another 10 s
      return;
    }
    lastTap = now; lastZone = zone;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(toggleControls, zone === 'c' ? 0 : 260);
  });

  // Autoplay switch (same setting as in Settings).
  const paintAuto = () => $('.pl-auto').classList.toggle('on', !!settings.autoplay);
  paintAuto();
  const onSettings = (e) => { if (e.detail.key === 'autoplay') paintAuto(); };
  document.addEventListener('settings', onSettings);
  $('.pl-auto').onclick = (e) => {
    e.stopPropagation();
    saveSetting('autoplay', !settings.autoplay);
    toast(settings.autoplay ? 'Autoplay is on' : 'Autoplay is off');
    showControls();
  };

  $('.pl-play').onclick = (e) => { e.stopPropagation(); togglePlay(); };
  $('.pl-rw').onclick = (e) => { e.stopPropagation(); seekBy(-10, 'l'); showControls(); };
  $('.pl-ff').onclick = (e) => { e.stopPropagation(); seekBy(10, 'r'); showControls(); };
  $('.pl-fs').onclick = (e) => { e.stopPropagation(); toggleFullscreen(); };
  $('.pl-settings').onclick = (e) => { e.stopPropagation(); openSettings(); };
  $('.pl-cc').onclick = (e) => { e.stopPropagation(); captionsMenu(); };

  function toggleFullscreen() {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    const p = root.requestFullscreen ? root.requestFullscreen() : root.webkitRequestFullscreen && root.webkitRequestFullscreen();
    if (p && p.catch) p.catch(() => {});
  }
  const onFs = () => {
    const fs = document.fullscreenElement === root;
    root.classList.toggle('fs', fs);
    $('.pl-fs').innerHTML = icon(fs ? 'exitFullscreen' : 'fullscreen');
    document.body.classList.toggle('player-fs', fs);
  };
  document.addEventListener('fullscreenchange', onFs);

  // Progress bar: tap or drag to seek.
  const bar = $('.pl-bar');
  let dragging = false;
  function barSeek(clientX) {
    const r = bar.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    if (isFinite(video.duration)) video.currentTime = f * video.duration;
    paintTime(f * (video.duration || 0));
  }
  bar.addEventListener('pointerdown', (e) => { e.stopPropagation(); dragging = true; bar.setPointerCapture(e.pointerId); barSeek(e.clientX); showControls(true); });
  bar.addEventListener('pointermove', (e) => { if (dragging) barSeek(e.clientX); });
  bar.addEventListener('pointerup', (e) => { dragging = false; barSeek(e.clientX); showControls(); });
  bar.addEventListener('click', (e) => e.stopPropagation());

  function paintTime(at) {
    const d = video.duration;
    const t = at == null ? video.currentTime : at;
    if (details && details.live) {
      $('.pl-time').textContent = '';
    } else {
      $('.pl-time').textContent = `${duration(t)} / ${duration(isFinite(d) ? d : details ? details.duration : 0)}`;
    }
    const f = isFinite(d) && d > 0 ? t / d : 0;
    $('.pl-prog').style.width = `${f * 100}%`;
    $('.pl-knob').style.left = `${f * 100}%`;
    if (details && details.chapters && details.chapters.length) {
      let name = '';
      for (const c of details.chapters) if (c.start <= t) name = c.title;
      $('.pl-chapter').textContent = name;
    }
  }

  video.addEventListener('timeupdate', () => {
    if (!dragging) paintTime();
    if (opts.onProgress) opts.onProgress(video.currentTime);
  });
  video.addEventListener('progress', () => {
    const d = video.duration;
    if (!isFinite(d) || !video.buffered.length) return;
    $('.pl-buf').style.width = `${(video.buffered.end(video.buffered.length - 1) / d) * 100}%`;
  });
  video.addEventListener('play', () => { $('.pl-play').innerHTML = icon('pause', 34); showControls(); if (opts.onPlay) opts.onPlay(); });
  video.addEventListener('pause', () => { $('.pl-play').innerHTML = icon('play', 34); showControls(true); if (opts.onPause) opts.onPause(video.currentTime); });
  // Anything the media notification shows changed.
  for (const ev of ['play', 'pause', 'loadedmetadata', 'ratechange', 'seeked', 'ended']) {
    video.addEventListener(ev, () => opts.onState && opts.onState());
  }
  video.addEventListener('waiting', () => $('.pl-spin').classList.remove('hidden'));
  video.addEventListener('playing', () => $('.pl-spin').classList.add('hidden'));
  video.addEventListener('canplay', () => $('.pl-spin').classList.add('hidden'));
  video.addEventListener('ended', () => { showControls(true); if (opts.onEnded) opts.onEnded(); });
  video.addEventListener('error', () => {
    if (hls) return; // hls.js reports its own errors
    if (currentSource >= 0 && currentSource + 1 < sources.length) useSource(currentSource + 1, () => video.play().catch(() => {}));
    else if (details) fail('This video can\'t be played right now.');
  });

  // ------------------------------------------------------------ settings

  function qualityLabel() {
    if (hls) return hls.autoLevelEnabled ? `Auto${hls.currentLevel >= 0 && hls.levels[hls.currentLevel] ? ` (${hls.levels[hls.currentLevel].height}p)` : ''}` : `${hls.levels[hls.currentLevel].height}p`;
    return currentSource >= 0 ? sources[currentSource].quality : '';
  }

  function openSettings() {
    const s = openSheet({ cls: 'menu-sheet' });
    const rows = [
      { icon: 'quality', label: 'Quality', value: qualityLabel(), run: qualityMenu },
      { icon: 'speed', label: 'Playback speed', value: video.playbackRate === 1 ? 'Normal' : `${video.playbackRate}x`, run: speedMenu },
    ];
    if ((details.captions || []).length) rows.push({ icon: 'cc', label: 'Captions', value: captionsOn >= 0 ? details.captions[captionsOn].label : 'Off', run: captionsMenu });
    // Videos with dubbed versions: pick the language (the original is chosen by default).
    if (hls && hls.audioTracks && hls.audioTracks.length > 1) {
      const cur = hls.audioTracks[hls.audioTrack];
      rows.push({ icon: 'podcasts', label: 'Audio track', value: cur ? trackName(cur) : '', run: audioMenu });
    }
    for (const r of rows) {
      const b = el(`<button class="menu-item">${icon(r.icon, 22)}<span>${esc(r.label)}</span><em>${esc(r.value)}</em></button>`);
      b.onclick = () => { s.close(); r.run(); };
      s.body.appendChild(b);
    }
  }

  function choice(title, options, current, pick) {
    const s = openSheet({ title, cls: 'menu-sheet' });
    options.forEach((o, i) => {
      const b = el(`<button class="menu-item">${i === current ? icon('check', 22) : '<span class="ic-space"></span>'}<span>${esc(o)}</span></button>`);
      b.onclick = () => { s.close(); pick(i); };
      s.body.appendChild(b);
    });
  }

  function qualityMenu() {
    if (hls) {
      const opts = ['Auto', ...levels.map((l) => `${l.height}p`)];
      const cur = hls.autoLevelEnabled ? 0 : 1 + levels.findIndex((l) => l.index === hls.currentLevel);
      choice('Quality', opts, cur, (i) => {
        if (i === 0) hls.currentLevel = -1;
        else hls.currentLevel = levels[i - 1].index; // switches immediately
      });
    } else if (sources.length) {
      choice('Quality', sources.map((s) => s.quality), currentSource, (i) => {
        const at = video.currentTime, playing = !video.paused;
        useSource(i, () => {
          video.addEventListener('loadedmetadata', () => { video.currentTime = at; if (playing) video.play().catch(() => {}); }, { once: true });
        });
      });
    }
  }

  // "American English - original" -> "American English (original)", "Deutsch - dubbed-auto" -> "Deutsch (auto-dubbed)"
  function trackName(t) {
    const [lang, kind] = String(t.name || t.lang || 'Unknown').split(' - ');
    const k = { original: 'original', dubbed: 'dubbed', 'dubbed-auto': 'auto-dubbed' }[kind] || kind;
    return k ? `${lang} (${k})` : lang;
  }

  function audioMenu() {
    // hls.js lists each language once per quality group; show each language once.
    const seen = new Map();
    hls.audioTracks.forEach((t, i) => { const n = trackName(t); if (!seen.has(n)) seen.set(n, i); });
    const names = [...seen.keys()];
    const cur = names.indexOf(trackName(hls.audioTracks[hls.audioTrack] || {}));
    choice('Audio track', names, cur, (i) => { hls.audioTrack = seen.get(names[i]); });
  }

  const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  function speedMenu() {
    choice('Playback speed', speeds.map((v) => (v === 1 ? 'Normal' : `${v}x`)), speeds.indexOf(video.playbackRate), (i) => { video.playbackRate = speeds[i]; });
  }

  function captionsMenu() {
    const caps = details.captions || [];
    choice('Captions', ['Off', ...caps.map((c) => c.label)], captionsOn + 1, (i) => setCaptions(i - 1));
  }

  function setCaptions(i) {
    captionsOn = i;
    [...video.querySelectorAll('track')].forEach((t, j) => { t.track.mode = j === i ? 'showing' : 'disabled'; });
    $('.pl-cc').classList.toggle('on', i >= 0);
  }

  // ------------------------------------------------------------ up next

  function showNext(item, seconds, onGo) {
    const n = $('.pl-next');
    n.innerHTML = `<div class="pl-next-in">
      <span class="pl-next-label">Up next in <b>${seconds}</b></span>
      <div class="pl-next-title">${esc(item.title)}</div>
      <div class="pl-next-ch">${esc(item.channel || '')}</div>
      <div class="pl-next-row"><button class="pill">Cancel</button><button class="pill pill-accent">${icon('play', 16)} Play now</button></div>
    </div>`;
    n.classList.remove('hidden');
    let left = seconds;
    const b = n.querySelector('b');
    nextTimer = setInterval(() => {
      left -= 1;
      b.textContent = left;
      if (left <= 0) { clearNext(); onGo(); }
    }, 1000);
    n.querySelector('.pill').onclick = (e) => { e.stopPropagation(); clearNext(); };
    n.querySelector('.pill-accent').onclick = (e) => { e.stopPropagation(); clearNext(); onGo(); };
  }
  function clearNext() {
    clearInterval(nextTimer);
    $('.pl-next').classList.add('hidden');
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearNext();
    clearTimeout(hideTimer);
    document.removeEventListener('fullscreenchange', onFs);
    document.removeEventListener('settings', onSettings);
    if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
    destroyHls();
    video.pause();
    video.removeAttribute('src');
    video.load();
    root.remove();
  }

  return {
    el: root, video, load, destroy, showNext, clearNext, showControls,
    get time() { return video.currentTime; },
    get paused() { return video.paused; },
    get details() { return details; },
    play() { video.play().catch(() => {}); },
    pause() { video.pause(); },
    /** Stops and forgets the current video but keeps the player for the next one. */
    unload() {
      clearNext();
      destroyHls();
      video.pause();
      video.removeAttribute('src');
      video.load();
      details = null;
    },
    seek(t) { video.currentTime = t; video.play().catch(() => {}); },
  };
}
