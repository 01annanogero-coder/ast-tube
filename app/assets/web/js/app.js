// Router, bottom navigation, splash and Android back handling.
'use strict';

const ROUTES = [
  [/^#?\/?$/, 'home', homeScreen, () => ({ chip: 'all' }), true],
  [/^#\/chip\/(\w+)$/, 'home', homeScreen, (m) => ({ chip: m[1] }), true],
  [/^#\/search(?:\?(.*))?$/, 'search', searchScreen, (m) => {
    const sp = new URLSearchParams(m[1] || '');
    return { q: sp.get('q') || '', f: sp.get('f') || 'all' };
  }, (p) => !!p.q],
  [/^#\/watch\/([\w-]{6,})(?:\?(.*))?$/, 'watch', null, (m) => ({ id: m[1], list: new URLSearchParams(m[2] || '').get('list') }), false],
  [/^#\/shorts(?:\/([\w-]{6,}))?$/, 'shorts', shortsScreen, (m) => ({ id: m[1] || null }), false],
  [/^#\/channel\/([^/]+)(?:\/(\w+))?$/, 'channel', channelScreen, (m) => ({ id: decodeURIComponent(m[1]), tab: m[2] || 'videos' }), true],
  [/^#\/playlist\/([\w-]+)$/, 'playlist', playlistScreen, (m) => ({ id: m[1] }), true],
  [/^#\/settings$/, 'settings', settingsScreen, () => ({}), false],
  [/^#\/history$/, 'history', historyScreen, () => ({}), false],
  [/^#\/downloads$/, 'downloads', downloadsScreen, () => ({}), false],
];

const app = document.getElementById('app');
const cache = new Map(); // route key -> { el, cleanup, scroll }
let current = null; // { key, el, cleanup, keep }

function route() {
  const hash = location.hash || '#/';
  // #/play/<playlist>[/shuffle]: start a playlist/series. Find its first video, then watch it in the queue.
  const play = hash.match(/^#\/play\/([\w-]+)(\/shuffle)?$/);
  if (play) {
    const list = play[1];
    api(`/api/playlist/${encodeURIComponent(list)}`).then((p) => {
      const items = (p.items || []).filter((i) => i.type === 'video');
      if (!items.length) { toast('This playlist is empty'); history.back(); return; }
      remember(items);
      const first = play[2] ? items[Math.floor(Math.random() * items.length)] : items[0];
      if (play[2]) Watch.shuffleNext(list);
      location.replace(`#/watch/${first.id}?list=${list}`);
    }).catch((e) => { toast(e.message); history.back(); });
    return;
  }

  let match = null;
  for (const [re, name, fn, params, keep] of ROUTES) {
    const m = hash.match(re);
    if (m) { const p = params(m); match = { name, fn, p, keep: typeof keep === 'function' ? keep(p) : keep }; break; }
  }
  if (!match) { location.replace('#/'); return; }

  // Close anything floating over the old screen.
  while (sheets.length) sheets[sheets.length - 1].close();

  // The watch page is a layer over the current screen, not a screen.
  if (match.name === 'watch') {
    if (!current) show('#/', ROUTES[0][2], { chip: 'all' }, 'home', true); // opened directly: Home underneath
    Watch.open(match.p.id, match.p.list);
    return;
  }
  Watch.minimize();
  if (match.name === 'shorts') Watch.pause(); // one thing playing at a time
  if (current && current.key === hash) { refreshProgress(current.el); return; }
  show(hash, match.fn, match.p, match.name, match.keep);
}

function show(key, fn, params, name, keep) {
  // Put the old screen away (kept screens stay in the DOM, hidden, with their scroll position).
  if (current) {
    if (current.keep) {
      cache.set(current.key, { el: current.el, cleanup: current.cleanup, scroll: current.el.scrollTop });
      current.el.classList.add('hidden');
    } else {
      if (current.cleanup) current.cleanup();
      current.el.remove();
    }
  }

  document.body.dataset.screen = name;
  paintNav();
  const kept = cache.get(key);
  if (kept) {
    cache.delete(key);
    kept.el.classList.remove('hidden');
    kept.el.scrollTop = kept.scroll;
    refreshProgress(kept.el);
    current = { key, el: kept.el, cleanup: kept.cleanup, keep: true };
    return;
  }

  const screenEl = el(`<main class="screen screen-${name}"></main>`);
  app.appendChild(screenEl);
  current = { key, el: screenEl, cleanup: null, keep };
  current.cleanup = fn(screenEl, params) || null;
  // Home (and its chips) and search results: pull down to refresh with fresh results.
  if (name === 'home' || (name === 'search' && params.q)) {
    pullToRefresh(screenEl, () => {
      if (isOffline()) { toast("You're offline"); return Promise.resolve(); }
      screenEl.dataset.fresh = '1';
      screenEl.dispatchEvent(new Event('reload'));
      return waitFor(() => !screenEl.querySelector('.skel-card'));
    });
  }
  screenEl.addEventListener('reload', () => {
    if (current.el === screenEl && current.cleanup) current.cleanup();
    const c = fn(screenEl, params) || null;
    if (current.el === screenEl) current.cleanup = c;
  });

  // Keep at most 6 hidden screens.
  while (cache.size > 6) {
    const [k, old] = cache.entries().next().value;
    cache.delete(k);
    if (old.cleanup) old.cleanup();
    old.el.remove();
  }
}

// ---------------------------------------------------------------- bottom nav

const TABS = [
  ['home', 'Home', 'home', '#/'],
  ['shorts', 'Shorts', 'shorts', '#/shorts'],
  ['search', 'Search', 'search', '#/search'],
  ['settings', 'Settings', 'settings', '#/settings'],
];
const TAB_OF = { home: 'home', shorts: 'shorts', search: 'search', settings: 'settings', history: 'settings', downloads: 'settings' };

const nav = el(`<nav class="bottom-nav">${TABS.map(([id, label, ic]) => `<button class="nav-tab" data-tab="${id}">${icon(ic, 24)}<span>${label}</span></button>`).join('')}</nav>`);
document.body.appendChild(nav);
nav.querySelectorAll('.nav-tab').forEach((b) => {
  b.onclick = () => {
    const [id, , , hash] = TABS.find((t) => t[0] === b.dataset.tab);
    const here = TAB_OF[document.body.dataset.screen];
    if (here === id && Watch.mode !== 'full') {
      // Tapping the tab you're on: back to its top (Home also refreshes its position).
      if (current) current.el.scrollTo({ top: 0, behavior: 'smooth' });
      if (location.hash !== hash && id !== 'settings') go(hash);
      return;
    }
    go(hash);
  };
});
function paintNav() {
  const tab = TAB_OF[document.body.dataset.screen];
  nav.querySelectorAll('.nav-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
}

// ---------------------------------------------------------------- back

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-back]');
  if (!b) return;
  e.preventDefault();
  if (history.length > 1) history.back(); else go('#/');
});

// Called by the Flutter shell on Android back. true = handled here.
window.astBack = function () {
  if (sheets.length) { sheets[sheets.length - 1].close(); return true; }
  return false;
};

// Back online on an offline card: try again.
document.addEventListener('net', (e) => {
  if (e.detail.online && current && current.el.querySelector('.offline-card')) current.el.dispatchEvent(new Event('reload'));
});

// ---------------------------------------------------------------- start

const splash = document.getElementById('splash');
splash.innerHTML = logo(44);
setTimeout(() => { splash.classList.add('gone'); setTimeout(() => splash.remove(), 400); }, 900);

window.addEventListener('hashchange', route);
Promise.all([settingsReady, historyReady, netReady]).then(async () => {
  // Starting without internet: go straight to what plays offline (saved Shorts, else Downloads).
  if (isOffline() && (location.hash === '' || location.hash === '#/')) {
    try {
      const s = await api('/api/offline/shorts');
      location.replace(s.items.length ? '#/shorts' : '#/downloads');
    } catch (e) { /* fall through to Home */ }
  }
  route();
});
