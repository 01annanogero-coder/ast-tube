// Small helpers shared by every screen: API calls, formatting, DOM, sheets, toasts.
'use strict';

// ---------------------------------------------------------------- API

async function api(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch (e) {
    throw new Error('No connection. Check your internet and try again.');
  }
  let body = null;
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
  return body;
}

const post = (path, data) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

// App preferences, kept by the local server (settings.json) so the native side can read them too.
const settings = { autoplay: true, background: true, quality: 'auto' };
const settingsReady = api('/api/settings').then((s) => Object.assign(settings, s)).catch(() => {});
function saveSetting(key, value) {
  settings[key] = value;
  post('/api/settings', { [key]: value }).catch(() => toast('Could not save that setting'));
  document.dispatchEvent(new CustomEvent('settings', { detail: { key, value } }));
}

// How far you got in each video (from the watch history), for the progress bar
// under thumbnails, like YouTube's red line.
const watched = new Map(); // id -> { position, duration }
const historyReady = api('/api/history').then((h) => {
  for (const it of h.items || []) watched.set(it.id, { position: it.position || 0, duration: it.duration || 0 });
}).catch(() => {});
function progressOf(id) {
  const w = watched.get(id);
  if (!w || !(w.duration > 0) || w.position < 5) return null;
  return w.position >= w.duration - 15 ? 1 : w.position / w.duration;
}
function progressBar(id, fraction) {
  const f = fraction != null ? fraction : progressOf(id);
  return f == null ? '' : `<div class="thumb-prog"><i style="width:${Math.max(3, Math.min(100, f * 100))}%"></i></div>`;
}
// Repaints the bars on cards already on screen (e.g. coming back to Home after watching).
function refreshProgress(root) {
  for (const card of root.querySelectorAll('.vcard[data-id], .vrow[data-id]')) {
    const thumb = card.querySelector('.thumb');
    if (!thumb) continue;
    const old = thumb.querySelector('.thumb-prog');
    const html = progressBar(card.dataset.id);
    if (old) old.remove();
    if (html) thumb.insertAdjacentHTML('beforeend', html);
  }
}

// Videos the user has seen in a list this session, so the watch page can show
// the title/thumbnail at once and history gets a complete VideoItem.
const known = new Map();
function remember(items) {
  for (const it of items || []) if (it && it.id && (it.type === 'video' || it.type === 'short')) {
    if (!known.has(it.id) || it.type === 'video') known.set(it.id, it);
  }
}

// Getting a video's streams takes YouTube several seconds, so start early:
// when a card is touched, and for the next video while one is playing.
const prefetched = new Set();
function prefetch(id) {
  if (!id || prefetched.has(id)) return;
  prefetched.add(id);
  fetch(`/api/video/${encodeURIComponent(id)}`).catch(() => prefetched.delete(id));
  setTimeout(() => prefetched.delete(id), 15 * 60 * 1000);
}
document.addEventListener('pointerdown', (e) => {
  const a = e.target.closest && e.target.closest('a[href^="#/watch/"], a[href^="#/shorts/"]');
  if (a) prefetch(a.getAttribute('href').split('/')[2]);
}, { passive: true });

// ---------------------------------------------------------------- formatting

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function compact(n) {
  if (n == null || n < 0) return '';
  const fmt = (v, unit) => (v >= 100 ? Math.floor(v) : Math.floor(v * 10) / 10).toString().replace(/\.0$/, '') + unit;
  if (n >= 1e9) return fmt(n / 1e9, 'B');
  if (n >= 1e6) return fmt(n / 1e6, 'M');
  if (n >= 1e3) return fmt(n / 1e3, 'K');
  return String(n);
}

function views(n, live) {
  if (n == null || n < 0) return '';
  if (live) return `${compact(n)} watching`;
  return n === 1 ? '1 view' : `${compact(n)} views`;
}

function duration(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// "2 years ago" -> "2y ago", the short form used on cards.
function ago(text) {
  if (!text) return '';
  // Watch pages give an ISO date ("2026-09-29T18:31:00-07:00"); make it relative.
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const t = Date.parse(text);
    if (isNaN(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    const units = [[31536000, 'y'], [2592000, 'mo'], [604800, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']];
    for (const [n, u] of units) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
    return 'just now';
  }
  return String(text)
    .replace(/^Streamed\s+/i, '')
    .replace(/(\d+)\s*years?/i, '$1y').replace(/(\d+)\s*months?/i, '$1mo').replace(/(\d+)\s*weeks?/i, '$1w')
    .replace(/(\d+)\s*days?/i, '$1d').replace(/(\d+)\s*hours?/i, '$1h').replace(/(\d+)\s*minutes?/i, '$1m')
    .replace(/(\d+)\s*seconds?/i, '$1s');
}

const dot = (...parts) => parts.filter(Boolean).map(esc).join(' <i class="sep">•</i> ');

// ---------------------------------------------------------------- DOM

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function go(hash) { if (location.hash !== hash) location.hash = hash; }

function avatar(url, name, size = 36) {
  if (url) return `<img class="avatar" src="${esc(url)}" width="${size}" height="${size}" loading="lazy" alt="" referrerpolicy="no-referrer">`;
  const letter = esc((name || '?').replace(/^@/, '').charAt(0).toUpperCase());
  return `<span class="avatar avatar-letter" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px">${letter}</span>`;
}

function toast(msg) {
  const t = el(`<div class="toast">${esc(msg)}</div>`);
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2200);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Link copied'); }
  catch (e) {
    const ta = el('<textarea style="position:fixed;opacity:0"></textarea>');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Link copied'); } catch (e2) { toast(text); }
    ta.remove();
  }
}

async function share(title, url) {
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  copy(url);
}

const ytUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

// Turns plain text into safe HTML with clickable links and (optionally) timestamps.
function linkify(text, withTimes) {
  let out = esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  if (withTimes) {
    out = out.replace(/(^|[\s(])((?:\d{1,2}:)?\d{1,2}:\d{2})(?=$|[\s),.])/gm, (m, pre, t) => {
      const secs = t.split(':').reduce((a, b) => a * 60 + Number(b), 0);
      return `${pre}<a href="#" class="ts" data-t="${secs}">${t}</a>`;
    });
  }
  return out;
}

// ---------------------------------------------------------------- sheets

// A bottom sheet. Returns { el, body, close }. Android back closes the top one.
const sheets = [];
function openSheet({ title = '', height = '', cls = '' } = {}) {
  const wrap = el(`<div class="sheet-wrap ${cls}">
    <div class="sheet-scrim"></div>
    <div class="sheet" style="${height ? `height:${height}` : ''}">
      <div class="sheet-grip"></div>
      ${title ? `<div class="sheet-head"><h3>${esc(title)}</h3><button class="icon-btn sheet-x" aria-label="Close">${icon('close')}</button></div>` : ''}
      <div class="sheet-body"></div>
    </div>
  </div>`);
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  const api = {
    el: wrap,
    body: wrap.querySelector('.sheet-body'),
    close() {
      const i = sheets.indexOf(api);
      if (i >= 0) sheets.splice(i, 1);
      wrap.classList.remove('open');
      setTimeout(() => wrap.remove(), 250);
      if (api.onClose) api.onClose();
    },
  };
  wrap.querySelector('.sheet-scrim').onclick = api.close;
  const x = wrap.querySelector('.sheet-x');
  if (x) x.onclick = api.close;
  sheets.push(api);
  return api;
}

// Simple list of actions in a sheet: [{icon, label, run}]
function menuSheet(actions) {
  const s = openSheet({ cls: 'menu-sheet' });
  for (const a of actions) {
    const b = el(`<button class="menu-item">${icon(a.icon, 22)}<span>${esc(a.label)}</span></button>`);
    b.onclick = () => { s.close(); a.run(); };
    s.body.appendChild(b);
  }
  return s;
}

function confirmSheet(text, okLabel, run) {
  const s = openSheet({ cls: 'confirm-sheet' });
  s.body.appendChild(el(`<p class="confirm-text">${esc(text)}</p>`));
  const row = el('<div class="confirm-row"><button class="pill">Cancel</button><button class="pill pill-accent"></button></div>');
  row.children[1].textContent = okLabel;
  row.children[0].onclick = s.close;
  row.children[1].onclick = () => { s.close(); run(); };
  s.body.appendChild(row);
}

// ---------------------------------------------------------------- lists

// Calls load() whenever the sentinel scrolls into view, until it returns false.
function infinite(root, sentinel, load) {
  let busy = false, done = false;
  const io = new IntersectionObserver(async (entries) => {
    if (!entries.some((e) => e.isIntersecting) || busy || done) return;
    busy = true;
    try { done = (await load()) === false; } catch (e) { /* the loader shows its own error */ }
    busy = false;
    if (done) { io.disconnect(); sentinel.remove(); }
    else if (sentinel.isConnected) {
      // Still visible (short page)? Ask again.
      const r = sentinel.getBoundingClientRect();
      if (r.top < (root.clientHeight || innerHeight) + 2500) { io.unobserve(sentinel); io.observe(sentinel); }
    }
  }, { root, rootMargin: '0px 0px 2500px 0px' });
  io.observe(sentinel);
  return () => io.disconnect();
}

function errorCard(message, retry) {
  // Offline: say so, and point at what still works (saved Shorts and downloads).
  if (isOffline()) {
    const c = el(`<div class="error-card offline-card">${icon('wifiOff', 40)}
      <p><b>You're offline</b><br>Connect to the internet to browse more videos.</p>
      <div class="offline-actions">
        <a class="pill pill-accent" href="#/shorts">${icon('shorts', 18)} Saved Shorts</a>
        <a class="pill" href="#/downloads">${icon('download', 18)} Downloads</a>
      </div>
      <button class="pill small">${icon('refresh', 16)} Retry</button></div>`);
    c.querySelector('button').onclick = () => { c.remove(); retry(); };
    return c;
  }
  const c = el(`<div class="error-card">${icon('wifiOff', 40)}<p>${esc(message)}</p><button class="pill pill-accent">${icon('refresh', 18)} Retry</button></div>`);
  c.querySelector('button').onclick = () => { c.remove(); retry(); };
  return c;
}

// ---------------------------------------------------------------- pull to refresh

// Pull down at the top of [scroller] to call onRefresh() (which resolves when the new content is in).
function pullToRefresh(scroller, onRefresh) {
  const ind = el(`<div class="ptr">${icon('refresh', 22)}</div>`);
  document.body.appendChild(ind);
  const ARM = 80;
  let y0 = null, d = 0, busy = false;
  const reset = () => { ind.classList.remove('show', 'armed', 'spin'); ind.style.transform = ''; };
  scroller.addEventListener('touchstart', (e) => {
    y0 = scroller.scrollTop <= 0 && !busy && !scroller.classList.contains('hidden') ? e.touches[0].clientY : null;
    d = 0;
  }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    d = e.touches[0].clientY - y0;
    if (d <= 0 || scroller.scrollTop > 0) { reset(); return; }
    const p = Math.min(d, 150);
    ind.classList.add('show');
    ind.classList.toggle('armed', d > ARM);
    ind.style.transform = `translate(-50%, ${p * 0.55}px) rotate(${p * 2.4}deg)`;
  }, { passive: true });
  scroller.addEventListener('touchend', async () => {
    if (y0 == null) return;
    y0 = null;
    if (d <= ARM || busy) { reset(); return; }
    busy = true;
    ind.classList.add('spin');
    ind.style.transform = 'translate(-50%, 48px)';
    try { await onRefresh(); } catch (e) { /* the screen shows its own error */ }
    setTimeout(() => { reset(); busy = false; }, 300);
  });
}

// Resolves when test() is true (checked every 150 ms), or after `ms`.
function waitFor(test, ms = 15000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => (test() || Date.now() - t0 > ms ? resolve() : setTimeout(tick, 150));
    tick();
  });
}

// ---------------------------------------------------------------- offline

// The real connection state comes from Android (the WebView's navigator.onLine always says true).
let netOnline = true;
const isOffline = () => !netOnline;
let appVersion = '';
const netReady = api('/api/net').then((r) => { netOnline = r.online !== false; appVersion = r.version || ''; }).catch(() => {});
window.astNet = (online) => {
  if (online === netOnline) return;
  netOnline = online;
  document.body.toggleAttribute('data-offline', !online);
  toast(online ? 'Back online' : "You're offline. Saved Shorts and downloads still play.");
  document.dispatchEvent(new CustomEvent('net', { detail: { online } }));
};

function size(bytes) {
  if (!(bytes > 0)) return '0 MB';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

// The "Download" sheet: pick a quality (with its size), then it downloads in the background.
async function downloadSheet(video, onChange) {
  const s = openSheet({ title: 'Download', cls: 'menu-sheet' });
  s.body.appendChild(spinner());
  let o;
  try { o = await api(`/api/offline/${encodeURIComponent(video.id)}`); } catch (e) {
    s.body.innerHTML = `<p class="confirm-text">${esc(isOffline() ? "You're offline. Downloads need internet." : e.message)}</p>`;
    return;
  }
  s.body.innerHTML = '';
  if (o.status === 'queued' || o.status === 'downloading') {
    s.body.innerHTML = `<p class="confirm-text">Already downloading. See Settings › Downloads.</p>`;
    return;
  }
  if (!o.options || !o.options.length) {
    s.body.innerHTML = `<p class="confirm-text">${esc(o.error || "This video can't be downloaded.")}</p>`;
    return;
  }
  s.body.appendChild(el('<p class="dl-note">Saved inside AST Tube on this phone. Plays without internet, including in the background.</p>'));
  for (const opt of o.options.slice().reverse()) {
    const b = el(`<button class="menu-item">${icon('quality', 22)}<span>${opt.height}p</span><em>${size(opt.bytes)}</em></button>`);
    b.onclick = async () => {
      s.close();
      try {
        await post(`/api/offline/${encodeURIComponent(video.id)}`, { height: opt.height, video });
        toast('Downloading. See Settings › Downloads');
        if (onChange) onChange();
      } catch (e) { toast(e.message); }
    };
    s.body.appendChild(b);
  }
}

function spinner() { return el('<div class="spinner-row"><span class="spinner"></span></div>'); }
